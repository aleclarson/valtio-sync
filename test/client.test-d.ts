import { test } from 'vitest'
import { z } from 'zod'
import { valtioSync } from '../src/client.js'
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
  })

  sync.todos.create({ id: 'todo_1', title: 'Direct' })

  // @ts-expect-error The collections namespace is not part of the client API.
  sync.collections.todos
})

test('collection names cannot collide with client properties', () => {
  valtioSync({
    endpoint: '/api/sync',
    schema: {
      account,
      // @ts-expect-error Collection names are direct properties, so built-in names are reserved.
      sync: todos,
    },
  })
})
