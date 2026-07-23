import { z } from 'zod'
import { preventRemoteWrites, valtioSync } from '../src/client.js'
import { defineAccount, defineCollection } from '../src/schema.js'
import {
  type StoredRecord,
  createMemoryStorageAdapter,
  createMemorySyncStorage,
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

function jsonResponse(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
    ...init,
  })
}

function makeStoredTodo(id: string, title: string): StoredRecord {
  return {
    id,
    data: {
      id,
      title,
      completed: false,
    },
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

test('accepted create applies canonical record and clears dirty state', async () => {
  const fetchSync = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    jsonResponse({
      serverSeq: 10,
      accepted: [
        {
          mutationId: 'placeholder',
          collection: 'todos',
          id: 'todo_1',
          serverVersion: 4,
          record: {
            id: 'todo_1',
            title: 'Canonical',
            completed: false,
          },
        },
      ],
      rejected: [],
      changes: {},
    }),
  )
  const vs = valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
    storage: createMemoryStorageAdapter(),
    fetch: async (input, init) => {
      const request = JSON.parse(String(init?.body))
      const response = await fetchSync(input, init)
      const body = await response.json()
      body.accepted[0].mutationId = request.ops[0].mutationId
      return jsonResponse(body)
    },
  })
  await vs.hydrate({
    namespace: 'accepted-create',
    storage: createMemorySyncStorage(),
    broadcast: false,
  })

  vs.todos.create({ id: 'todo_1', title: 'Local' })
  await vs.sync()

  expect(vs.todos.get('todo_1')).toMatchObject({
    id: 'todo_1',
    title: 'Canonical',
  })
  expect(vs.status.dirty).toBe(false)
  expect(vs.debug.getPendingOps()).toEqual([])
  expect(vs.debug.getRecordMeta(vs.todos, 'todo_1')).toMatchObject({
    dirty: false,
    serverVersion: 4,
  })
})

test('accepted update preserves a newer mutation made while sync is in flight', async () => {
  const storage = createMemorySyncStorage({
    collections: {
      todos: [makeStoredTodo('todo_1', 'Base')],
    },
  })
  const requestStarted = Promise.withResolvers<void>()
  const responseReady = Promise.withResolvers<void>()
  let request!: {
    ops: Array<{ mutationId: string; collection: string; id: string }>
  }
  const vs = valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
    storage: createMemoryStorageAdapter(),
    fetch: async (_input, init) => {
      request = JSON.parse(String(init?.body))
      requestStarted.resolve()
      await responseReady.promise
      return jsonResponse({
        serverSeq: 2,
        accepted: [
          {
            mutationId: request.ops[0].mutationId,
            collection: request.ops[0].collection,
            id: request.ops[0].id,
            serverVersion: 2,
            record: {
              id: 'todo_1',
              title: 'Canonical',
              completed: false,
            },
          },
        ],
        rejected: [],
        changes: {},
      })
    },
  })
  await vs.hydrate({ namespace: 'in-flight-update', storage, broadcast: false })

  vs.todos.update('todo_1', { title: 'Sent' })
  const syncing = vs.sync()
  await requestStarted.promise
  vs.todos.update('todo_1', { completed: true })
  responseReady.resolve()
  await syncing

  expect(vs.todos.get('todo_1')).toEqual({
    id: 'todo_1',
    title: 'Canonical',
    completed: true,
  })
  expect(vs.debug.getPendingOps()).toMatchObject([
    {
      collection: 'todos',
      type: 'update',
      id: 'todo_1',
      patch: { completed: true },
      touched: ['completed'],
      baseServerVersion: 2,
    },
  ])
  expect(vs.debug.getRecordMeta(vs.todos, 'todo_1')).toMatchObject({
    dirty: true,
    serverVersion: 2,
    baseServerVersion: 2,
  })
  expect(await storage.readRecord('todos', 'todo_1')).toMatchObject({
    data: {
      title: 'Canonical',
      completed: true,
    },
    meta: {
      dirty: true,
      serverVersion: 2,
      baseServerVersion: 2,
      touched: ['completed'],
    },
  })
})

test('accepted account update preserves newer account state over a canonical response', async () => {
  const storage = createMemorySyncStorage({
    account: {
      data: { theme: 'light' },
      meta: {
        schemaVersion: 1,
        lastServerSeq: 1,
        sync: {
          dirty: false,
          deleted: false,
          serverVersion: 1,
          baseServerVersion: 1,
          updatedAtClient: 0,
          updatedByDevice: 'device_1',
          lastSyncedAt: 0,
          touched: [],
        },
      },
    },
  })
  const requestStarted = Promise.withResolvers<void>()
  const responseReady = Promise.withResolvers<void>()
  let request!: {
    ops: Array<{ mutationId: string; collection: string; id: string }>
  }
  const vs = valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
    storage: createMemoryStorageAdapter(),
    fetch: async (_input, init) => {
      request = JSON.parse(String(init?.body))
      requestStarted.resolve()
      await responseReady.promise
      return jsonResponse({
        serverSeq: 2,
        accepted: [
          {
            mutationId: request.ops[0].mutationId,
            collection: request.ops[0].collection,
            id: request.ops[0].id,
            serverVersion: 2,
            record: { theme: 'dark' },
          },
        ],
        rejected: [],
        changes: {},
      })
    },
  })
  await vs.hydrate({ namespace: 'in-flight-account', storage, broadcast: false })

  vs.account.theme = 'dark'
  const syncing = vs.sync()
  await requestStarted.promise
  vs.account.theme = 'light'
  responseReady.resolve()
  await syncing

  expect(vs.account).toMatchObject({ theme: 'light' })
  expect(vs.debug.getPendingOps()).toMatchObject([
    {
      collection: 'account',
      type: 'update',
      id: 'singleton',
      patch: { theme: 'light' },
      touched: ['theme'],
      baseServerVersion: 2,
    },
  ])
  expect((await storage.readAccount())?.meta.sync).toMatchObject({
    dirty: true,
    serverVersion: 2,
    baseServerVersion: 2,
    touched: ['theme'],
  })
})

test('accepted create retains a delete made while the create is in flight', async () => {
  const storage = createMemorySyncStorage()
  const requestStarted = Promise.withResolvers<void>()
  const responseReady = Promise.withResolvers<void>()
  let request!: {
    ops: Array<{ mutationId: string; collection: string; id: string }>
  }
  const vs = valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
    storage: createMemoryStorageAdapter(),
    fetch: async (_input, init) => {
      request = JSON.parse(String(init?.body))
      requestStarted.resolve()
      await responseReady.promise
      return jsonResponse({
        serverSeq: 1,
        accepted: [
          {
            mutationId: request.ops[0].mutationId,
            collection: request.ops[0].collection,
            id: request.ops[0].id,
            serverVersion: 1,
          },
        ],
        rejected: [],
        changes: {},
      })
    },
  })
  await vs.hydrate({ namespace: 'in-flight-create-delete', storage, broadcast: false })

  vs.todos.create({ id: 'todo_1', title: 'Transient' })
  const syncing = vs.sync()
  await requestStarted.promise
  vs.todos.delete('todo_1')
  responseReady.resolve()
  await syncing

  expect(vs.todos.get('todo_1')).toBeUndefined()
  expect(vs.debug.getPendingOps()).toMatchObject([
    {
      collection: 'todos',
      type: 'delete',
      id: 'todo_1',
      baseServerVersion: 1,
    },
  ])
  expect(await storage.readRecord('todos', 'todo_1')).toMatchObject({
    meta: {
      dirty: true,
      deleted: true,
      serverVersion: 1,
      baseServerVersion: 1,
    },
  })
})

test('overlapping sync calls share one transport attempt', async () => {
  const responseReady = Promise.withResolvers<void>()
  const fetchSync = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body))
    await responseReady.promise
    return jsonResponse({
      serverSeq: 1,
      accepted: request.ops.map((op: Record<string, unknown>) => ({
        mutationId: op.mutationId,
        collection: op.collection,
        id: op.id,
        serverVersion: 1,
      })),
      rejected: [],
      changes: {},
    })
  })
  const vs = valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
    storage: createMemoryStorageAdapter({ namespace: 'overlapping-sync' }),
    fetch: fetchSync,
  })
  await vs.hydrate()
  vs.todos.create({ id: 'todo_1', title: 'Local' })

  const first = vs.sync()
  const second = vs.sync()
  await vi.waitFor(() => expect(fetchSync).toHaveBeenCalledTimes(1))
  responseReady.resolve()
  await Promise.all([first, second])

  expect(fetchSync).toHaveBeenCalledTimes(1)
  expect(vs.status.dirty).toBe(false)
})

test('rejected validation keeps optimistic value and stops retrying', async () => {
  const fetchSync = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body))
    return jsonResponse({
      serverSeq: 1,
      accepted: [],
      rejected: [
        {
          mutationId: request.ops[0].mutationId,
          collection: 'todos',
          id: 'todo_1',
          reason: 'validation',
          message: 'Title is too long',
        },
      ],
      changes: {},
    })
  })
  const vs = valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
    storage: createMemoryStorageAdapter(),
    fetch: fetchSync,
  })
  await vs.hydrate({
    namespace: 'rejected-validation',
    storage: createMemorySyncStorage(),
    broadcast: false,
  })

  vs.todos.create({ id: 'todo_1', title: 'Optimistic' })
  await vs.sync()

  expect(vs.todos.get('todo_1')).toMatchObject({ title: 'Optimistic' })
  expect(vs.status.dirty).toBe(false)
  expect(vs.status.lastError).toMatchObject({
    reason: 'validation',
    message: 'Title is too long',
  })
  expect(vs.debug.getPendingOps()).toEqual([])
})

test('rejected conflict keeps optimistic value and records conflict metadata', async () => {
  const fetchSync = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body))
    return jsonResponse({
      serverSeq: 2,
      accepted: [],
      rejected: [
        {
          mutationId: request.ops[0].mutationId,
          collection: 'todos',
          id: 'todo_1',
          reason: 'conflict',
          message: 'Base version is stale',
          serverVersion: 2,
          serverRecord: {
            id: 'todo_1',
            title: 'Remote',
            completed: false,
          },
        },
      ],
      changes: {},
    })
  })
  const vs = valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
    storage: createMemoryStorageAdapter(),
    fetch: fetchSync,
  })
  await vs.hydrate({
    namespace: 'rejected-conflict',
    storage: createMemorySyncStorage({
      collections: {
        todos: [makeStoredTodo('todo_1', 'Base')],
      },
    }),
    broadcast: false,
  })

  vs.todos.update('todo_1', { title: 'Local' })
  await vs.sync()

  expect(vs.todos.get('todo_1')).toMatchObject({ title: 'Local' })
  expect(vs.status.dirty).toBe(false)
  expect(vs.status.lastError).toMatchObject({
    reason: 'conflict',
    message: 'Base version is stale',
  })
  expect(vs.debug.getRecordMeta(vs.todos, 'todo_1')).toMatchObject({
    dirty: false,
    lastError: {
      reason: 'conflict',
    },
  })
})

test('network failure preserves dirty record for a later retry', async () => {
  const vs = valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
    storage: createMemoryStorageAdapter(),
    fetch: async () => {
      throw new Error('offline')
    },
  })
  await vs.hydrate({
    namespace: 'network-failure',
    storage: createMemorySyncStorage(),
    broadcast: false,
  })

  vs.todos.create({ id: 'todo_1', title: 'Local' })
  await vs.sync()

  expect(vs.status.dirty).toBe(true)
  expect(vs.status.lastError).toMatchObject({ reason: 'network' })
  expect(vs.debug.getPendingOps()).toMatchObject([
    {
      collection: 'todos',
      type: 'create',
      id: 'todo_1',
    },
  ])
  vs.close()
})

test('auth transport failures remain paused without automatic retry', async () => {
  vi.useFakeTimers()
  const fetchSync = vi.fn(async () => new Response('Sign in again', { status: 401 }))
  const vs = valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
    storage: createMemoryStorageAdapter(),
    fetch: fetchSync,
  })
  await vs.hydrate({
    namespace: 'auth-failure',
    storage: createMemorySyncStorage(),
    broadcast: false,
  })

  vs.todos.create({ id: 'todo_1', title: 'Local' })
  await vs.sync()
  await vi.advanceTimersByTimeAsync(60_000)

  expect(fetchSync).toHaveBeenCalledTimes(1)
  expect(vs.status.dirty).toBe(true)
  expect(vs.status.lastError).toMatchObject({
    reason: 'auth',
    message: 'Sign in again',
  })
})

test('transport interceptor drops a scheduled retry without clearing pending writes', async () => {
  vi.useFakeTimers()
  let failSync = true
  const fetchSync = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (failSync) {
      throw new Error('offline')
    }
    const request = JSON.parse(String(init?.body))
    return jsonResponse({
      serverSeq: 1,
      accepted: request.ops.map((op: Record<string, unknown>) => ({
        mutationId: op.mutationId,
        collection: op.collection,
        id: op.id,
        serverVersion: 1,
      })),
      rejected: [],
      changes: {},
    })
  })
  const vs = valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
    storage: createMemoryStorageAdapter(),
    fetch: fetchSync,
  })
  await vs.hydrate({
    namespace: 'intercept-retry',
    storage: createMemorySyncStorage(),
    broadcast: false,
  })

  vs.todos.create({ id: 'todo_1', title: 'Local' })
  await vs.sync()
  expect(fetchSync).toHaveBeenCalledTimes(1)

  const removeInterceptor = vs.interceptTransport(() => null)
  await vi.advanceTimersByTimeAsync(60_000)

  expect(fetchSync).toHaveBeenCalledTimes(1)
  expect(vs.status.dirty).toBe(true)
  expect(vs.debug.getPendingOps()).toMatchObject([
    { collection: 'todos', type: 'create', id: 'todo_1' },
  ])

  removeInterceptor()
  removeInterceptor()
  failSync = false
  await vs.sync()
  expect(fetchSync).toHaveBeenCalledTimes(2)
  expect(vs.status.dirty).toBe(false)
})

test('transport interceptor can replace a sync response without calling fetch', async () => {
  const fetchSync = vi.fn()
  const vs = valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
    storage: createMemoryStorageAdapter(),
    fetch: fetchSync,
  })
  await vs.hydrate({
    namespace: 'intercept-response',
    storage: createMemorySyncStorage(),
    broadcast: false,
  })

  vs.interceptTransport(() => ({
    serverSeq: 3,
    accepted: [],
    rejected: [],
    changes: {
      todos: {
        upserted: [
          {
            id: 'todo_fixture',
            serverVersion: 3,
            record: {
              id: 'todo_fixture',
              title: 'Fixture response',
              completed: false,
            },
          },
        ],
        deleted: [],
      },
    },
  }))

  await vs.sync()

  expect(fetchSync).not.toHaveBeenCalled()
  expect(vs.todos.get('todo_fixture')).toMatchObject({ title: 'Fixture response' })
  expect(vs.debug.getLastSyncResponse()).toMatchObject({ serverSeq: 3 })
})

test('transport interceptor can omit writes while passing remote reads through', async () => {
  const requests: Array<{ ops: unknown[] }> = []
  const vs = valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
    storage: createMemoryStorageAdapter(),
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return jsonResponse({
        serverSeq: 4,
        accepted: [],
        rejected: [],
        changes: {
          todos: {
            upserted: [
              {
                id: 'todo_remote',
                serverVersion: 4,
                record: {
                  id: 'todo_remote',
                  title: 'Remote read',
                  completed: true,
                },
              },
            ],
            deleted: [],
          },
        },
      })
    },
  })
  await vs.hydrate({
    namespace: 'prevent-writes',
    storage: createMemorySyncStorage(),
    broadcast: false,
  })

  vs.todos.create({ id: 'todo_local', title: 'Keep pending' })
  vs.interceptTransport(preventRemoteWrites)
  await vs.sync()

  expect(requests).toMatchObject([{ ops: [] }])
  expect(vs.todos.get('todo_remote')).toMatchObject({ title: 'Remote read' })
  expect(vs.status.dirty).toBe(true)
  expect(vs.debug.getPendingOps()).toMatchObject([
    { collection: 'todos', type: 'create', id: 'todo_local' },
  ])
})

test('remote changes apply to clean records', async () => {
  const vs = valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
    storage: createMemoryStorageAdapter(),
    fetch: async () =>
      jsonResponse({
        serverSeq: 2,
        accepted: [],
        rejected: [],
        changes: {
          todos: {
            upserted: [
              {
                id: 'todo_1',
                serverVersion: 2,
                record: {
                  id: 'todo_1',
                  title: 'Remote',
                  completed: true,
                },
              },
            ],
            deleted: [],
          },
        },
      }),
  })
  await vs.hydrate({
    namespace: 'remote-clean',
    storage: createMemorySyncStorage(),
    broadcast: false,
  })

  await vs.sync()

  expect(vs.todos.get('todo_1')).toMatchObject({
    title: 'Remote',
    completed: true,
  })
  expect(vs.status.dirty).toBe(false)
})

test('snapshot changes remove absent clean records and preserve dirty records', async () => {
  const storage = createMemorySyncStorage({
    collections: {
      todos: [makeStoredTodo('todo_stale', 'Stale'), makeStoredTodo('todo_dirty', 'Base')],
    },
  })
  const vs = valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
    storage: createMemoryStorageAdapter(),
    fetch: async () =>
      jsonResponse({
        serverSeq: 5,
        accepted: [],
        rejected: [],
        changes: {
          todos: {
            mode: 'snapshot',
            upserted: [
              {
                id: 'todo_remote',
                serverVersion: 5,
                record: {
                  id: 'todo_remote',
                  title: 'Remote',
                  completed: true,
                },
              },
            ],
            deleted: [],
          },
        },
      }),
  })
  await vs.hydrate({ namespace: 'snapshot', storage, broadcast: false })

  vs.todos.update('todo_dirty', { title: 'Local' })
  await vs.sync()

  expect(vs.todos.get('todo_stale')).toBeUndefined()
  expect(vs.todos.get('todo_remote')).toMatchObject({
    title: 'Remote',
    completed: true,
  })
  expect(vs.todos.get('todo_dirty')).toMatchObject({ title: 'Local' })
  expect(await storage.readRecord('todos', 'todo_stale')).toBeNull()
  expect(vs.status.dirty).toBe(true)
})

test('remote changes conflict with dirty records under rejectStale', async () => {
  const storage = createMemorySyncStorage({
    collections: {
      todos: [makeStoredTodo('todo_1', 'Base')],
    },
  })
  const vs = valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
    storage: createMemoryStorageAdapter(),
    fetch: async () =>
      jsonResponse({
        serverSeq: 3,
        accepted: [],
        rejected: [],
        changes: {
          todos: {
            upserted: [
              {
                id: 'todo_1',
                serverVersion: 3,
                record: {
                  id: 'todo_1',
                  title: 'Remote',
                  completed: false,
                },
              },
            ],
            deleted: [],
          },
        },
      }),
  })
  await vs.hydrate({ namespace: 'remote-conflict', storage, broadcast: false })

  vs.todos.update('todo_1', { title: 'Local' })
  await vs.sync()

  expect(vs.todos.get('todo_1')).toMatchObject({ title: 'Local' })
  expect(vs.status.dirty).toBe(false)
  expect(vs.status.lastError).toMatchObject({ reason: 'conflict' })
  expect(vs.debug.getRecordMeta(vs.todos, 'todo_1')).toMatchObject({
    dirty: false,
    lastError: {
      reason: 'conflict',
    },
  })
})
