import { expectTypeOf, test } from 'vitest'
import { z } from 'zod'
import {
  createMemoryStorageAdapter,
  preventRemoteWrites,
  type SyncTransportInterceptor,
  valtioSync,
} from '../src/client.js'
import { defineAccount, defineCollection } from '../src/schema.js'

const account = defineAccount({
  fields: { theme: z.string() },
})

const todos = defineCollection({
  fields: { id: z.string(), title: z.string() },
})

test('collections are direct client properties', () => {
  const sync = valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
    storage: createMemoryStorageAdapter(),
  })

  expectTypeOf(sync.todos.create).toBeFunction()

  // @ts-expect-error The collections namespace is not part of the client API.
  sync.collections.todos

  expectTypeOf(sync.hydrate()).toEqualTypeOf<Promise<void>>()
  expectTypeOf(sync.hydrate(createMemoryStorageAdapter())).toEqualTypeOf<Promise<void>>()
  expectTypeOf(preventRemoteWrites).toEqualTypeOf<SyncTransportInterceptor>()

  // @ts-expect-error Hydration is explicit; the automatic ready promise was removed.
  sync.ready
})

test('a default storage adapter is required by the client', () => {
  // @ts-expect-error A default storage adapter is required.
  valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
  })

  valtioSync({
    endpoint: '/api/sync',
    schema: { account, todos },
    storage: createMemoryStorageAdapter(),
    // @ts-expect-error Namespace belongs to the storage adapter.
    namespace: 'user_1',
  })
})

test('collection names cannot collide with client properties', () => {
  valtioSync({
    storage: createMemoryStorageAdapter(),
    endpoint: '/api/sync',
    schema: {
      account,
      // @ts-expect-error Collection names are direct properties, so built-in names are reserved.
      sync: todos,
    },
  })
})
