import { z } from 'zod'
import { preventRemoteWrites, valtioSync } from '../src/client.js'
import { defineAccount, defineCollection } from '../src/schema.js'
import {
  type StoredRecord,
  type SyncStorage,
  type SyncStorageAdapter,
  createMemoryStorageAdapter,
  createMemorySyncStorage,
  createMemoryWebStorage,
} from '../src/storage.js'

const account = defineAccount({
  fields: {
    theme: z.enum(['light', 'dark']).default('light'),
  },
})

const todos = defineCollection({
  fields: {
    id: z.string(),
    title: z.string().default(''),
  },
})

function storedTodo(id: string, title: string): StoredRecord {
  return {
    id,
    data: { id, title },
    meta: {
      dirty: false,
      deleted: false,
      serverVersion: 1,
      baseServerVersion: 1,
      updatedAtClient: 0,
      updatedByDevice: 'device_1',
      lastSyncedAt: 0,
      touched: [],
    },
  }
}

function adapter(namespace: string, storage: SyncStorage): SyncStorageAdapter {
  return {
    namespace,
    storage,
    localStorage: createMemoryWebStorage(),
    sessionStorage: createMemoryWebStorage(),
    broadcast: false,
  }
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('exposes inert defaults until the required default adapter is hydrated', async () => {
  const defaultAdapter = createMemoryStorageAdapter({
    namespace: 'default',
    account: {
      data: { theme: 'dark' },
      meta: { schemaVersion: 1, lastServerSeq: 4 },
    },
    collections: { todos: [storedTodo('saved', 'Saved')] },
  })
  const sync = valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
    storage: defaultAdapter,
  })
  const coldAccount = sync.account
  const coldTodos = sync.todos

  expect(sync.status.phase).toBe('cold')
  expect(sync.account).toMatchObject({ theme: 'light' })
  expect(sync.todos.list()).toEqual([])
  sync.account.theme = 'dark'
  sync.todos.records.fixture = { id: 'fixture', title: 'Ignored' }
  expect(sync.account).toMatchObject({ theme: 'light' })
  expect(sync.todos.list()).toEqual([])
  expect(() => sync.todos.create({ id: 'too-early' })).toThrow('Await hydrate()')
  await expect(sync.flush()).rejects.toThrow('Call hydrate()')

  await expect(sync.hydrate()).resolves.toBeUndefined()

  expect(sync.status.phase).toBe('ready')
  expect(sync.account).not.toBe(coldAccount)
  expect(sync.todos).not.toBe(coldTodos)
  expect(sync.account).toMatchObject({ theme: 'dark' })
  expect(sync.todos.get('saved')).toMatchObject({ title: 'Saved' })

  coldAccount.theme = 'light'
  coldTodos.records.stale = { id: 'stale', title: 'Ignored' }
  expect(sync.account).toMatchObject({ theme: 'dark' })
  expect(sync.todos.get('stale')).toBeUndefined()

  sync.close()
  expect(sync.status.phase).toBe('closed')
  await expect(sync.hydrate()).rejects.toThrow('Cannot hydrate a closed')
})

test('replaces a development context and returns to the default without leaking fixtures', async () => {
  const defaultStorage = createMemorySyncStorage({
    collections: { todos: [storedTodo('real', 'Real')] },
  })
  const defaultLocalStorage = createMemoryWebStorage()
  const defaultSessionStorage = createMemoryWebStorage()
  defaultLocalStorage.setItem(
    'valtio-sync:real:device',
    JSON.stringify({ deviceId: 'real-device' }),
  )
  defaultSessionStorage.setItem('valtio-sync:real:session', JSON.stringify({ panel: 'real-panel' }))
  const defaultAdapter: SyncStorageAdapter = {
    namespace: 'real',
    storage: defaultStorage,
    localStorage: defaultLocalStorage,
    sessionStorage: defaultSessionStorage,
    broadcast: false,
  }
  const scenarioAdapter = createMemoryStorageAdapter({ namespace: 'scenario' })
  const requests: Array<{ ops: unknown[] }> = []
  const sync = valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
    storage: defaultAdapter,
    device: { deviceId: z.string().default('default-device') },
    session: { panel: z.string().default('default-panel') },
    fetch: async (_input, init) => {
      const request = JSON.parse(String(init?.body))
      requests.push(request)
      return jsonResponse({
        serverSeq: requests.length,
        accepted: [],
        rejected: [],
        changes: {},
      })
    },
  })

  await sync.hydrate()
  const removeWriteProtection = sync.interceptTransport(preventRemoteWrites)
  await expect(sync.hydrate(scenarioAdapter)).resolves.toBeUndefined()
  sync.account.theme = 'dark'
  sync.device.deviceId = 'fixture-device'
  sync.session.panel = 'fixture-panel'
  sync.todos.create({ id: 'fixture', title: 'Fixture' })
  await sync.sync()

  expect(requests).toMatchObject([{ ops: [] }])
  expect(await defaultStorage.readRecord('todos', 'fixture')).toBeNull()
  expect(defaultLocalStorage.getItem('valtio-sync:real:device')).toContain('real-device')

  await sync.hydrate()
  removeWriteProtection()

  expect(sync.account).toMatchObject({ theme: 'light' })
  expect(sync.device).toMatchObject({ deviceId: 'real-device' })
  expect(sync.session).toMatchObject({ panel: 'real-panel' })
  expect(sync.todos.get('real')).toMatchObject({ title: 'Real' })
  expect(sync.todos.get('fixture')).toBeUndefined()
  expect(await scenarioAdapter.storage!.readRecord('todos', 'fixture')).not.toBeNull()
  expect(sync.debug.getPendingOps()).toEqual([])
})

test('makes transitions inert while async operations queue behind a ready client switch', async () => {
  let releaseRequest!: () => void
  const requestStarted = Promise.withResolvers<void>()
  const defaultStorage = createMemorySyncStorage()
  const sync = valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
    storage: adapter('default', defaultStorage),
    fetch: async (_input, init) => {
      const request = JSON.parse(String(init?.body))
      requestStarted.resolve()
      return new Promise<Response>((resolve) => {
        releaseRequest = () =>
          resolve(
            jsonResponse({
              serverSeq: 1,
              accepted: request.ops.map((op: Record<string, unknown>) => ({
                mutationId: op.mutationId,
                collection: op.collection,
                id: op.id,
                serverVersion: 1,
              })),
              rejected: [],
              changes: {},
            }),
          )
      })
    },
  })
  await sync.hydrate()
  sync.todos.create({ id: 'saved', title: 'Saved first' })
  const staleAccount = sync.account
  const staleTodos = sync.todos
  const syncing = sync.sync()
  await requestStarted.promise

  const switching = sync.hydrate(
    createMemoryStorageAdapter({
      namespace: 'next',
      collections: { todos: [storedTodo('next', 'Next')] },
    }),
  )
  expect(sync.status.phase).toBe('hydrating')
  expect(sync.todos.list()).toEqual([])
  expect(() => sync.todos.create({ id: 'blocked' })).toThrow('Await hydrate()')
  sync.account.theme = 'dark'
  staleAccount.theme = 'dark'
  staleTodos.records.stale = { id: 'stale', title: 'Ignored' }
  const queuedFlush = sync.flush()

  releaseRequest()
  await Promise.all([syncing, switching, queuedFlush])

  expect(sync.status.phase).toBe('ready')
  expect(sync.account).toMatchObject({ theme: 'light' })
  expect(sync.todos.get('next')).toMatchObject({ title: 'Next' })
  expect(sync.todos.get('blocked')).toBeUndefined()
  expect(sync.todos.get('stale')).toBeUndefined()
  expect(await defaultStorage.readRecord('todos', 'saved')).toMatchObject({
    meta: { dirty: false },
  })
})

test('preserves the active context after a failed replacement', async () => {
  const defaultAdapter = createMemoryStorageAdapter({
    namespace: 'stable',
    collections: { todos: [storedTodo('stable', 'Stable')] },
  })
  const sync = valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
    storage: defaultAdapter,
  })
  await sync.hydrate()
  const previousAccount = sync.account
  const failingStorage: SyncStorage = {
    ...createMemorySyncStorage(),
    async readAccount() {
      throw new Error('cannot open fixture storage')
    },
  }

  await expect(sync.hydrate(adapter('broken', failingStorage))).rejects.toThrow(
    'cannot open fixture storage',
  )

  expect(sync.status.phase).toBe('ready')
  expect(sync.account).not.toBe(previousAccount)
  expect(sync.todos.get('stable')).toMatchObject({ title: 'Stable' })
})

test('cancels a scheduled retry when replacing the active context', async () => {
  vi.useFakeTimers()
  const fetchSync = vi.fn(async () => {
    throw new Error('offline')
  })
  const sync = valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
    storage: createMemoryStorageAdapter({ namespace: 'retry-default' }),
    fetch: fetchSync,
  })
  await sync.hydrate()
  sync.todos.create({ id: 'pending', title: 'Pending' })
  await sync.sync()

  await sync.hydrate(createMemoryStorageAdapter({ namespace: 'retry-isolated' }))
  await vi.advanceTimersByTimeAsync(60_000)

  expect(fetchSync).toHaveBeenCalledTimes(1)
  expect(sync.todos.get('pending')).toBeUndefined()
})

test('serializes persisted maintenance before replacing its storage', async () => {
  const baseStorage = createMemorySyncStorage({
    collections: { todos: [storedTodo('original', 'Original')] },
  })
  const clearStarted = Promise.withResolvers<void>()
  const allowClear = Promise.withResolvers<void>()
  const delayedStorage: SyncStorage = {
    ...baseStorage,
    async clearAll() {
      clearStarted.resolve()
      await allowClear.promise
      await baseStorage.clearAll()
    },
  }
  const sync = valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
    storage: adapter('maintenance-default', delayedStorage),
  })
  await sync.hydrate()

  const clearing = sync.clearLocalData()
  await clearStarted.promise
  const switching = sync.hydrate(
    createMemoryStorageAdapter({
      namespace: 'maintenance-next',
      collections: { todos: [storedTodo('next', 'Next')] },
    }),
  )
  allowClear.resolve()
  await Promise.all([clearing, switching])

  expect(await baseStorage.listRecords('todos')).toEqual([])
  expect(sync.todos.get('next')).toMatchObject({ title: 'Next' })
})

test('keeps adapters and custom sync storage exclusive to one live client', async () => {
  const sharedStorage = createMemorySyncStorage()
  const sharedAdapter = adapter('shared', sharedStorage)
  const first = valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
    storage: sharedAdapter,
  })

  expect(() =>
    valtioSync({
      endpoint: '/api/sync',
      schema: { account, todos },
      storage: sharedAdapter,
    }),
  ).toThrow('adapter can belong to only one live')
  expect(() =>
    valtioSync({
      endpoint: '/api/sync',
      schema: { account, todos },
      storage: adapter('wrapped-shared', sharedStorage),
    }),
  ).toThrow('Sync storage can belong to only one live')

  first.close()
  const next = valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
    storage: sharedAdapter,
  })
  await expect(next.hydrate()).resolves.toBeUndefined()
})
