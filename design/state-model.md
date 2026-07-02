# State Model

`valtio-sync` has four first-class state primitives:

```txt
account
collections
device
session
```

Synced state is represented by `account` and `collections`. Local-only durable browser state is represented by `device` and `session`.

## Account

`account` is a first-class singleton synced record. It holds user/account-level state such as preferences, current workspace, settings, and similar user-scoped state.

Conceptually:

```txt
collection: "account"
id: singleton
```

Publicly it should feel like a singleton proxy:

```ts
vs.account.theme = "dark";
```

The account record also carries framework-local metadata, including the local schema version and the last server sequence applied locally. That metadata should be stored outside the public user-visible proxy.

## Collections

Collections represent many synced records.

Collections own create/delete-style operations:

```ts
todos.create(...);
todos.delete(id);
```

Direct record proxy mutation should also be allowed:

```ts
todos.records[id].title = "New title";
```

Both collection methods and direct proxy mutations feed into the same internal mutation and batching system.

## Device

`device` is a Valtio proxy persisted to `localStorage`.

It is:

```txt
local to this browser/device
not synced remotely
strictly schema-validated
```

The schema is passed as a plain field object. No explicit `z.object(...)` wrapper is required.

## Session

`session` is a Valtio proxy persisted to `sessionStorage`.

It is:

```txt
local to this browser tab/session
not synced remotely
strictly schema-validated
```

The schema is also passed as a plain field object.

## Memory-Only State

A built-in memory-only singleton does not need to be part of the framework. Developers can use normal Valtio state for that:

```ts
const localOnly = proxy({ ... });
```

## Local-Only Fields

Do not allow local-only fields inside synced records in v1.

Recommended rule:

```txt
collection records are strict
unknown keys are rejected
all collection fields are synced fields
```

Use these instead:

```txt
device      for per-device durable state
session     for per-tab/session durable state
plain proxy for memory-only state
```

This keeps schema alignment with the remote database clean.

## Serialization

Use JSON-only wire and cache formats for v1.

Supported:

```txt
string
number
boolean
null
arrays
plain objects
```

Avoid native `Date`, `BigInt`, `Map`, `Set`, class instances, and binary data in the v1 core.

Recommended conventions:

```txt
Date -> ISO string or epoch number
BigInt -> string
Decimal -> string
Binary -> app-managed URL/blob key
```

Zod validation should validate the serialized shape, not rich runtime objects.

## Relationships

Do not implement automatic cascades in the framework.

Recommended v1 rule:

```txt
application/server owns relational integrity
framework only syncs collection records
```

If a project delete should delete todos, the app handler or Drizzle helper handles that. The client may mark related cached collections/queries stale if configured, but the core should not infer foreign-key behavior automatically.

## Implementation Details

Device schema example:

```ts
device: {
  deviceId: z.string(),
  lastOpenedProjectId: z.string().nullable(),
}
```

Internally:

```ts
z.object(device).strict()
```

Session schema example:

```ts
session: {
  sidebarOpen: z.boolean(),
  draftSearch: z.string(),
}
```

Internally:

```ts
z.object(session).strict()
```

Store sync metadata outside the user-visible proxy, in a parallel metadata envelope:

```ts
type StoredRecord<T> = {
  id: string;
  data: T;
  meta: {
    dirty: boolean;
    deleted: boolean;
    serverVersion: number | null;
    baseServerVersion: number | null;
    updatedAtClient: number;
    updatedByDevice: string;
    lastSyncedAt: number | null;
    lastError?: SyncError;
  };
};
```

The proxy should expose only user fields:

```ts
todo.title = "New title";
```

Not:

```ts
todo._dirty;
todo._serverVersion;
```

For account metadata, physically store the schema version and last server sequence in the account store, but do not expose them through `vs.account` unless in debug/dev mode:

```ts
type StoredAccount<T> = {
  data: T;
  meta: {
    schemaVersion: number;
    lastServerSeq: number | null;
  };
};
```

Reserved underscore fields inside user proxies eventually create collisions, so framework metadata should stay out of public records.
