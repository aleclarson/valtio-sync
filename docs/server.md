# Server API

Import the server entrypoint:

```ts
import { rejectSync, valtioSync } from "valtio-sync/server";
```

Create a server with the same schema used by the client and export its handle method:

```ts
const syncServer = valtioSync({
  schema: { account, todos },
  getContext: async (request) => ({
    user: await requireUser(request),
  }),
  handlers: {
    account: {
      update: async ({ ctx, patch }) => {
        const row = await updateAccount(ctx.user.id, patch);
        return { serverVersion: row.version, record: row };
      },
    },
    todos: {
      readChanges: async ({ ctx, since }) => readTodoChanges(ctx.user.id, since),
      create: async ({ ctx, record }) => {
        const row = await insertTodo(ctx.user.id, record);
        return { serverVersion: row.version, record: row };
      },
      update: async ({ ctx, op, patch }) => {
        const row = await updateTodo(ctx.user.id, op.id, patch);
        return { serverVersion: row.version, record: row };
      },
      delete: async ({ ctx, op }) => {
        const version = await deleteTodo(ctx.user.id, op.id);
        return { serverVersion: version };
      },
    },
  },
});

export const POST = syncServer.handle;
```

`getContext` runs once per request. Put authentication, tenant lookup, and request-scoped dependencies there. Handlers receive `{ request, ctx }` plus operation-specific data.

Mutation handlers receive validated data:

- Account `update`: `{ op, patch }`.
- Collection `create`: `{ op, record }`.
- Collection `update`: `{ op, patch }`.
- Collection `delete`: `{ op }`.

Return `{ serverVersion, record? }`. Include `record` when the server canonicalizes, fills defaults, or wants the client to replace its local value with the server value.

Handlers should treat `op.mutationId` as the idempotency key for the authenticated user. This matters for retry after network failure, especially when an anonymous local cache is promoted during signup and the client sends many first-write create operations. A common implementation is a processed-mutations table keyed by user and mutation ID, or create/update handlers that can safely return the original accepted result when the same mutation is received again.

Use `readChanges` when you have a durable sequence or event log:

```ts
readChanges: async ({ ctx, since }) => ({
  serverSeq: await readLatestSeq(ctx.user.id),
  changes: {
    upserted: [
      { id: "todo_1", serverVersion: 12, record: { id: "todo_1", title: "Remote" } },
    ],
    deleted: [],
  },
});
```

Omit `mode` for normal incremental results. Incremental changes upsert and delete only
the listed records, leaving other local records alone.

Use `readSnapshot` when the server can only return a full snapshot:

```ts
readSnapshot: async ({ ctx }) => ({
  serverSeq: await readLatestVersion(ctx.user.id),
  changes: {
    upserted: (await readAllTodos(ctx.user.id)).map((row) => ({
      id: row.id,
      serverVersion: row.version,
      record: row,
    })),
    deleted: [],
  },
});
```

`readSnapshot` results are marked as `mode: "snapshot"` by the server handler. A
snapshot is authoritative for that collection: the client applies the listed
records, applies explicit deletes, then removes clean local records that are
missing from the snapshot. Dirty or rejected local records are preserved.

## Sync event retention

`valtio-sync` provides the protocol semantics for incremental changes and
authoritative snapshots. The application owns the server database schema,
retention window, cleanup jobs, and any per-client cursor tracking.

Treat a sync event table as a retained change feed, not as a permanent audit
log. Keep rows small:

```txt
sync_events
  account_id or user_id
  seq
  collection
  record_id
  op
  created_at
```

For upserts, `readChanges` can read the current application row by `record_id`.
For deletes, keep the delete event until it is past the retained floor, or fall
back to an authoritative snapshot for stale clients.

The simple retention model is:

```txt
keep events for 30-90 days, or keep the latest N events per account
record the oldest cursor that can still be answered from retained events
return mode: "snapshot" when since is older than that retained floor
```

When `readChanges` uses a retained event table, return an authoritative snapshot
if the client's `since` cursor is older than the retained floor. In
`readChanges`, `mode` belongs inside `changes`:

```ts
readChanges: async ({ ctx, since }) => {
  if (since !== null && since < await readRetainedFloorSeq(ctx.user.id)) {
    return {
      serverSeq: await readLatestSeq(ctx.user.id),
      changes: {
        mode: "snapshot",
        upserted: (await readAllTodos(ctx.user.id)).map((row) => ({
          id: row.id,
          serverVersion: row.version,
          record: row,
        })),
        deleted: [],
      },
    };
  }

  return {
    serverSeq: await readLatestSeq(ctx.user.id),
    changes: await readTodoChanges(ctx.user.id, since),
  };
};
```

For tighter cleanup, track active clients:

```txt
sync_clients
  account_id or user_id
  client_id
  last_server_seq
  last_seen_at
```

Update `sync_clients.last_server_seq` from the client's incoming
`lastServerSeq`, not from the new `serverSeq` being returned. The response might
not reach the client, so the next request is the first proof that the client
durably observed that cursor.

A cleanup job can delete events at or below the minimum `last_server_seq` for
active clients. Ignore clients whose `last_seen_at` is older than the offline
window your application supports, then rely on snapshot fallback if they return
later.

Reject an operation with an app-defined reason:

```ts
if (!canEdit(ctx.user, op.id)) {
  rejectSync("forbidden", "No edit permission");
}

if (op.baseServerVersion !== row.version) {
  rejectSync("conflict", "Base version is stale", {
    serverVersion: row.version,
    serverRecord: row,
  });
}
```

The server validates sync requests before calling handlers and validates returned changes before responding. Invalid operations are returned in `rejected` rather than crashing the whole sync request.
