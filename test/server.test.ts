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
  const syncServer = valtioSync({
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
  expect(typeof syncServer).toBe('object')
  expect(syncServer.handle).toEqual(expect.any(Function))

  const response = await syncServer.handle(
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
  const syncServer = valtioSync({
    schema: { account, todos },
    handlers: {
      todos: {
        create,
      },
    },
  })

  const response = await syncServer.handle(
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

test('server handler rejects contradictory operation and record ids', async () => {
  const create = vi.fn()
  const updateAccount = vi.fn()
  const syncServer = valtioSync({
    schema: { account, todos },
    handlers: {
      account: {
        update: updateAccount,
      },
      todos: {
        create,
      },
    },
  })

  const response = await syncServer.handle(
    syncRequest({
      clientId: 'device_1',
      schemaVersion: 1,
      lastServerSeq: null,
      ops: [
        {
          mutationId: 'm1',
          collection: 'todos',
          type: 'create',
          id: 'todo_outer',
          value: {
            id: 'todo_inner',
            title: 'Local',
          },
          touched: ['id', 'title'],
        },
        {
          mutationId: 'm2',
          collection: ACCOUNT_COLLECTION,
          type: 'update',
          id: 'not-the-singleton',
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

  expect(create).not.toHaveBeenCalled()
  expect(updateAccount).not.toHaveBeenCalled()
  expect(body.rejected).toMatchObject([
    {
      mutationId: 'm1',
      reason: 'validation',
      message: 'Record id must match operation id',
    },
    {
      mutationId: 'm2',
      reason: 'validation',
      message: 'Account operations must use the singleton id',
    },
  ])
})

test('server handler rejects contradictory canonical and changed record ids', async () => {
  const canonicalServer = valtioSync({
    schema: { account, todos },
    handlers: {
      todos: {
        create: () => ({
          serverVersion: 1,
          record: {
            id: 'todo_other',
            title: 'Canonical',
            completed: false,
          },
        }),
      },
    },
  })

  const canonicalResponse = await canonicalServer.handle(
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
          },
          touched: ['id', 'title'],
        },
      ],
    }),
  )
  const canonicalBody = await canonicalResponse.json()

  expect(canonicalBody.accepted).toEqual([])
  expect(canonicalBody.rejected).toMatchObject([
    {
      mutationId: 'm1',
      reason: 'server_error',
      message: 'Returned record id must match its envelope id',
    },
  ])

  const changesServer = valtioSync({
    schema: { account, todos },
    handlers: {
      todos: {
        readChanges: () => ({
          serverSeq: 2,
          changes: {
            upserted: [
              {
                id: 'todo_outer',
                serverVersion: 2,
                record: {
                  id: 'todo_inner',
                  title: 'Remote',
                  completed: false,
                },
              },
            ],
            deleted: [],
          },
        }),
      },
    },
  })

  await expect(
    changesServer.handle(
      syncRequest({
        clientId: 'device_1',
        schemaVersion: 1,
        lastServerSeq: null,
        ops: [],
      }),
    ),
  ).rejects.toThrow('Returned record id must match its envelope id')
})

test('server handler lets readChanges bootstrap a new device with a snapshot', async () => {
  const readSnapshot = vi.fn()
  const readChanges = vi.fn(({ since }) => ({
    serverSeq: 8,
    changes: {
      mode: 'snapshot' as const,
      upserted: [
        {
          id: 'todo_existing',
          serverVersion: 8,
          record: {
            id: 'todo_existing',
            title: 'Existing',
            completed: false,
          },
        },
      ],
      deleted: [],
    },
  }))
  const syncServer = valtioSync({
    schema: { account, todos },
    handlers: {
      todos: {
        readChanges,
        readSnapshot,
      },
    },
  })

  const response = await syncServer.handle(
    syncRequest({
      clientId: 'device_2',
      schemaVersion: 1,
      lastServerSeq: null,
      ops: [],
    }),
  )
  const body = await response.json()

  expect(readChanges).toHaveBeenCalledWith(
    expect.objectContaining({
      since: null,
    }),
  )
  expect(readSnapshot).not.toHaveBeenCalled()
  expect(body.serverSeq).toBe(8)
  expect(body.changes.todos).toMatchObject({
    mode: 'snapshot',
    upserted: [
      {
        id: 'todo_existing',
        serverVersion: 8,
      },
    ],
  })
})

test('server handler supports app-defined rejection and snapshot fallback', async () => {
  const syncServer = valtioSync({
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

  const response = await syncServer.handle(
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
  expect(body.changes.todos.mode).toBe('snapshot')
})
