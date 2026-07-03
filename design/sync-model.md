# Sync Model

The local database is a durable SWR cache plus optimistic local writes.

Useful mental model:

```txt
client_seq = last server sequence applied locally
server_seq = latest sequence available remotely

if server_seq > client_seq:
  local cache is stale
```

Stale does not automatically mean overwrite local state.

Rows can be conceptually in states like:

```txt
clean + current
clean + stale
dirty + current-ish
dirty + stale
```

For dirty + stale records, the application/helper needs a conflict policy.

## Pull Model

Use `lastServerSeq` as the main pull cursor.

Every sync request should include:

```txt
lastServerSeq
ops
```

Every response should include:

```txt
serverSeq
changes
```

The client applies remote changes only when local records are clean. If a remote change overlaps a dirty local record, mark it as a conflict/stale condition and let the configured conflict policy decide.

## Read Semantics

Define `read` as "read changes since lastServerSeq," not arbitrary query reads.

Recommended v1:

```txt
primary: readChanges
fallback: readSnapshot
```

The client can tolerate either normalized response. Incremental changes are the
default. Snapshot changes are authoritative for clean local collection records,
which lets servers prune old event rows and fall back to a full snapshot when a
client's cursor is older than the retained event floor.

## Conflict Policy

Default to `rejectStale`, not last-write-wins.

Reason: for transparent save state, silent overwrites are more surprising than a visible sync conflict.

Supported policies:

```ts
conflict: "rejectStale" | "lww" | "serverWins" | "custom"
```

Recommended helper semantics:

```txt
rejectStale:
  if baseServerVersion !== currentServerVersion:
    reject with conflict

lww:
  compare updatedAtClient + updatedByDevice

serverWins:
  reject local stale value and return canonical server record

custom:
  app/helper callback decides
```

For v1, `rejectStale` plus app-visible conflict metadata is safest.

## Acknowledgements and Rejections

Accepted ops:

```txt
clear dirty
clear error
update serverVersion/baseServerVersion
update lastSyncedAt
apply canonical returned record if provided
```

Rejected ops should not silently rollback by default.

Recommended rejected behavior:

```txt
mark record as rejected
store error metadata
keep local optimistic value visible
stop retrying that mutation until the user changes the record again
```

Expose this through status/debug APIs, not by polluting the user record.

For destructive failures like `forbidden` after logout/user switch, app code can choose to clear or refetch.

## Invalidation

Server responses should probably not directly control invalidation.

Reason:

```txt
the client knows which records/queries it has cached
the client can invalidate more precisely
```

Better model:

```txt
server returns facts
client decides what cached state becomes stale
```

For simple correctness, the client can initially invalidate coarsely:

```txt
changed collection todos -> invalidate cached todos-derived reads/queries
```

More precise invalidation can come later.

## Server Patches

General server patches are probably not the right model.

No realtime sync means the framework does not need a server-driven patch stream.

Preferred model:

```txt
manual invalidation
refetch stale records/collections/queries
sync dirty local state
```

Mutation acknowledgement may still return canonical records when useful.

For example, the server may need to return:

```txt
server-generated IDs
server sequence
normalized values
createdAt / updatedAt fields
accepted/rejected status
```

That is an acknowledgement/refetch result, not a generalized patch system.

## Implementation Details

Example app-visible sync state:

```ts
vs.getSyncState(todos, id);
// {
//   status: "rejected",
//   reason: "validation",
//   message: "..."
// }
```

Recommended server handler read groups:

```ts
handlers: {
  todos: {
    readChanges: async ({ ctx, since }) => ...,
    create: async (...) => ...,
    update: async (...) => ...,
    delete: async (...) => ...,
  }
}
```

For simpler apps, allow a full snapshot fallback:

```ts
readSnapshot: async ({ ctx }) => ...
```

Server can return facts like:

```ts
{
  serverSeq: 123,
  accepted: [...],
  rejected: [...],
  changed: {
    todos: ["todo_1", "todo_2"],
    account: ["singleton"],
  },
}
```

Client request:

```ts
type SyncRequest = {
  clientId: string;
  schemaVersion: number;
  lastServerSeq: number | null;
  ops: SyncOp[];
};
```

Ops:

```ts
type SyncOp =
  | {
      mutationId: string;
      collection: string;
      type: "create";
      id: string;
      value: Record<string, unknown>;
      touched: string[];
    }
  | {
      mutationId: string;
      collection: string;
      type: "update";
      id: string;
      patch: Record<string, unknown>;
      touched: string[];
      baseServerVersion: number | null;
    }
  | {
      mutationId: string;
      collection: string;
      type: "delete";
      id: string;
      baseServerVersion: number | null;
    };
```

Server response:

```ts
type SyncResponse = {
  serverSeq: number;

  accepted: Array<{
    mutationId: string;
    collection: string;
    id: string;
    serverVersion: number;
    record?: Record<string, unknown>;
  }>;

  rejected: Array<{
    mutationId: string;
    collection: string;
    id: string;
    reason:
      | "validation"
      | "forbidden"
      | "conflict"
      | "not_found"
      | "server_error";
    message?: string;
    serverRecord?: Record<string, unknown>;
    serverVersion?: number;
  }>;

  changes: Record<
    string,
    {
      mode?: "changes" | "snapshot";
      upserted: Array<{
        id: string;
        serverVersion: number;
        record: Record<string, unknown>;
      }>;
      deleted: Array<{
        id: string;
        serverVersion: number;
      }>;
    }
  >;
};
```

Earlier protocol sketch used the same general direction:

```ts
{
  clientId: string;
  lastSeenServerSeq: number | null;
  ops: SyncOp[];
}
```

The important direction is:

```txt
server returns facts and acknowledgements
client handles local cache invalidation/refetch
application owns DB semantics
```
