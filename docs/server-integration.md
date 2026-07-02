# Server Integration

The client syncs with a single endpoint such as:

```txt
/api/sync
```

The client sends batched ops. The application is responsible for applying those ops to the actual database.

The framework should not own the server handler in the sense of owning application persistence. Instead, it should provide a server handler factory that handles protocol glue.

## Handler Responsibilities

The server helper should:

```txt
parse the request
validate ops
group ops by collection and op type
call application-provided handlers
validate returned data
format the response
return a fetch-compatible Response
```

The server handler should split by:

```txt
collection
op type
```

Where op types are:

```txt
read
create
update
delete
```

`account` is treated as one of the collections/op groups, but with singleton semantics.

## Application Responsibilities

The application decides:

```txt
which tables these map to
how auth works
how authorization works
how DB writes happen
how DB reads happen
what conflict policy applies
```

Server-side correctness checks are required because local client state cannot be trusted.

The app/backend remains responsible for:

```txt
auth
RBAC
tenancy
foreign-key ownership
field-level permissions
business invariants
```

## Validation

Validation should run on both client and server.

Client validation is for:

```txt
developer ergonomics
instant feedback
avoiding obviously invalid local state
```

Server validation is authoritative.

## Drizzle Helpers

The first common backend helper should probably target Drizzle.

Goals:

```txt
make it easier to keep local records aligned with database schema
reduce maintenance burden
provide a convenient default path
```

Drizzle helpers should remain optional. The framework should not require Drizzle, nor should it own the app's backend/database layer.

The ideal maintenance story is to keep local records aligned with the application's database schema. Drizzle is the first likely helper target.

## Server Sequence Source

Use one monotonically increasing `serverSeq` per user/account.

For each accepted mutation, write the actual app table change and a sync event in the same transaction.

Reason: this gives reliable multi-device pull without requiring every app table to have perfect timestamp semantics.

If an app does not want a sync event table, allow snapshot mode. The best Drizzle helper should use a sync event table.

## Implementation Details

Server entry point:

```ts
import { valtioSync } from "valtio-sync/server";
```

The server factory returns a fetch-compatible handler.

Example conceptual shape:

```ts
export const POST = valtioSync({
  schema: {
    account,
    todos,
    projects,
  },

  handlers: {
    account: {
      readChanges: async ({ ctx, since }) => ...,
      readSnapshot: async ({ ctx }) => ...,
      update: async ({ ctx, op, patch }) => ...,
    },

    todos: {
      readChanges: async ({ ctx, since }) => ...,
      readSnapshot: async ({ ctx }) => ...,
      create: async ({ ctx, op, record }) => ...,
      update: async ({ ctx, op, patch }) => ...,
      delete: async ({ ctx, op }) => ...,
    },
  },

  getContext: async (request) => ({
    user: await requireUser(request),
  }),
});
```

Potential Drizzle helper concept:

```ts
applyOpsWithDrizzle({
  db,
  syncEvents: {
    table: syncEvents,
    nextSeq: async ({ tx, ctx }) => ...,
    toRow: ({ ctx, collection, recordId, op, seq }) => ({
      userId: ctx.user.id,
      seq,
      collection,
      recordId,
      op,
    }),
  },
  handlers,
  authorize: async ({ ctx, collection, op }) => ...,
  checkConflict: async ({ tx, ctx, collection, op }) => ...,
});
```

Recommended helper table:

```txt
sync_events
  user_id
  seq
  collection
  record_id
  op
  created_at
```
