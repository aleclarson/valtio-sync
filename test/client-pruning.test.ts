import { z } from 'zod'
import { valtioSync } from '../src/client.js'
import { defineAccount, defineCollection } from '../src/schema.js'
import {
  type StoredRecord,
  createMemoryStorageAdapter,
  createMemorySyncStorage,
} from '../src/storage.js'

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
    storage: createMemoryStorageAdapter(),
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return jsonResponse({ serverSeq: 2, accepted: [], rejected: [], changes: {} })
    },
  })
  await vs.hydrate({ namespace: 'prune-clean', storage, broadcast: false })

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
    storage: createMemoryStorageAdapter(),
  })
  await vs.hydrate({ namespace: 'prune-protected', storage, broadcast: false })
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
    storage: createMemoryStorageAdapter(),
  })
  await vs.hydrate({ namespace: 'prune-concurrent', storage, broadcast: false })

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
