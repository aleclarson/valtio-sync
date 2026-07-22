# Mutation Lifecycle

Direct proxy mutations and collection methods should feed into the same internal mutation, dirty-state, persistence, and batching system.

Allowed direct proxy mutation:

```ts
todos.records[id].title = "New title";
todos.records[id].completed = true;
```

Allowed collection-based mutations:

```ts
todos.create(...);
todos.delete(id);
```

## Dirty State

The preferred simple model is no separate offline operation queue.

Instead:

```txt
local records become dirty
dirty records are persisted locally
sync sends current dirty state/ops later
```

This keeps the system state-based rather than operation-log-based.

Earlier framing:

```txt
CRDTs merge operations
LWW merges state
```

Since this framework does not need realtime sync or an operation queue, CRDTs are not needed for the core design.

## Batching

The framework should track touched records/fields and batch mutations.

Batching rule:

```txt
all mutations are batched with setTimeout(..., 100)
```

This includes:

```txt
direct record proxy mutations
collection-based creates
collection-based deletes
```

Useful flush moments:

```txt
manual sync
page hide / app background
before navigation when possible
logout
explicit flush()
```

## Deletes

Deletes go through collections:

```ts
todos.delete(id);
```

Tombstones are the simplest way to avoid deleted records coming back from another device. Whether the backend stores tombstones, hard-deletes, or soft-deletes is ultimately application-owned.

The framework/helper should support a delete op and leave persistence strategy to the app or helper.

## Defaults and Generated Columns

Recommended rule:

```txt
local defaults are for local UX
server defaults are authoritative
defaulted-but-untouched fields are omitted from create ops
explicitly touched fields are sent, even if equal to the default
```

This means the client must track touched fields during creation.

After server create, the server should return the canonical record.

## Retry Behavior

Recommended behavior:

```txt
network error:
  keep dirty
  retry later

server 500:
  keep dirty
  retry with backoff

auth error:
  pause sync
  surface auth error
  do not keep hammering endpoint

validation/forbidden rejection:
  mark rejected
  do not retry until local record changes

conflict rejection:
  mark conflict
  do not retry until app/user resolves or local record changes
```

Recommended retry triggers:

```txt
manual vs.sync()
manual vs.flush()
window online event
visibilitychange to visible
new local mutation
periodic retry while dirty, with backoff
```

Use exponential backoff with jitter for automatic retries.

## Implementation Details

Compact aggressively before sending:

```txt
update + update
  -> one update with final patch

create + update
  -> one create with final value

create + delete before sync
  -> drop both; send nothing

update + delete
  -> one delete

delete + update
  -> invalid; throw or treat as recreate only through explicit create

delete + create same id
  -> disallow by default
```

Default handling example:

```ts
fields: {
  completed: z.boolean().default(false),
}
```

If the user never touches `completed`, insert omits it.

If the user explicitly sets:

```ts
todo.completed = false;
```

then the insert sends:

```ts
{ completed: false }
```

Possible local/server delete representation:

```ts
deleted: boolean
```
