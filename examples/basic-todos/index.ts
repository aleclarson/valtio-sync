import {
  createMemorySyncStorage,
  createMemoryWebStorage,
  valtioSync as createValtioSyncClient,
} from 'valtio-sync/client'
import { rejectSync, valtioSync as createValtioSyncHandler } from 'valtio-sync/server'
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

const serverTodos = new Map<string, { record: Todo; serverVersion: number }>()
let serverSeq = 0

const POST = createValtioSyncHandler({
  schema: { account, todos },
  handlers: {
    todos: {
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
  fetch: (_input, init) => {
    return POST(
      new Request('https://app.example/api/sync', {
        method: 'POST',
        body: init?.body,
        headers: init?.headers,
      }),
    )
  },
})

await sync.ready

const todo = sync.collections.todos.create({
  id: 'todo_1',
  title: ' Ship the first example ',
})

todo.completed = true
await sync.sync()

console.log(sync.collections.todos.list())
sync.close()

function normalizeTodo(todo: Todo): Todo {
  const title = todo.title.trim()
  return {
    ...todo,
    title: title || 'Untitled',
  }
}
