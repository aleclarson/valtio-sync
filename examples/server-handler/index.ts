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

// The rows map stands in for application tables. The event list stands in for a
// sync_events table that can answer "what changed since this cursor?"
const rows = new Map<string, TodoRow>()
const events: SyncEvent[] = []
let serverSeq = 0

const syncServer = createValtioSyncServer({
  schema: { account, todos },
  // Put authentication, tenant lookup, and request-scoped dependencies here.
  // Handlers should trust ctx, not client-supplied collection data.
  getContext: async (request): Promise<UserContext> => ({
    userId: request.headers.get('x-user-id') ?? 'demo-user',
  }),
  handlers: {
    todos: {
      // readChanges returns only durable server changes newer than the client's
      // last cursor. This is the shape to prefer over snapshots at scale.
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
        // The server owns canonicalization and uniqueness. Production code
        // should also make creates idempotent with the handler's mutation id.
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
        // Rejecting stale base versions keeps conflict policy explicit and
        // lets the client retain its optimistic local value for inspection.
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

// The server handle method is an ordinary Request -> Response function, so it
// is easy to test without a framework adapter.
const response = await syncServer.handle(
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
