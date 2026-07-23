import { z } from 'zod'
import { valtioSync } from '../src/client.js'
import {
  ACCOUNT_COLLECTION,
  defineAccount,
  defineCollection,
  type SyncSchema,
} from '../src/schema.js'
import {
  type StoredRecord,
  type SyncStorage,
  type SyncStorageAdapter,
  type WebStorageLike,
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
    completed: z.boolean().default(false),
  },
})

function makeStoredTodo(
  id: string,
  data: { id: string; title?: string; completed?: boolean },
): StoredRecord {
  return {
    id,
    data,
    meta: {
      dirty: false,
      deleted: false,
      serverVersion: 1,
      baseServerVersion: 1,
      updatedAtClient: 0,
      updatedByDevice: 'device_1',
      lastSyncedAt: 0,
    },
  }
}

function jsonResponse(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
    ...init,
  })
}

function memoryAdapter(
  namespace: string,
  storage: SyncStorage = createMemorySyncStorage(),
  localStorage: WebStorageLike = createMemoryWebStorage(),
  sessionStorage: WebStorageLike = createMemoryWebStorage(),
  broadcast = false,
): SyncStorageAdapter {
  return { namespace, storage, localStorage, sessionStorage, broadcast }
}

test('hydrates defaults from an empty local cache', async () => {
  const vs = valtioSync({
    storage: createMemoryStorageAdapter(),
    endpoint: '/api/sync',
    schema: { account, todos },
    device: {
      deviceId: z.string().default('device_1'),
    },
    session: {
      sidebarOpen: z.boolean().default(false),
    },
  })

  await vs.hydrate(memoryAdapter('defaults'))

  expect(vs.status.phase).toBe('ready')
  expect(vs.account).toMatchObject({ theme: 'light' })
  expect(vs.device).toMatchObject({ deviceId: 'device_1' })
  expect(vs.session).toMatchObject({ sidebarOpen: false })
  expect(vs.todos.list()).toEqual([])
})

test('account, collection, device, and session mutations survive a new client hydration', async () => {
  const storage = createMemorySyncStorage()
  const localStorage = createMemoryWebStorage()
  const sessionStorage = createMemoryWebStorage()
  const storageAdapter = memoryAdapter(
    'durable-state',
    storage,
    localStorage,
    sessionStorage,
  )
  const options = {
    storage: storageAdapter,
    endpoint: '/api/sync',
    schema: { account, todos },
    device: {
      deviceId: z.string().default('device_1'),
    },
    session: {
      sidebarOpen: z.boolean().default(false),
    },
  }
  const first = valtioSync(options)
  await first.hydrate()

  first.account.theme = 'dark'
  first.device.deviceId = 'device_2'
  first.session.sidebarOpen = true
  first.todos.create({ id: 'todo_1', title: 'Persisted' })
  await first.flush()
  first.close()

  const second = valtioSync(options)
  await second.hydrate()

  expect(second.account).toMatchObject({ theme: 'dark' })
  expect(second.device).toMatchObject({ deviceId: 'device_2' })
  expect(second.session).toMatchObject({ sidebarOpen: true })
  expect(second.todos.get('todo_1')).toMatchObject({ title: 'Persisted' })
  expect(second.debug.getPendingOps()).toMatchObject([
    { collection: 'account', type: 'update', patch: { theme: 'dark' } },
    { collection: 'todos', type: 'create', id: 'todo_1' },
  ])
})

test('rejects collection names reserved by the client API', () => {
  expect(() =>
    valtioSync({
      storage: createMemoryStorageAdapter(),
      endpoint: '/api/sync',
      schema: { account, sync: todos } as SyncSchema,
    }),
  ).toThrow('Collection name is reserved by the client API: sync')
})

test('hydrates cached records after local migrations', async () => {
  const storage = createMemorySyncStorage({
    account: {
      data: { theme: 'dark' },
      meta: {
        schemaVersion: 1,
        lastServerSeq: 5,
      },
    },
    collections: {
      todos: [makeStoredTodo('todo_1', { id: 'todo_1', title: 'Old' })],
    },
  })

  const vs = valtioSync({
    storage: createMemoryStorageAdapter(),
    endpoint: '/api/sync',
    schemaVersion: 3,
    schema: { account, todos },
    migrations: {
      2: (state) => ({
        ...state,
        collections: {
          ...state.collections,
          todos: state.collections.todos.map((record) => ({
            ...record,
            data: {
              ...record.data,
              title: `${record.data.title} migrated`,
            },
          })),
        },
      }),
      3: (state) => ({
        ...state,
        collections: {
          ...state.collections,
          todos: state.collections.todos.map((record) => ({
            ...record,
            data: {
              ...record.data,
              completed: true,
            },
          })),
        },
      }),
    },
  })

  await vs.hydrate(memoryAdapter('migrations', storage))

  expect(vs.account).toMatchObject({ theme: 'dark' })
  expect(vs.todos.get('todo_1')).toMatchObject({
    id: 'todo_1',
    title: 'Old migrated',
    completed: true,
  })
  expect((await storage.readAccount())?.meta).toMatchObject({
    schemaVersion: 3,
    lastServerSeq: 5,
  })
})

test('fails migration safely when an ordered version step is missing', async () => {
  const storage = createMemorySyncStorage({
    account: {
      data: { theme: 'dark' },
      meta: {
        schemaVersion: 1,
        lastServerSeq: 5,
      },
    },
  })
  const vs = valtioSync({
    storage: memoryAdapter('missing-migration', storage),
    endpoint: '/api/sync',
    schemaVersion: 3,
    schema: { account, todos },
    migrations: {
      3: (state) => state,
    },
  })

  await expect(vs.hydrate()).rejects.toThrow(
    'Missing valtio-sync migration for schema version 2',
  )
  expect(vs.status.phase).toBe('cold')
  expect(await storage.readAccount()).toEqual({
    data: { theme: 'dark' },
    meta: {
      schemaVersion: 1,
      lastServerSeq: 5,
    },
  })
})

test('falls back from invalid cached data and reports validation errors', async () => {
  const storage = createMemorySyncStorage({
    account: {
      data: { theme: 'invalid' },
      meta: {
        schemaVersion: 1,
        lastServerSeq: null,
      },
    },
    collections: {
      todos: [
        makeStoredTodo('todo_invalid', {
          id: 'todo_invalid',
          title: 'Invalid',
          completed: 'not-a-boolean' as unknown as boolean,
        }),
      ],
    },
  })
  const localStorage = createMemoryWebStorage()
  const sessionStorage = createMemoryWebStorage()
  localStorage.setItem('valtio-sync:invalid-cache:device', '{invalid json')
  sessionStorage.setItem(
    'valtio-sync:invalid-cache:session',
    JSON.stringify({ sidebarOpen: 'yes' }),
  )
  const vs = valtioSync({
    storage: memoryAdapter(
      'invalid-cache',
      storage,
      localStorage,
      sessionStorage,
    ),
    endpoint: '/api/sync',
    schema: { account, todos },
    device: {
      deviceId: z.string().default('device_1'),
    },
    session: {
      sidebarOpen: z.boolean().default(false),
    },
  })

  await vs.hydrate()

  expect(vs.account).toMatchObject({ theme: 'light' })
  expect(vs.device).toMatchObject({ deviceId: 'device_1' })
  expect(vs.session).toMatchObject({ sidebarOpen: false })
  expect(vs.todos.list()).toEqual([])
  expect(vs.status.lastError).toMatchObject({ reason: 'validation' })
})

test('reports local storage write failures without clearing pending mutations', async () => {
  const baseStorage = createMemorySyncStorage()
  const storage: SyncStorage = {
    ...baseStorage,
    async writeRecord() {
      throw new Error('disk unavailable')
    },
  }
  const vs = valtioSync({
    storage: memoryAdapter('write-failure', storage),
    endpoint: '/api/sync',
    schema: { account, todos },
  })
  await vs.hydrate()

  vs.todos.create({ id: 'todo_1', title: 'Pending' })
  await vs.flush()

  expect(vs.todos.get('todo_1')).toMatchObject({ title: 'Pending' })
  expect(await baseStorage.readRecord('todos', 'todo_1')).toBeNull()
  expect(vs.debug.getPendingOps()).toMatchObject([
    { collection: 'todos', type: 'create', id: 'todo_1' },
  ])
  expect(vs.status.lastError).toMatchObject({
    reason: 'server_error',
    message: 'disk unavailable',
  })
})

test('clears persisted local data and resets proxies', async () => {
  const storage = createMemorySyncStorage({
    account: {
      data: { theme: 'dark' },
      meta: {
        schemaVersion: 1,
        lastServerSeq: 1,
      },
    },
    collections: {
      todos: [makeStoredTodo('todo_1', { id: 'todo_1', title: 'Cached' })],
    },
  })
  const localStorage = createMemoryWebStorage()
  localStorage.setItem('valtio-sync:user_1:device', JSON.stringify({ deviceId: 'device_2' }))

  const vs = valtioSync({
    storage: createMemoryStorageAdapter(),
    endpoint: '/api/sync',
    schema: { account, todos },
    device: {
      deviceId: z.string().default('device_1'),
    },
  })

  await vs.hydrate(memoryAdapter('user_1', storage, localStorage))
  await vs.clearLocalData()

  expect(await storage.readAccount()).toBeNull()
  expect(await storage.listRecords('todos')).toEqual([])
  expect(localStorage.getItem('valtio-sync:user_1:device')).toBeNull()
  expect(vs.account).toMatchObject({ theme: 'light' })
  expect(vs.device).toMatchObject({ deviceId: 'device_1' })
  expect(vs.todos.list()).toEqual([])
})

test('clears one collection locally without creating remote delete state', async () => {
  const storage = createMemorySyncStorage({
    collections: {
      todos: [makeStoredTodo('todo_1', { id: 'todo_1', title: 'Cached' })],
    },
  })
  const storageAdapter = memoryAdapter('clear-collection', storage)
  const vs = valtioSync({
    storage: storageAdapter,
    endpoint: '/api/sync',
    schema: { account, todos },
  })
  await vs.hydrate()

  await vs.clearCollection(vs.todos)
  await vs.flush()

  expect(vs.todos.list()).toEqual([])
  expect(await storage.listRecords('todos')).toEqual([])
  expect(vs.debug.getPendingOps()).toEqual([])
  expect(vs.status.dirty).toBe(false)

  await vs.hydrate()

  expect(vs.todos.list()).toEqual([])
  expect(await storage.listRecords('todos')).toEqual([])
  expect(vs.debug.getPendingOps()).toEqual([])
  expect(vs.status.dirty).toBe(false)
})

test('reset clears every local state tier across hydration', async () => {
  const storageAdapter = createMemoryStorageAdapter({
    namespace: 'reset-all',
    account: {
      data: { theme: 'dark' },
      meta: { schemaVersion: 1, lastServerSeq: 4 },
    },
    collections: {
      todos: [makeStoredTodo('todo_1', { id: 'todo_1', title: 'Cached' })],
    },
    device: { deviceId: 'device_2' },
    session: { sidebarOpen: true },
  })
  const vs = valtioSync({
    storage: storageAdapter,
    endpoint: '/api/sync',
    schema: { account, todos },
    device: {
      deviceId: z.string().default('device_1'),
    },
    session: {
      sidebarOpen: z.boolean().default(false),
    },
  })
  await vs.hydrate()

  await vs.reset()

  expect(vs.account).toMatchObject({ theme: 'light' })
  expect(vs.device).toMatchObject({ deviceId: 'device_1' })
  expect(vs.session).toMatchObject({ sidebarOpen: false })
  expect(vs.todos.list()).toEqual([])
  expect(vs.debug.getPendingOps()).toEqual([])

  await vs.hydrate()

  expect(vs.account).toMatchObject({ theme: 'light' })
  expect(vs.device).toMatchObject({ deviceId: 'device_1' })
  expect(vs.session).toMatchObject({ sidebarOpen: false })
  expect(vs.todos.list()).toEqual([])
  expect(vs.debug.getPendingOps()).toEqual([])
})

test('adopts anonymous local data into a new account and clears source after sync', async () => {
  const sourceStorage = createMemorySyncStorage()
  const targetStorage = createMemorySyncStorage()
  const localStorage = createMemoryWebStorage()
  const sessionStorage = createMemoryWebStorage()
  const syncRequests: unknown[] = []
  const anonymous = valtioSync({
    storage: createMemoryStorageAdapter(),
    endpoint: '/api/sync',
    schema: { account, todos },
    device: {
      deviceId: z.string().default('device_1'),
    },
    session: {
      sidebarOpen: z.boolean().default(false),
    },
  })
  const signedIn = valtioSync({
    storage: createMemoryStorageAdapter(),
    endpoint: '/api/sync',
    schema: { account, todos },
    device: {
      deviceId: z.string().default('device_2'),
    },
    session: {
      sidebarOpen: z.boolean().default(false),
    },
    fetch: async (_input, init) => {
      const request = JSON.parse(String(init?.body))
      syncRequests.push(request)
      return jsonResponse({
        serverSeq: 12,
        accepted: request.ops.map(
          (op: { mutationId: string; collection: string; id: string }, index: number) => ({
            mutationId: op.mutationId,
            collection: op.collection,
            id: op.id,
            serverVersion: index + 1,
          }),
        ),
        rejected: [],
        changes: {},
      })
    },
  })
  await Promise.all([
    anonymous.hydrate(memoryAdapter('anon_1', sourceStorage, localStorage, sessionStorage)),
    signedIn.hydrate(memoryAdapter('user_1', targetStorage, localStorage, sessionStorage)),
  ])

  anonymous.account.theme = 'dark'
  anonymous.device.deviceId = 'anonymous_device'
  anonymous.session.sidebarOpen = true
  anonymous.todos.create({ id: 'todo_1', title: 'Anonymous draft' })

  await signedIn.adoptLocalData(anonymous, {
    sync: true,
    clearSource: 'afterSuccessfulSync',
  })

  expect(signedIn.account).toMatchObject({ theme: 'dark' })
  expect(signedIn.device).toMatchObject({ deviceId: 'anonymous_device' })
  expect(signedIn.session).toMatchObject({ sidebarOpen: true })
  expect(signedIn.todos.get('todo_1')).toMatchObject({
    title: 'Anonymous draft',
  })
  expect(signedIn.status.dirty).toBe(false)
  expect(anonymous.todos.list()).toEqual([])
  expect(await sourceStorage.listRecords('todos')).toEqual([])
  expect(syncRequests).toHaveLength(1)
  expect(syncRequests[0]).toMatchObject({
    lastServerSeq: null,
    ops: [
      {
        collection: ACCOUNT_COLLECTION,
        type: 'update',
        id: 'singleton',
        patch: {
          theme: 'dark',
        },
        baseServerVersion: null,
      },
      {
        collection: 'todos',
        type: 'create',
        id: 'todo_1',
        value: {
          id: 'todo_1',
          title: 'Anonymous draft',
        },
      },
    ],
  })
})

test('keeps anonymous source data when promoted sync fails', async () => {
  const sourceStorage = createMemorySyncStorage()
  const signedIn = valtioSync({
    storage: createMemoryStorageAdapter(),
    endpoint: '/api/sync',
    schema: { account, todos },
    fetch: async () => {
      throw new Error('offline')
    },
  })
  const anonymous = valtioSync({
    storage: createMemoryStorageAdapter(),
    endpoint: '/api/sync',
    schema: { account, todos },
  })
  await Promise.all([
    anonymous.hydrate(memoryAdapter('anon_1', sourceStorage)),
    signedIn.hydrate(memoryAdapter('user_1')),
  ])
  anonymous.todos.create({ id: 'todo_1', title: 'Keep me' })

  await expect(
    signedIn.adoptLocalData(anonymous, {
      sync: true,
      clearSource: 'afterSuccessfulSync',
    }),
  ).rejects.toThrow('source local data was not cleared')

  expect(signedIn.status.dirty).toBe(true)
  expect(anonymous.todos.get('todo_1')).toMatchObject({ title: 'Keep me' })
  expect(await sourceStorage.listRecords('todos')).toHaveLength(1)
  signedIn.close()
})

test('rejects anonymous local data adoption into a non-empty target', async () => {
  const anonymous = valtioSync({
    storage: createMemoryStorageAdapter(),
    endpoint: '/api/sync',
    schema: { account, todos },
  })
  const signedIn = valtioSync({
    storage: createMemoryStorageAdapter(),
    endpoint: '/api/sync',
    schema: { account, todos },
  })
  await Promise.all([
    anonymous.hydrate(memoryAdapter('anon_1')),
    signedIn.hydrate(
      memoryAdapter(
        'user_1',
        createMemorySyncStorage({
          collections: {
            todos: [
              makeStoredTodo('todo_existing', {
                id: 'todo_existing',
                title: 'Existing',
              }),
            ],
          },
        }),
      ),
    ),
  ])
  anonymous.todos.create({ id: 'todo_1', title: 'Anonymous draft' })

  await expect(signedIn.adoptLocalData(anonymous)).rejects.toThrow('target with cached records')
  expect(signedIn.todos.get('todo_existing')).toMatchObject({
    title: 'Existing',
  })
})

test('two tabs preserve independent mutations in the same collection', async () => {
  if (typeof BroadcastChannel === 'undefined') {
    return
  }

  const storage = createMemorySyncStorage()
  const firstStorage: SyncStorage = { ...storage }
  const secondStorage: SyncStorage = { ...storage }
  const firstTab = valtioSync({
    storage: createMemoryStorageAdapter(),
    endpoint: '/api/sync',
    schema: { account, todos },
  })
  const secondTab = valtioSync({
    storage: createMemoryStorageAdapter(),
    endpoint: '/api/sync',
    schema: { account, todos },
  })
  await Promise.all([
    firstTab.hydrate(memoryAdapter('user_1', firstStorage, undefined, undefined, true)),
    secondTab.hydrate(memoryAdapter('user_1', secondStorage, undefined, undefined, true)),
  ])

  firstTab.todos.create({ id: 'todo_1', title: 'From tab one' })
  secondTab.todos.create({ id: 'todo_2', title: 'From tab two' })
  await Promise.all([firstTab.flush(), secondTab.flush()])
  await waitFor(
    () =>
      firstTab.todos.get('todo_2') !== undefined &&
      secondTab.todos.get('todo_1') !== undefined,
  )

  expect(firstTab.todos.get('todo_2')).toMatchObject({
    title: 'From tab two',
  })
  expect(secondTab.todos.get('todo_1')).toMatchObject({
    title: 'From tab one',
  })
  expect((await storage.listRecords('todos')).map((record) => record.id).sort()).toEqual([
    'todo_1',
    'todo_2',
  ])

  firstTab.close()
  secondTab.close()
})

async function waitFor(assertion: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (assertion()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
