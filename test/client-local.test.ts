import { z } from 'zod'
import { valtioSync } from '../src/client.js'
import { ACCOUNT_COLLECTION, defineAccount, defineCollection } from '../src/schema.js'
import {
  type StoredRecord,
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

test('hydrates defaults from an empty local cache', async () => {
  const vs = valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
    device: {
      deviceId: z.string().default('device_1'),
    },
    session: {
      sidebarOpen: z.boolean().default(false),
    },
    storage: createMemorySyncStorage(),
    localStorage: createMemoryWebStorage(),
    sessionStorage: createMemoryWebStorage(),
  })

  await vs.ready

  expect(vs.status.hydrated).toBe(true)
  expect(vs.account).toMatchObject({ theme: 'light' })
  expect(vs.device).toMatchObject({ deviceId: 'device_1' })
  expect(vs.session).toMatchObject({ sidebarOpen: false })
  expect(vs.collections.todos.list()).toEqual([])
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
    endpoint: '/api/sync',
    schemaVersion: 2,
    schema: { account, todos },
    storage,
    localStorage: createMemoryWebStorage(),
    sessionStorage: createMemoryWebStorage(),
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
    },
  })

  await vs.ready

  expect(vs.account).toMatchObject({ theme: 'dark' })
  expect(vs.collections.todos.get('todo_1')).toMatchObject({
    id: 'todo_1',
    title: 'Old migrated',
    completed: false,
  })
  expect((await storage.readAccount())?.meta).toMatchObject({
    schemaVersion: 2,
    lastServerSeq: 5,
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
    endpoint: '/api/sync',
    namespace: 'user_1',
    schema: { account, todos },
    device: {
      deviceId: z.string().default('device_1'),
    },
    storage,
    localStorage,
    sessionStorage: createMemoryWebStorage(),
  })

  await vs.ready
  await vs.clearLocalData()

  expect(await storage.readAccount()).toBeNull()
  expect(await storage.listRecords('todos')).toEqual([])
  expect(localStorage.getItem('valtio-sync:user_1:device')).toBeNull()
  expect(vs.account).toMatchObject({ theme: 'light' })
  expect(vs.device).toMatchObject({ deviceId: 'device_1' })
  expect(vs.collections.todos.list()).toEqual([])
})

test('adopts anonymous local data into a new account and clears source after sync', async () => {
  const sourceStorage = createMemorySyncStorage()
  const targetStorage = createMemorySyncStorage()
  const localStorage = createMemoryWebStorage()
  const sessionStorage = createMemoryWebStorage()
  const syncRequests: unknown[] = []
  const anonymous = valtioSync({
    endpoint: '/api/sync',
    namespace: 'anon_1',
    schema: { account, todos },
    device: {
      deviceId: z.string().default('device_1'),
    },
    session: {
      sidebarOpen: z.boolean().default(false),
    },
    storage: sourceStorage,
    localStorage,
    sessionStorage,
  })
  const signedIn = valtioSync({
    endpoint: '/api/sync',
    namespace: 'user_1',
    schema: { account, todos },
    device: {
      deviceId: z.string().default('device_2'),
    },
    session: {
      sidebarOpen: z.boolean().default(false),
    },
    storage: targetStorage,
    localStorage,
    sessionStorage,
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
  await Promise.all([anonymous.ready, signedIn.ready])

  anonymous.account.theme = 'dark'
  anonymous.device.deviceId = 'anonymous_device'
  anonymous.session.sidebarOpen = true
  anonymous.collections.todos.create({ id: 'todo_1', title: 'Anonymous draft' })

  await signedIn.adoptLocalData(anonymous, {
    sync: true,
    clearSource: 'afterSuccessfulSync',
  })

  expect(signedIn.account).toMatchObject({ theme: 'dark' })
  expect(signedIn.device).toMatchObject({ deviceId: 'anonymous_device' })
  expect(signedIn.session).toMatchObject({ sidebarOpen: true })
  expect(signedIn.collections.todos.get('todo_1')).toMatchObject({
    title: 'Anonymous draft',
  })
  expect(signedIn.status.dirty).toBe(false)
  expect(anonymous.collections.todos.list()).toEqual([])
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
    endpoint: '/api/sync',
    namespace: 'user_1',
    schema: { account, todos },
    storage: createMemorySyncStorage(),
    localStorage: createMemoryWebStorage(),
    sessionStorage: createMemoryWebStorage(),
    fetch: async () => {
      throw new Error('offline')
    },
  })
  const anonymous = valtioSync({
    endpoint: '/api/sync',
    namespace: 'anon_1',
    schema: { account, todos },
    storage: sourceStorage,
    localStorage: createMemoryWebStorage(),
    sessionStorage: createMemoryWebStorage(),
  })
  await Promise.all([anonymous.ready, signedIn.ready])
  anonymous.collections.todos.create({ id: 'todo_1', title: 'Keep me' })

  await expect(
    signedIn.adoptLocalData(anonymous, {
      sync: true,
      clearSource: 'afterSuccessfulSync',
    }),
  ).rejects.toThrow('source local data was not cleared')

  expect(signedIn.status.dirty).toBe(true)
  expect(anonymous.collections.todos.get('todo_1')).toMatchObject({ title: 'Keep me' })
  expect(await sourceStorage.listRecords('todos')).toHaveLength(1)
  signedIn.close()
})

test('rejects anonymous local data adoption into a non-empty target', async () => {
  const anonymous = valtioSync({
    endpoint: '/api/sync',
    namespace: 'anon_1',
    schema: { account, todos },
    storage: createMemorySyncStorage(),
    localStorage: createMemoryWebStorage(),
    sessionStorage: createMemoryWebStorage(),
  })
  const signedIn = valtioSync({
    endpoint: '/api/sync',
    namespace: 'user_1',
    schema: { account, todos },
    storage: createMemorySyncStorage({
      collections: {
        todos: [makeStoredTodo('todo_existing', { id: 'todo_existing', title: 'Existing' })],
      },
    }),
    localStorage: createMemoryWebStorage(),
    sessionStorage: createMemoryWebStorage(),
  })
  await Promise.all([anonymous.ready, signedIn.ready])
  anonymous.collections.todos.create({ id: 'todo_1', title: 'Anonymous draft' })

  await expect(signedIn.adoptLocalData(anonymous)).rejects.toThrow('target with cached records')
  expect(signedIn.collections.todos.get('todo_existing')).toMatchObject({
    title: 'Existing',
  })
})

test('broadcasts local collection changes to another tab', async () => {
  if (typeof BroadcastChannel === 'undefined') {
    return
  }

  const storage = createMemorySyncStorage()
  const firstTab = valtioSync({
    endpoint: '/api/sync',
    namespace: 'user_1',
    schema: { account, todos },
    storage,
    localStorage: createMemoryWebStorage(),
    sessionStorage: createMemoryWebStorage(),
  })
  const secondTab = valtioSync({
    endpoint: '/api/sync',
    namespace: 'user_1',
    schema: { account, todos },
    storage,
    localStorage: createMemoryWebStorage(),
    sessionStorage: createMemoryWebStorage(),
  })
  await Promise.all([firstTab.ready, secondTab.ready])

  firstTab.collections.todos.create({ id: 'todo_1', title: 'From tab one' })
  await firstTab.flush()
  await waitFor(() => secondTab.collections.todos.get('todo_1') !== undefined)

  expect(secondTab.collections.todos.get('todo_1')).toMatchObject({
    title: 'From tab one',
  })

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
