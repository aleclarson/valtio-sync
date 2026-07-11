import {
  createMemorySyncStorage,
  createMemoryWebStorage,
  valtioSync as createValtioSyncClient,
} from 'valtio-sync/client'
import { rejectSync, valtioSync as createValtioSyncServer } from 'valtio-sync/server'
import { defineAccount, defineCollection, type infer as InferSync } from 'valtio-sync/schema'
import { z } from 'zod'

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

type Todo = InferSync<typeof todos>

// The example keeps the server in memory so the sync contract is visible without
// database setup. A real app would scope these rows by the authenticated user.
const serverTodos = new Map<string, { record: Todo; serverVersion: number }>()
let serverSeq = 0

const syncServer = createValtioSyncServer({
  schema: { account, todos },
  handlers: {
    todos: {
      // Snapshot reads are the smallest useful server shape. Use readChanges
      // instead when you already have a durable event log or sequence cursor.
      readSnapshot: async () => ({
        serverSeq,
        changes: {
          upserted: [...serverTodos.values()].map(({ record, serverVersion }) => ({
            id: record.id,
            serverVersion,
            record,
          })),
          deleted: [],
        },
      }),
      create: async ({ record }) => {
        // Handlers receive schema-validated JSON. Returning a record lets the
        // server canonicalize local optimistic state after the mutation lands.
        const normalized = normalizeTodo(record as Todo)
        const serverVersion = ++serverSeq
        serverTodos.set(normalized.id, { record: normalized, serverVersion })
        return { serverVersion, record: normalized }
      },
      update: async ({ op, patch }) => {
        const current = serverTodos.get(op.id)
        if (!current) {
          rejectSync('not_found', 'Todo not found')
        }

        const record = normalizeTodo({
          ...current.record,
          ...patch,
        })
        const serverVersion = ++serverSeq
        serverTodos.set(op.id, { record, serverVersion })
        return { serverVersion, record }
      },
      delete: async ({ op }) => {
        if (!serverTodos.has(op.id)) {
          rejectSync('not_found', 'Todo not found')
        }

        serverTodos.delete(op.id)
        return { serverVersion: ++serverSeq }
      },
    },
  },
})

const sync = createValtioSyncClient({
  endpoint: '/api/sync',
  namespace: 'basic-todos:demo-user',
  schema: { account, todos },
  storage: createMemorySyncStorage(),
  localStorage: createMemoryWebStorage(),
  sessionStorage: createMemoryWebStorage(),
  // This bridge keeps the example single-file. Browser apps usually let fetch
  // hit their real /api/sync route instead.
  fetch: (_input, init) => {
    return syncServer.handle(
      new Request('https://app.example/api/sync', {
        method: 'POST',
        body: init?.body,
        headers: init?.headers,
      }),
    )
  },
})

await sync.ready

// Application code mutates Valtio state normally. The client persists the write
// locally, marks it dirty, and sends it on the next sync.
const todo = sync.todos.create({
  id: 'todo_1',
  title: ' Ship the first example ',
})

todo.completed = true
await sync.sync()

console.log(sync.todos.list())
sync.close()

function normalizeTodo(todo: Todo): Todo {
  const title = todo.title.trim()
  return {
    ...todo,
    title: title || 'Untitled',
  }
}
