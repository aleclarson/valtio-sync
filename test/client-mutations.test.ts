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

const clients: Array<{ close(): void }> = []

function trackClient<T extends { close(): void }>(client: T): T {
  clients.push(client)
  return client
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
      serverVersion: 3,
      baseServerVersion: 3,
      updatedAtClient: 0,
      updatedByDevice: 'device_1',
      lastSyncedAt: 0,
      touched: [],
    },
  }
}

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.close()
  }
  vi.useRealTimers()
})

test('create then delete before flush sends no op', async () => {
  vi.useFakeTimers()
  const vs = trackClient(
    valtioSync({
      endpoint: '/api/sync',
      schema: { account, todos },
      storage: createMemorySyncStorage(),
    }),
  )
  await vs.ready

  vs.todos.create({ id: 'todo_1', title: 'Draft' })
  vs.todos.delete('todo_1')
  await vi.advanceTimersByTimeAsync(100)
  await vs.flush()

  expect(vs.debug.getPendingOps()).toEqual([])
  expect(vs.status.dirty).toBe(false)
  expect(vs.todos.list()).toEqual([])
})

test('update then update compacts to one final patch', async () => {
  vi.useFakeTimers()
  const vs = trackClient(
    valtioSync({
      endpoint: '/api/sync',
      schema: { account, todos },
      storage: createMemorySyncStorage({
        collections: {
          todos: [makeStoredTodo('todo_1', 'Old')],
        },
      }),
    }),
  )
  await vs.ready

  vs.todos.update('todo_1', { title: 'New' })
  vs.todos.update('todo_1', { completed: true })
  await vi.advanceTimersByTimeAsync(100)
  await vs.flush()

  expect(vs.debug.getPendingOps()).toMatchObject([
    {
      collection: 'todos',
      type: 'update',
      id: 'todo_1',
      patch: {
        title: 'New',
        completed: true,
      },
      touched: ['title', 'completed'],
      baseServerVersion: 3,
    },
  ])
})

test('create omits untouched defaults but includes explicitly touched defaults', async () => {
  const vs = trackClient(
    valtioSync({
      endpoint: '/api/sync',
      schema: { account, todos },
      storage: createMemorySyncStorage(),
    }),
  )
  await vs.ready

  vs.todos.create({ id: 'todo_1', title: 'Implicit default' })
  vs.todos.create({
    id: 'todo_2',
    title: 'Explicit default',
    completed: false,
  })
  await vs.flush()

  expect(vs.debug.getPendingOps()).toMatchObject([
    {
      collection: 'todos',
      type: 'create',
      id: 'todo_1',
      value: {
        id: 'todo_1',
        title: 'Implicit default',
      },
    },
    {
      collection: 'todos',
      type: 'create',
      id: 'todo_2',
      value: {
        id: 'todo_2',
        title: 'Explicit default',
        completed: false,
      },
    },
  ])
})

test('direct proxy mutation becomes a dirty update after the batch window', async () => {
  vi.useFakeTimers()
  const vs = trackClient(
    valtioSync({
      endpoint: '/api/sync',
      schema: { account, todos },
      storage: createMemorySyncStorage({
        collections: {
          todos: [makeStoredTodo('todo_1', 'Old')],
        },
      }),
    }),
  )
  await vs.ready

  vs.todos.records.todo_1.title = 'Direct'
  await vi.advanceTimersByTimeAsync(100)
  await vs.flush()

  expect(vs.debug.getPendingOps()).toMatchObject([
    {
      collection: 'todos',
      type: 'update',
      id: 'todo_1',
      patch: {
        title: 'Direct',
      },
      touched: ['title'],
    },
  ])
})
