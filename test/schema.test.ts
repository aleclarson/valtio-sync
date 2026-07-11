import { z } from 'zod'
import { defineAccount, defineCollection, getDefaults, parseRecord } from '../src/schema.js'
import type { infer as InferSync } from '../src/schema.js'

test('schema definitions validate strict JSON records', () => {
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

  expect(getDefaults(account)).toEqual({ theme: 'light' })
  expect(getDefaults(todos)).toEqual({ title: '', completed: false })
  expect(parseRecord(todos, { id: 'todo_1', title: 'Ship', completed: false })).toEqual({
    id: 'todo_1',
    title: 'Ship',
    completed: false,
  })
  expect(() => parseRecord(todos, { id: 'todo_1', title: 'Ship', extra: true })).toThrow()
})

test('recordSchema is the effective strict schema with defaults', () => {
  const foods = defineCollection({
    fields: {
      id: z.string(),
      name: z.string().trim().min(1),
      archived: z.boolean().default(false),
    },
  })

  expect(foods.recordSchema).toBe(foods.schema)
  expect(foods.recordSchema.parse({ id: 'food_1', name: ' Oats ' })).toEqual({
    id: 'food_1',
    name: 'Oats',
    archived: false,
  })
  expect(() => foods.recordSchema.parse({ id: 'food_1', name: 'Oats', extra: true })).toThrow()
  expectTypeOf<InferSync<typeof foods>>().toEqualTypeOf<z.infer<typeof foods.recordSchema>>()
})

test('definitions support cross-field record refinement', () => {
  const account = defineAccount({
    fields: {
      mealsPerDay: z.number().int().positive(),
      meals: z.array(z.string()),
    },
    refine: (record, ctx) => {
      if (record.meals.length !== record.mealsPerDay) {
        ctx.addIssue({
          code: 'custom',
          path: ['meals'],
          message: 'Meals must match mealsPerDay',
        })
      }
    },
  })

  expect(parseRecord(account, { mealsPerDay: 2, meals: ['breakfast', 'dinner'] })).toEqual({
    mealsPerDay: 2,
    meals: ['breakfast', 'dinner'],
  })
  expect(() => parseRecord(account, { mealsPerDay: 2, meals: ['breakfast'] })).toThrow(
    'Meals must match mealsPerDay',
  )
})
