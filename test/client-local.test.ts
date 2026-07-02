import { z } from 'zod'
import { valtioSync } from '../src/client.js'
import { defineAccount, defineCollection } from '../src/schema.js'
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
