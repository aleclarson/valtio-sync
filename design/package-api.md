# Package API

The package should expose client and server factories with the same name from separate entry points:

```ts
import { valtioSync } from 'valtio-sync/client'
import { valtioSync } from 'valtio-sync/server'
```

Both functions are named `valtioSync()`, but they live in different modules and serve different sides of the protocol.

## Schema Definitions

Schemas should be defined outside the client instance so they can be shared by the client and server.

Recommended shape:

```ts
import { defineAccount, defineCollection } from 'valtio-sync/schema'

export const account = defineAccount({
  fields: {
    theme: z.enum(['light', 'dark']).default('light'),
  },
})

export const todos = defineCollection({
  fields: {
    id: z.string(),
    title: z.string().default(''),
  },
})
```

The client then imports those shared definitions:

```ts
import { valtioSync } from 'valtio-sync/client'

export const vs = valtioSync({
  endpoint: '/api/sync',
  storage: { namespace: `my-app:${user.id}` },
  schema: {
    account,
    todos,
  },
  device: {
    deviceId: z.string(),
  },
  session: {
    sidebarOpen: z.boolean(),
  },
})
```

This split keeps shared client/server schema imports clean.

## Type Inference

Type inference should be supported from schema definitions:

```ts
import type { infer } from "valtio-sync/schema";

type Todo = infer<typeof todos>;
```

The exact exported inference helper can evolve, but inferred record types should not require developers to restate synced shapes manually.

## Client Factory

The client factory should receive the sync endpoint, shared synced schema definitions, a default
storage adapter, optional local-only device/session schemas, optional fetch override, and local
migrations.

The `device` and `session` schemas are plain field objects, not explicit `z.object(...)` declarations. They are made strict internally.

## Collection Definitions

Collection definitions are platform-agnostic because they are used on both the client and server.

The important configuration is `fields`:

```txt
keys must match the Drizzle table/view columns
values are Zod schemas
default values are attached here
validated on both client and server
platform-agnostic only
```

Defaults are deliberately not sent over the wire during insert unless the field was explicitly touched. The server/application should be able to apply its own database/application defaults, while the local client can still initialize useful local values.

## Implementation Details

Client factory example:

```ts
const vs = valtioSync({
  endpoint: '/api/sync',
  schema: {
    account,
    todos,
    projects,
  },

  device: {
    deviceId: z.string(),
    lastOpenedProjectId: z.string().nullable(),
  },

  session: {
    sidebarOpen: z.boolean(),
    draftSearch: z.string(),
  },

  fetch: customFetch,
  storage: { namespace: `my-app:${user.id}` },

  migrations: {
    2: migrateV1ToV2,
    3: migrateV2ToV3,
  },
})

await vs.hydrate()
```

Collection definition example:

```ts
export const todos = defineCollection({
  fields: {
    id: z.string(),
    title: z.string().default(''),
    completed: z.boolean().default(false),
  },
})
```

The optional Drizzle entry point should provide equivalent wrappers that accept
a compile-time database type marker:

```ts
import { $type, defineAccount, defineCollection } from 'valtio-sync/drizzle'
import { accountTable, todosTable } from './db/schema'

export const account = defineAccount({
  dbType: $type<typeof accountTable>(),
  fields: {
    theme: z.enum(['light', 'dark']).default('light'),
  },
})

export const todos = defineCollection({
  dbType: $type<typeof todosTable>(),
  fields: {
    id: z.string(),
    title: z.string().default(''),
    completed: z.boolean().default(false),
  },
})
```

Recommended collection API:

```ts
const todoCollection = vs.todos;

todoCollection.records[id].title = "New title";

todoCollection.create(...);
todoCollection.update(id, patch);
todoCollection.delete(id);

todoCollection.get(id);
todoCollection.list();
await todoCollection.pruneLocal(ids, { dryRun: true });
```

Collection names are direct client properties, so names that collide with the built-in client
surface are reserved and rejected by the client factory.

The collection should expose an explicit `records` property instead of making the collection itself indexable. `todos[id]` is elegant, but it collides with collection methods and special properties.

Recommended collection surface:

```ts
vs.todos.records // Valtio proxy object keyed by id
vs.todos.create
vs.todos.update
vs.todos.delete
vs.todos.get
vs.todos.list
vs.todos.flush
vs.todos.sync
vs.todos.pruneLocal
```

`pruneLocal` is explicit local cache maintenance. It accepts application-selected IDs, never emits delete mutations, and refuses to remove locally actionable records. Retention policy does not belong on platform-agnostic collection definitions shared with the server.

The client requires a default storage adapter but remains persistence-free during construction.
Argument-free `vs.hydrate()` activates that default; `vs.hydrate(adapter)` replaces it, and another
argument-free call returns to the default. Hydration loads device/session state and the IndexedDB
cache, runs migrations and validation, and publishes fresh state objects.

The client exposes scoped request-level transport interception. An interceptor receives a
`SyncRequest` and the next transport, and may pass through or modify the request, return a
replacement `SyncResponse`, or return `null` to drop the attempt. Interception does not alter the
local mutation lifecycle. Isolated development scenarios should combine a temporary memory adapter
with write-blocking transport interception and hydrate the default before removing protection.
