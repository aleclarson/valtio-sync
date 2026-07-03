# Package API

The package should expose client and server factories with the same name from separate entry points:

```ts
import { valtioSync } from "valtio-sync/client";
import { valtioSync } from "valtio-sync/server";
```

Both functions are named `valtioSync()`, but they live in different modules and serve different sides of the protocol.

## Schema Definitions

Schemas should be defined outside the client instance so they can be shared by the client and server.

Recommended shape:

```ts
import { defineAccount, defineCollection } from "valtio-sync/schema";

export const account = defineAccount({
  fields: {
    theme: z.enum(["light", "dark"]).default("light"),
  },
});

export const todos = defineCollection({
  fields: {
    id: z.string(),
    title: z.string().default(""),
  },
});
```

The client then imports those shared definitions:

```ts
import { valtioSync } from "valtio-sync/client";

export const vs = valtioSync({
  endpoint: "/api/sync",
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
});
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

The client factory should receive the sync endpoint, shared synced schema definitions, optional local-only device/session schemas, optional fetch override, and local migrations.

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
  endpoint: "/api/sync",

  namespace: `my-app:${user.id}`,

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

  migrations: {
    2: migrateV1ToV2,
    3: migrateV2ToV3,
  },
});
```

Collection definition example:

```ts
export const todos = defineCollection({
  fields: {
    id: z.string(),
    title: z.string().default(""),
    completed: z.boolean().default(false),
  },
});
```

The optional Drizzle entry point should provide equivalent wrappers that accept
a compile-time database type marker:

```ts
import { $type, defineAccount, defineCollection } from "valtio-sync/drizzle";
import { accountTable, todosTable } from "./db/schema";

export const account = defineAccount({
  dbType: $type<typeof accountTable>(),
  fields: {
    theme: z.enum(["light", "dark"]).default("light"),
  },
});

export const todos = defineCollection({
  dbType: $type<typeof todosTable>(),
  fields: {
    id: z.string(),
    title: z.string().default(""),
    completed: z.boolean().default(false),
  },
});
```

Recommended collection API:

```ts
const todoCollection = vs.collections.todos;

todoCollection.records[id].title = "New title";

todoCollection.create(...);
todoCollection.update(id, patch);
todoCollection.delete(id);

todoCollection.get(id);
todoCollection.list();
```

The collection should expose an explicit `records` property instead of making the collection itself indexable. `todos[id]` is elegant, but it collides with collection methods and special properties.

Recommended collection surface:

```ts
vs.collections.todos.records; // Valtio proxy object keyed by id
vs.collections.todos.create;
vs.collections.todos.update;
vs.collections.todos.delete;
vs.collections.todos.get;
vs.collections.todos.list;
vs.collections.todos.flush;
vs.collections.todos.sync;
```

The client also exposes `vs.ready`, a promise that resolves after local device/session state, IndexedDB cache, migrations, validation, and proxy hydration complete.
