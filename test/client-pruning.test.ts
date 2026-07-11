import { z } from 'zod'
import { valtioSync } from '../src/client.js'
import { defineAccount, defineCollection } from '../src/schema.js'
import { type StoredRecord, createMemorySyncStorage } from '../src/storage.js'

const account = defineAccount({ fields: {} })
const entries = defineCollection({
  fields: {
    id: z.string(),
    label: z.string(),
  },
})

function stored(id: string, meta: Partial<StoredRecord['meta']> = {}): StoredRecord {
  return {
    id,
    data: { id, label: id },
    meta: {
      dirty: false,
      deleted: false,
      serverVersion: 1,
      baseServerVersion: 1,
      updatedAtClient: 0,
      updatedByDevice: 'device_1',
      lastSyncedAt: 0,
      ...meta,
    },
  }
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('prunes clean records locally without producing server delete operations', async () => {
  const storage = createMemorySyncStorage({
    collections: { entries: [stored('old'), stored('keep')] },
  })
  const requests: Array<{ ops: unknown[] }> = []
  const vs = valtioSync({
    endpoint: '/api/sync',
    schema: { account, entries },
    storage,
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return jsonResponse({ serverSeq: 2, accepted: [], rejected: [], changes: {} })
    },
  })
  await vs.ready

  const result = await vs.entries.pruneLocal(['old'])

  expect(result).toEqual({
    dryRun: false,
    requested: ['old'],
    eligible: ['old'],
    evicted: ['old'],
    missing: [],
    protected: [],
  })
  expect(vs.entries.get('old')).toBeUndefined()
  expect(vs.entries.get('keep')).toMatchObject({ label: 'keep' })
  expect(await storage.readRecord('entries', 'old')).toBeNull()
  expect(vs.debug.getPendingOps()).toEqual([])

  await vs.sync()
  expect(requests[0]?.ops).toEqual([])
})

test('dry-run reports actionable records and pruning preserves them', async () => {
  const storage = createMemorySyncStorage({
    collections: {
      entries: [
        stored('clean'),
        stored('dirty-update', { dirty: true, mutationId: 'update_1', touched: ['label'] }),
        stored('pending-delete', { dirty: true, deleted: true, mutationId: 'delete_1' }),
        stored('conflicted', {
          lastError: { reason: 'conflict', message: 'Resolve this record first' },
        }),
      ],
    },
  })
  const vs = valtioSync({
    endpoint: '/api/sync',
    schema: { account, entries },
    storage,
  })
  await vs.ready
  vs.entries.create({ id: 'dirty-create', label: 'new' })

  const result = await vs.entries.pruneLocal(
    ['clean', 'dirty-update', 'pending-delete', 'conflicted', 'dirty-create', 'missing'],
    { dryRun: true },
  )

  expect(result).toEqual({
    dryRun: true,
    requested: ['clean', 'dirty-update', 'pending-delete', 'conflicted', 'dirty-create', 'missing'],
    eligible: ['clean'],
    evicted: [],
    missing: ['missing'],
    protected: [
      { id: 'dirty-update', reason: 'pending' },
      { id: 'pending-delete', reason: 'pending' },
      { id: 'conflicted', reason: 'error' },
      { id: 'dirty-create', reason: 'pending' },
    ],
  })
  expect(await storage.readRecord('entries', 'clean')).not.toBeNull()
  expect(vs.entries.get('clean')).toBeDefined()

  const pruned = await vs.entries.pruneLocal(result.requested)
  expect(pruned.evicted).toEqual(['clean'])
  expect(pruned.protected).toEqual(result.protected)
  expect(await storage.readRecord('entries', 'dirty-update')).not.toBeNull()
  expect(await storage.readRecord('entries', 'pending-delete')).not.toBeNull()
  expect(await storage.readRecord('entries', 'conflicted')).not.toBeNull()
  expect(await storage.readRecord('entries', 'dirty-create')).not.toBeNull()
  expect(vs.entries.get('dirty-update')).toBeDefined()
  expect(vs.entries.get('conflicted')).toBeDefined()
  expect(vs.entries.get('dirty-create')).toBeDefined()
})

test('compare-and-delete preserves a record changed by another client', async () => {
  const baseStorage = createMemorySyncStorage({
    collections: { entries: [stored('entry_1')] },
  })
  const storage = {
    ...baseStorage,
    async deleteRecordsIfUnchanged(collection: string, records: readonly StoredRecord[]) {
      await baseStorage.writeRecord(
        collection,
        stored('entry_1', { dirty: true, mutationId: 'other_tab', touched: ['label'] }),
      )
      return baseStorage.deleteRecordsIfUnchanged(collection, records)
    },
  }
  const vs = valtioSync({
    endpoint: '/api/sync',
    schema: { account, entries },
    storage,
  })
  await vs.ready

  const result = await vs.entries.pruneLocal(['entry_1'])

  expect(result.evicted).toEqual([])
  expect(result.protected).toEqual([{ id: 'entry_1', reason: 'changed' }])
  expect(await storage.readRecord('entries', 'entry_1')).toMatchObject({
    meta: { dirty: true, mutationId: 'other_tab' },
  })
  expect(vs.entries.get('entry_1')).toBeDefined()
  expect(vs.debug.getPendingOps()).toMatchObject([
    { collection: 'entries', id: 'entry_1', type: 'update' },
  ])
})

test('dependent collections can be pruned in stages from retained records', async () => {
  const meals = defineCollection({
    fields: { id: z.string(), foodVersionId: z.string(), day: z.number() },
  })
  const foods = defineCollection({ fields: { id: z.string(), current: z.boolean() } })
  const storage = createMemorySyncStorage({
    collections: {
      meals: [
        { ...stored('old-meal'), data: { id: 'old-meal', foodVersionId: 'food-old', day: 1 } },
        { ...stored('new-meal'), data: { id: 'new-meal', foodVersionId: 'food-used', day: 100 } },
      ],
      foods: [
        { ...stored('food-old'), data: { id: 'food-old', current: false } },
        { ...stored('food-used'), data: { id: 'food-used', current: false } },
        { ...stored('food-current'), data: { id: 'food-current', current: true } },
      ],
    },
  })
  const vs = valtioSync({
    endpoint: '/api/sync',
    schema: { account, meals, foods },
    storage,
  })
  await vs.ready

  await vs.meals.pruneLocal(
    vs.meals
      .list()
      .filter((meal) => meal.day < 90)
      .map((meal) => meal.id),
  )
  const referenced = new Set(vs.meals.list().map((meal) => meal.foodVersionId))
  await vs.foods.pruneLocal(
    vs.foods
      .list()
      .filter((food) => !food.current && !referenced.has(food.id))
      .map((food) => food.id),
  )

  expect(vs.meals.list().map((meal) => meal.id)).toEqual(['new-meal'])
  expect(vs.foods.list().map((food) => food.id)).toEqual(['food-used', 'food-current'])
})
