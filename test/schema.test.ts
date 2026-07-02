import { z } from 'zod'
import { defineAccount, defineCollection, getDefaults, parseRecord } from '../src/schema.js'

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
