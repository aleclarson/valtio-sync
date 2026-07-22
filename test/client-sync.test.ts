import { z } from 'zod'
import { valtioSync } from '../src/client.js'
import { defineAccount, defineCollection } from '../src/schema.js'
import { type StoredRecord, createMemorySyncStorage } from '../src/storage.js'

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
    storage: createMemorySyncStorage(),
    fetch: async (input, init) => {
      const request = JSON.parse(String(init?.body))
      const response = await fetchSync(input, init)
      const body = await response.json()
      body.accepted[0].mutationId = request.ops[0].mutationId
      return jsonResponse(body)
    },
  })
  await vs.ready

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
    storage: createMemorySyncStorage(),
    fetch: fetchSync,
  })
  await vs.ready

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
    storage: createMemorySyncStorage({
      collections: {
        todos: [makeStoredTodo('todo_1', 'Base')],
      },
    }),
    fetch: fetchSync,
  })
  await vs.ready

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
    storage: createMemorySyncStorage(),
    fetch: async () => {
      throw new Error('offline')
    },
  })
  await vs.ready

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
    storage: createMemorySyncStorage(),
    fetch: fetchSync,
  })
  await vs.ready

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
    storage: createMemorySyncStorage(),
    fetch: fetchSync,
  })
  await vs.ready

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
    storage: createMemorySyncStorage(),
    fetch: fetchSync,
  })
  await vs.ready

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
    storage: createMemorySyncStorage(),
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
  await vs.ready

  vs.todos.create({ id: 'todo_local', title: 'Keep pending' })
  vs.interceptTransport((request, next) => next({ ...request, ops: [] }))
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
    storage: createMemorySyncStorage(),
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
  await vs.ready

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
    storage,
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
  await vs.ready

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
    storage,
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
  await vs.ready

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
