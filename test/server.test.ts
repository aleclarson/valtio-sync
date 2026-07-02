import { z } from 'zod'
import { ACCOUNT_COLLECTION, ACCOUNT_ID, defineAccount, defineCollection } from '../src/schema.js'
import { rejectSync, valtioSync } from '../src/server.js'

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

function syncRequest(body: unknown) {
  return new Request('https://app.test/api/sync', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
    },
  })
}

test('server handler validates ops and returns accepted mutations with changes', async () => {
  const calls: string[] = []
  const POST = valtioSync({
    schema: { account, todos },
    getContext: async () => ({ userId: 'user_1' }),
    handlers: {
      account: {
        update: ({ ctx, patch }) => {
          calls.push(`account:${ctx.userId}:${patch.theme}`)
          return {
            serverVersion: 2,
            record: {
              theme: patch.theme ?? 'light',
            },
          }
        },
      },
      todos: {
        readChanges: ({ since }) => {
          calls.push(`read:${since}`)
          return {
            serverSeq: 5,
            changes: {
              upserted: [
                {
                  id: 'todo_remote',
                  serverVersion: 5,
                  record: {
                    id: 'todo_remote',
                    title: 'Remote',
                    completed: false,
                  },
                },
              ],
              deleted: [],
            },
          }
        },
        create: ({ ctx, record }) => {
          calls.push(`create:${ctx.userId}:${record.title}`)
          return {
            serverVersion: 3,
            record,
          }
        },
        update: ({ patch }) => ({
          serverVersion: 4,
          record: {
            id: 'todo_1',
            title: String(patch.title),
            completed: false,
          },
        }),
        delete: () => ({ serverVersion: 6 }),
      },
    },
  })

  const response = await POST(
    syncRequest({
      clientId: 'device_1',
      schemaVersion: 1,
      lastServerSeq: 1,
      ops: [
        {
          mutationId: 'm1',
          collection: 'todos',
          type: 'create',
          id: 'todo_1',
          value: {
            id: 'todo_1',
            title: 'Local',
          },
          touched: ['id', 'title'],
        },
        {
          mutationId: 'm2',
          collection: ACCOUNT_COLLECTION,
          type: 'update',
          id: ACCOUNT_ID,
          patch: {
            theme: 'dark',
          },
          touched: ['theme'],
          baseServerVersion: null,
        },
      ],
    }),
  )
  const body = await response.json()

  expect(response.status).toBe(200)
  expect(calls).toEqual(['create:user_1:Local', 'account:user_1:dark', 'read:1'])
  expect(body).toMatchObject({
    serverSeq: 5,
    accepted: [
      {
        mutationId: 'm1',
        collection: 'todos',
        id: 'todo_1',
        serverVersion: 3,
      },
      {
        mutationId: 'm2',
        collection: ACCOUNT_COLLECTION,
        id: ACCOUNT_ID,
        serverVersion: 2,
      },
    ],
    rejected: [],
    changes: {
      todos: {
        upserted: [
          {
            id: 'todo_remote',
            serverVersion: 5,
          },
        ],
      },
    },
  })
})

test('server handler rejects invalid ops without calling app handlers', async () => {
  const create = vi.fn()
  const POST = valtioSync({
    schema: { account, todos },
    handlers: {
      todos: {
        create,
      },
    },
  })

  const response = await POST(
    syncRequest({
      clientId: 'device_1',
      schemaVersion: 1,
      lastServerSeq: null,
      ops: [
        {
          mutationId: 'm1',
          collection: 'todos',
          type: 'create',
          id: 'todo_1',
          value: {
            id: 'todo_1',
            title: 'Local',
            extra: true,
          },
          touched: ['id', 'title', 'extra'],
        },
      ],
    }),
  )
  const body = await response.json()

  expect(create).not.toHaveBeenCalled()
  expect(body.rejected).toMatchObject([
    {
      mutationId: 'm1',
      reason: 'validation',
    },
  ])
})

test('server handler supports app-defined rejection and snapshot fallback', async () => {
  const POST = valtioSync({
    schema: { account, todos },
    handlers: {
      todos: {
        readSnapshot: () => ({
          serverSeq: 7,
          changes: {
            upserted: [
              {
                id: 'todo_1',
                serverVersion: 7,
                record: {
                  id: 'todo_1',
                  title: 'Snapshot',
                  completed: false,
                },
              },
            ],
            deleted: [],
          },
        }),
        delete: () => rejectSync('forbidden', 'No delete permission'),
      },
    },
  })

  const response = await POST(
    syncRequest({
      clientId: 'device_1',
      schemaVersion: 1,
      lastServerSeq: null,
      ops: [
        {
          mutationId: 'm1',
          collection: 'todos',
          type: 'delete',
          id: 'todo_1',
          baseServerVersion: 1,
        },
      ],
    }),
  )
  const body = await response.json()

  expect(body.serverSeq).toBe(7)
  expect(body.rejected).toMatchObject([
    {
      mutationId: 'm1',
      reason: 'forbidden',
      message: 'No delete permission',
    },
  ])
  expect(body.changes.todos.upserted).toMatchObject([
    {
      id: 'todo_1',
      serverVersion: 7,
    },
  ])
})
