# valtio-sync

```
pnpm add valtio-sync
```

## Sketch

```ts
import { valtioSync } from 'valtio-sync/client'
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

const vs = valtioSync({
  endpoint: '/api/sync',
  namespace: `my-app:${user.id}`,
  schema: { account, todos },
})

await vs.ready

vs.todos.create({ id: 'todo_1', title: 'Ship v1' })
vs.todos.records.todo_1.completed = true
await vs.sync()
```

Local persistence is automatic, but applications trigger the first remote sync by calling
`sync()`. See [Sync Lifecycle](docs/sync-lifecycle.md) for retry behavior and recommended sync
triggers.

## Documentation

Usage documentation lives in [docs](docs/README.md).
