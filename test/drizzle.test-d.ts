import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { expectTypeOf, test } from 'vitest'
import { z } from 'zod'
import { $type, defineAccount, defineCollection } from '../src/drizzle.js'
import type { infer as InferSync } from '../src/schema.js'

const accountTable = sqliteTable('account', {
  theme: text('theme', { enum: ['light', 'dark'] }).notNull(),
})

const todosTable = sqliteTable('todos', {
  id: text('id').notNull(),
  title: text('title').notNull(),
  completed: integer('completed', { mode: 'boolean' }).notNull(),
  note: text('note'),
})

test('drizzle account definitions infer schema record types', () => {
  const drizzleAccount = defineAccount({
    dbType: $type<typeof accountTable>(),
    fields: {
      theme: z.enum(['light', 'dark']).default('light'),
    },
  })

  expectTypeOf<InferSync<typeof drizzleAccount>>().toEqualTypeOf<{
    theme: 'light' | 'dark'
  }>()
})

test('drizzle collection definitions infer schema record types', () => {
  const drizzleTodos = defineCollection({
    dbType: $type<typeof todosTable>(),
    fields: {
      id: z.string(),
      title: z.string().default(''),
      completed: z.boolean().default(false),
      note: z.string().nullable(),
    },
  })

  expectTypeOf<InferSync<typeof drizzleTodos>>().toEqualTypeOf<{
    id: string
    title: string
    completed: boolean
    note: string | null
  }>()
})

test('drizzle collection definitions reject missing fields', () => {
  defineCollection({
    dbType: $type<typeof todosTable>(),
    // @ts-expect-error Drizzle-backed fields must include every selected column.
    fields: {
      id: z.string(),
      title: z.string(),
      completed: z.boolean(),
    },
  })
})

test('drizzle collection definitions reject extra fields', () => {
  defineCollection({
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
})

test('drizzle collection definitions reject incompatible field output', () => {
  defineCollection({
    dbType: $type<typeof todosTable>(),
    fields: {
      id: z.string(),
      title: z.string(),
      // @ts-expect-error Nullable output is not compatible with a non-null Drizzle column.
      completed: z.boolean().nullable(),
      note: z.string().nullable(),
    },
  })
})
