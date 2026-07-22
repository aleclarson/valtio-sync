# Quickstart

Install the package and its peer dependencies:

```sh
pnpm add valtio-sync valtio zod
```

Define one account state shape and one or more collections:

```ts
import { defineAccount, defineCollection } from 'valtio-sync/schema'
import { z } from 'zod'

export const account = defineAccount({
  fields: {
    theme: z.enum(['light', 'dark']).default('light'),
  },
})

export const todos = defineCollection({
  fields: {
    id: z.string(),
    title: z.string().default(''),
    completed: z.boolean().default(false),
  },
})
```

Create the client near your app shell:

```ts
import { valtioSync } from 'valtio-sync/client'
import { account, todos } from './schema'
import { z } from 'zod'

export const sync = valtioSync({
  endpoint: '/api/sync',
  schema: { account, todos },
  storage: { namespace: `my-app:${user.id}` },
  device: {
    deviceId: z.string().default(() => crypto.randomUUID()),
  },
  session: {
    sidebarOpen: z.boolean().default(false),
  },
})

await sync.hydrate()
```

Mutate the returned Valtio proxies directly:

```ts
sync.account.theme = 'dark'

sync.todos.create({
  id: 'todo_1',
  title: 'Ship v1',
})

sync.todos.records.todo_1.completed = true
await sync.sync()
```

Mutations persist locally without an explicit call. Remote sync is application-triggered, so call
`sync()` at the points where the app needs remote durability or fresh server state. See
[Sync Lifecycle](sync-lifecycle.md) for recommended triggers and retry behavior.

Expose a server endpoint:

```ts
import { valtioSync } from 'valtio-sync/server'
import { account, todos } from './schema'

const syncServer = valtioSync({
  schema: { account, todos },
  getContext: async (request) => ({
    user: await requireUser(request),
  }),
  handlers: {
    account: {
      update: async ({ ctx, patch }) => {
        const row = await updateAccount(ctx.user.id, patch)
        return { serverVersion: row.version, record: row }
      },
    },
    todos: {
      readChanges: async ({ ctx, since }) => readTodoChanges(ctx.user.id, since),
      create: async ({ ctx, record }) => {
        const row = await createTodo(ctx.user.id, record)
        return { serverVersion: row.version, record: row }
      },
      update: async ({ ctx, op, patch }) => {
        const row = await updateTodo(ctx.user.id, op.id, patch)
        return { serverVersion: row.version, record: row }
      },
      delete: async ({ ctx, op }) => {
        const version = await deleteTodo(ctx.user.id, op.id)
        return { serverVersion: version }
      },
    },
  },
})

export const POST = syncServer.handle
```

Each mutation handler returns a `serverVersion` and may return a canonical `record` when the server normalizes the value.
