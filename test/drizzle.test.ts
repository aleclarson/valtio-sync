import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'
import {
  $type,
  applyOpsWithDrizzle,
  defineAccount as defineDrizzleAccount,
  defineCollection as defineDrizzleCollection,
  type DrizzleLikeDatabase,
} from '../src/drizzle.js'
import { defineAccount, defineCollection } from '../src/schema.js'
import { valtioSync } from '../src/server.js'

const accountTable = sqliteTable('account', {
  theme: text('theme', { enum: ['light', 'dark'] }).notNull(),
})

const todosTable = sqliteTable('todos', {
  id: text('id').notNull(),
  title: text('title').notNull(),
  completed: integer('completed', { mode: 'boolean' }).notNull(),
  note: text('note'),
})

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

const drizzleAccount = defineDrizzleAccount({
  dbType: $type<typeof accountTable>(),
  fields: {
    theme: z.enum(['light', 'dark']).default('light'),
  },
})

const drizzleTodos = defineDrizzleCollection({
  dbType: $type<typeof todosTable>(),
  fields: {
    id: z.string(),
    title: z.string().default(''),
    completed: z.boolean().default(false),
    note: z.string().nullable(),
  },
})

defineDrizzleCollection({
  dbType: $type<typeof todosTable>(),
  // @ts-expect-error Drizzle-backed fields must include every selected column.
  fields: {
    id: z.string(),
    title: z.string(),
    completed: z.boolean(),
  },
})

defineDrizzleCollection({
  dbType: $type<typeof todosTable>(),
  fields: {
    id: z.string(),
    title: z.string(),
    completed: z.boolean(),
    note: z.string().nullable(),
    // @ts-expect-error Drizzle-backed fields cannot include columns outside the selected row.
    archived: z.boolean(),
  },
})

defineDrizzleCollection({
  dbType: $type<typeof todosTable>(),
  fields: {
    id: z.string(),
    title: z.string(),
    // @ts-expect-error Nullable output is not compatible with a non-null Drizzle column.
    completed: z.boolean().nullable(),
    note: z.string().nullable(),
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

test('drizzle schema wrappers create normal schema definitions', () => {
  expect(drizzleAccount.kind).toBe('account')
  expect(drizzleTodos.kind).toBe('collection')
  expect(
    drizzleTodos.schema.parse({
      id: 'todo_1',
      title: 'Local',
      completed: false,
      note: null,
    }),
  ).toEqual({
    id: 'todo_1',
    title: 'Local',
    completed: false,
    note: null,
  })
})

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
  const syncServer = valtioSync({
    schema: { account, todos },
    handlers,
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

test('drizzle helper supports sync events that return a generated sequence', async () => {
  const inserted: Array<{ table: unknown; row: Record<string, unknown> }> = []
  const syncEventsTable = Symbol('sync_events')
  const db: DrizzleLikeDatabase = {
    transaction: async (callback) => callback(db),
    insert: (table) => ({
      values: (row) => {
        inserted.push({ table, row })
        return [{ seq: 99 }]
      },
    }),
  }
  const handlers = applyOpsWithDrizzle({
    db,
    syncEvents: {
      write: async ({ tx, collection, recordId, op }) => {
        const [event] = (await tx.insert(syncEventsTable).values({
          userId: 'user_1',
          collection,
          recordId,
          op,
        })) as Array<{ seq: number }>
        return event.seq
      },
    },
    handlers: {
      todos: {
        create: ({ record }) => ({
          record,
        }),
      },
    },
  })
  const syncServer = valtioSync({
    schema: { account, todos },
    handlers,
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
          },
          touched: ['id', 'title'],
        },
      ],
    }),
  )
  const body = await response.json()

  expect(inserted).toEqual([
    {
      table: syncEventsTable,
      row: {
        userId: 'user_1',
        collection: 'todos',
        recordId: 'todo_1',
        op: 'create',
      },
    },
  ])
  expect(body.accepted).toMatchObject([
    {
      mutationId: 'm1',
      serverVersion: 99,
    },
  ])
})
