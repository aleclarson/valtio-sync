import { describe, expect, test, vi } from 'vitest'
import {
  createMemorySyncStorage,
  createMemoryWebStorage,
  type SyncRequest,
  valtioSync,
} from 'valtio-sync/client'
import { defineAccount, defineCollection } from 'valtio-sync/schema'
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

let namespaceId = 0

describe('todo sync', () => {
  test('tracks a local create before sync', async () => {
    const sync = makeTestSync()
    try {
      await sync.ready

      sync.collections.todos.create({ id: 'todo_1', title: 'Draft' })
      await sync.flush()

      expect(sync.debug.getPendingOps()).toMatchObject([
        {
          collection: 'todos',
          type: 'create',
          id: 'todo_1',
        },
      ])

      await sync.sync()

      expect(sync.status.dirty).toBe(false)
      expect(sync.debug.getPendingOps()).toEqual([])
    } finally {
      sync.close()
    }
  })

  test('flushes batched proxy writes with fake timers', async () => {
    vi.useFakeTimers()

    const sync = makeTestSync()
    try {
      await sync.ready

      sync.collections.todos.create({ id: 'todo_1', title: 'Draft' })
      await sync.sync()

      sync.collections.todos.records.todo_1.title = 'Changed'
      await vi.advanceTimersByTimeAsync(100)
      await sync.flush()

      expect(sync.debug.getPendingOps()).toMatchObject([
        {
          collection: 'todos',
          type: 'update',
          id: 'todo_1',
          patch: {
            title: 'Changed',
          },
        },
      ])
    } finally {
      sync.close()
      vi.useRealTimers()
    }
  })
})

function makeTestSync() {
  let serverVersion = 0

  return valtioSync({
    endpoint: '/api/sync',
    namespace: `test:${++namespaceId}`,
    schema: { account, todos },
    storage: createMemorySyncStorage(),
    localStorage: createMemoryWebStorage(),
    sessionStorage: createMemoryWebStorage(),
    fetch: async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as SyncRequest

      return Response.json({
        serverSeq: serverVersion + request.ops.length,
        accepted: request.ops.map((op) => ({
          mutationId: op.mutationId,
          collection: op.collection,
          id: op.id,
          serverVersion: ++serverVersion,
          record: op.type === 'delete' ? undefined : getSyncedValue(op),
        })),
        rejected: [],
        changes: {},
      })
    },
  })
}

function getSyncedValue(op: SyncRequest['ops'][number]) {
  if (op.type === 'create') {
    return op.value
  }
  if (op.type === 'update') {
    return {
      id: op.id,
      title: String(op.patch.title ?? ''),
      completed: Boolean(op.patch.completed ?? false),
    }
  }
  return undefined
}
