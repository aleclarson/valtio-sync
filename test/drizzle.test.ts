import { z } from 'zod'
import { applyOpsWithDrizzle, type DrizzleLikeDatabase } from '../src/drizzle.js'
import { defineAccount, defineCollection } from '../src/schema.js'
import { valtioSync } from '../src/server.js'

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

test('drizzle helper wraps mutations in a transaction and writes sync events', async () => {
  const inserted: Array<{ table: unknown; row: Record<string, unknown> }> = []
  let transactionCount = 0
  const tx: DrizzleLikeDatabase = {
    insert: (table) => ({
      values: (row) => {
        inserted.push({ table, row })
      },
    }),
  }
  const db: DrizzleLikeDatabase = {
    transaction: async (callback) => {
      transactionCount += 1
      return callback(tx)
    },
    insert: tx.insert,
  }
  const authorize = vi.fn()
  const checkConflict = vi.fn()
  const syncEventsTable = Symbol('sync_events')
  const handlers = applyOpsWithDrizzle({
    db,
    authorize,
    checkConflict,
    syncEvents: {
      table: syncEventsTable,
      nextSeq: () => 42,
      toRow: ({ collection, recordId, op, seq }) => ({
        userId: 'user_1',
        seq,
        collection,
        recordId,
        op,
      }),
    },
    handlers: {
      todos: {
        create: ({ record }) => ({
          record,
        }),
      },
    },
  })
  const POST = valtioSync({
    schema: { account, todos },
    handlers,
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
          },
          touched: ['id', 'title'],
        },
      ],
    }),
  )
  const body = await response.json()

  expect(transactionCount).toBe(1)
  expect(authorize).toHaveBeenCalledWith(
    expect.objectContaining({
      collection: 'todos',
    }),
  )
  expect(checkConflict).toHaveBeenCalledWith(
    expect.objectContaining({
      collection: 'todos',
      tx,
    }),
  )
  expect(inserted).toEqual([
    {
      table: syncEventsTable,
      row: {
        userId: 'user_1',
        seq: 42,
        collection: 'todos',
        recordId: 'todo_1',
        op: 'create',
      },
    },
  ])
  expect(body.accepted).toMatchObject([
    {
      mutationId: 'm1',
      serverVersion: 42,
    },
  ])
})
