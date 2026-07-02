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
type UserContext = { userId: string }
type TodoRow = {
  userId: string
  record: Todo
  serverVersion: number
}
type SyncEvent =
  | {
      seq: number
      userId: string
      id: string
      type: 'upsert'
      record: Todo
    }
  | {
      seq: number
      userId: string
      id: string
      type: 'delete'
    }

const rows = new Map<string, TodoRow>()
const events: SyncEvent[] = []
let serverSeq = 0

const POST = createValtioSyncHandler({
  schema: { account, todos },
  getContext: async (request): Promise<UserContext> => ({
    userId: request.headers.get('x-user-id') ?? 'demo-user',
  }),
  handlers: {
    todos: {
      readChanges: async ({ ctx, since }) => {
        const visibleEvents = events.filter(
          (event) => event.userId === ctx.userId && event.seq > (since ?? 0),
        )

        return {
          serverSeq,
          changes: {
            upserted: visibleEvents
              .filter((event) => event.type === 'upsert')
              .map((event) => ({
                id: event.id,
                serverVersion: event.seq,
                record: event.record,
              })),
            deleted: visibleEvents
              .filter((event) => event.type === 'delete')
              .map((event) => ({
                id: event.id,
                serverVersion: event.seq,
              })),
          },
        }
      },
      create: async ({ ctx, record }) => {
        const todo = record as Todo
        const key = todoKey(ctx.userId, todo.id)
        if (rows.has(key)) {
          rejectSync('conflict', 'Todo already exists')
        }

        const normalized = normalizeTodo(todo)
        const serverVersion = writeEvent(ctx.userId, normalized.id, {
          type: 'upsert',
          record: normalized,
        })
        rows.set(key, {
          userId: ctx.userId,
          record: normalized,
          serverVersion,
        })
        return { serverVersion, record: normalized }
      },
      update: async ({ ctx, op, patch }) => {
        const row = rows.get(todoKey(ctx.userId, op.id))
        if (!row) {
          rejectSync('not_found', 'Todo not found')
        }
        if (op.baseServerVersion !== null && op.baseServerVersion !== row.serverVersion) {
          rejectSync('conflict', 'Base version is stale', {
            serverVersion: row.serverVersion,
            serverRecord: row.record,
          })
        }

        const record = normalizeTodo({
          ...row.record,
          ...patch,
        })
        const serverVersion = writeEvent(ctx.userId, op.id, {
          type: 'upsert',
          record,
        })
        rows.set(todoKey(ctx.userId, op.id), {
          ...row,
          record,
          serverVersion,
        })
        return { serverVersion, record }
      },
      delete: async ({ ctx, op }) => {
        const row = rows.get(todoKey(ctx.userId, op.id))
        if (!row) {
          rejectSync('not_found', 'Todo not found')
        }
        if (op.baseServerVersion !== null && op.baseServerVersion !== row.serverVersion) {
          rejectSync('conflict', 'Base version is stale', {
            serverVersion: row.serverVersion,
            serverRecord: row.record,
          })
        }

        rows.delete(todoKey(ctx.userId, op.id))
        const serverVersion = writeEvent(ctx.userId, op.id, { type: 'delete' })
        return { serverVersion }
      },
    },
  },
})

const response = await POST(
  new Request('https://app.example/api/sync', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-user-id': 'demo-user',
    },
    body: JSON.stringify({
      clientId: 'device_1',
      schemaVersion: 1,
      lastServerSeq: null,
      ops: [
        {
          mutationId: 'mutation_1',
          collection: 'todos',
          type: 'create',
          id: 'todo_1',
          value: {
            id: 'todo_1',
            title: ' Server handler example ',
          },
          touched: ['id', 'title'],
        },
      ],
    }),
  }),
)

console.log(await response.json())

function todoKey(userId: string, id: string): string {
  return `${userId}:${id}`
}

function normalizeTodo(todo: Todo): Todo {
  const title = todo.title.trim()
  return {
    ...todo,
    title: title || 'Untitled',
  }
}

function writeEvent(
  userId: string,
  id: string,
  event:
    | {
        type: 'upsert'
        record: Todo
      }
    | {
        type: 'delete'
      },
): number {
  const seq = ++serverSeq
  events.push({
    seq,
    userId,
    id,
    ...event,
  })
  return seq
}
