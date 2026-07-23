import { z } from 'zod'
import {
  $type,
  applyOpsWithDrizzle,
  defineAccount as defineDrizzleAccount,
  defineCollection as defineDrizzleCollection,
  serverOnly,
  type DrizzleLikeDatabase,
} from '../src/drizzle.js'
import { defineAccount, defineCollection, parsePatch } from '../src/schema.js'
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

test('server-only fields are absent from runtime sync schemas', () => {
  const definition = defineDrizzleCollection({
    dbType: $type<{
      readonly $inferSelect: { id: string; userId: string; serverVersion: number }
    }>(),
    fields: {
      id: z.string(),
      userId: serverOnly(),
      serverVersion: serverOnly(),
    },
  })

  expect(Object.keys(definition.fields)).toEqual(['id'])
  expect(definition.recordSchema).toBe(definition.schema)
  expect(Object.keys(definition.recordSchema.shape)).toEqual(['id'])
  expect(definition.recordSchema.parse({ id: 'todo_1' })).toEqual({ id: 'todo_1' })
  expect(() => definition.recordSchema.parse({ id: 'todo_1', userId: 'user_1' })).toThrow()
  expect(() => parsePatch(definition, { serverVersion: 2 })).toThrow('Unknown patch field')
})

test('drizzle definitions refine only the synced record', () => {
  const definition = defineDrizzleAccount({
    dbType: $type<{
      readonly $inferSelect: { userId: string; mealsPerDay: number; meals: string[] }
    }>(),
    fields: {
      userId: serverOnly(),
      mealsPerDay: z.number().int().positive(),
      meals: z.array(z.string()),
    },
    refine: (record, ctx) => {
      if (record.meals.length !== record.mealsPerDay) {
        ctx.addIssue({ code: 'custom', path: ['meals'], message: 'Meal count mismatch' })
      }
    },
  })

  expect(definition.recordSchema.parse({ mealsPerDay: 1, meals: ['breakfast'] })).toEqual({
    mealsPerDay: 1,
    meals: ['breakfast'],
  })
  expect(() => definition.recordSchema.parse({ mealsPerDay: 2, meals: ['breakfast'] })).toThrow(
    'Meal count mismatch',
  )
})

test('an ordinary z.never field is not treated as server-only', () => {
  const definition = defineDrizzleCollection({
    dbType: $type<{ readonly $inferSelect: { id: string; impossible: string } }>(),
    fields: {
      id: z.string(),
      impossible: z.never(),
    },
  })

  expect(Object.keys(definition.fields)).toEqual(['id', 'impossible'])
  expect(() => definition.schema.parse({ id: 'todo_1', impossible: 'value' })).toThrow()
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

test('drizzle helper wraps account, update, and delete handlers without a transaction API', async () => {
  const events: Array<{ collection: string; recordId: string; op: string }> = []
  const db: DrizzleLikeDatabase = {
    insert: () => ({
      values: () => undefined,
    }),
  }
  const accountUpdate = vi.fn(({ tx, patch }) => ({
    serverVersion: 70,
    record: {
      theme: patch.theme,
    },
    tx,
  }))
  const todoUpdate = vi.fn(({ tx, patch }) => ({
    serverVersion: 80,
    record: {
      id: 'todo_update',
      title: patch.title,
      completed: false,
    },
    tx,
  }))
  let deleteTransaction: DrizzleLikeDatabase | undefined
  const todoDelete = vi.fn(({ tx }) => {
    deleteTransaction = tx
    return {}
  })
  let nextSequence = 10
  const handlers = applyOpsWithDrizzle({
    db,
    syncEvents: {
      write: ({ collection, recordId, op }) => {
        events.push({ collection, recordId, op })
        nextSequence += 1
        return nextSequence
      },
    },
    handlers: {
      account: {
        update: accountUpdate,
      },
      todos: {
        update: todoUpdate,
        delete: todoDelete,
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
          collection: 'account',
          type: 'update',
          id: 'singleton',
          patch: { theme: 'dark' },
          touched: ['theme'],
          baseServerVersion: 1,
        },
        {
          mutationId: 'm2',
          collection: 'todos',
          type: 'update',
          id: 'todo_update',
          patch: { title: 'Updated' },
          touched: ['title'],
          baseServerVersion: 1,
        },
        {
          mutationId: 'm3',
          collection: 'todos',
          type: 'delete',
          id: 'todo_delete',
          baseServerVersion: 1,
        },
      ],
    }),
  )
  const body = await response.json()

  expect(accountUpdate).toHaveBeenCalledWith(expect.objectContaining({ tx: db }))
  expect(todoUpdate).toHaveBeenCalledWith(expect.objectContaining({ tx: db }))
  expect(todoDelete).toHaveBeenCalledOnce()
  expect(deleteTransaction).toBe(db)
  expect(events).toEqual([
    { collection: 'account', recordId: 'singleton', op: 'update' },
    { collection: 'todos', recordId: 'todo_update', op: 'update' },
    { collection: 'todos', recordId: 'todo_delete', op: 'delete' },
  ])
  expect(body.accepted).toMatchObject([
    { mutationId: 'm1', serverVersion: 70 },
    { mutationId: 'm2', serverVersion: 80 },
    { mutationId: 'm3', serverVersion: 13 },
  ])
})

test.each([
  ['authorize', ['authorize']],
  ['conflict', ['authorize', 'conflict']],
  ['mutation', ['authorize', 'conflict', 'mutation']],
  ['event', ['authorize', 'conflict', 'mutation', 'event']],
] as const)(
  'drizzle helper stops the mutation pipeline after a %s failure',
  async (failure, expectedOrder) => {
    const order: string[] = []
    const tx: DrizzleLikeDatabase = {
      insert: () => ({
        values: () => undefined,
      }),
    }
    const db: DrizzleLikeDatabase = {
      insert: tx.insert,
      transaction: async (callback) => callback(tx),
    }
    const handlers = applyOpsWithDrizzle({
      db,
      authorize: () => {
        order.push('authorize')
        if (failure === 'authorize') {
          throw new Error('authorize failed')
        }
      },
      checkConflict: () => {
        order.push('conflict')
        if (failure === 'conflict') {
          throw new Error('conflict failed')
        }
      },
      syncEvents: {
        write: () => {
          order.push('event')
          if (failure === 'event') {
            throw new Error('event failed')
          }
          return 1
        },
      },
      handlers: {
        todos: {
          create: ({ record }) => {
            order.push('mutation')
            if (failure === 'mutation') {
              throw new Error('mutation failed')
            }
            return { record }
          },
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

    expect(order).toEqual(expectedOrder)
    expect(body.accepted).toEqual([])
    expect(body.rejected).toMatchObject([
      {
        mutationId: 'm1',
        reason: 'server_error',
        message: `${failure} failed`,
      },
    ])
  },
)
