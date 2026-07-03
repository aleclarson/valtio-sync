# Drizzle Helper

Install Drizzle when you want the optional helper:

```sh
pnpm add drizzle-orm
```

Import from the Drizzle entrypoint:

```ts
import { $type, applyOpsWithDrizzle, defineAccount, defineCollection } from "valtio-sync/drizzle";
import { valtioSync } from "valtio-sync/server";
```

## Type-checked schema definitions

The Drizzle entrypoint provides schema definition wrappers that check your Zod
field map against a Drizzle table's selected row shape:

```ts
import { $type, defineAccount, defineCollection } from "valtio-sync/drizzle";
import { z } from "zod";
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

The `dbType` marker is compile-time only. At runtime the wrappers create the
same schema definitions as `valtio-sync/schema`.

Field keys must exactly match `typeof table.$inferSelect`, and each Zod output
type must be assignable to the matching Drizzle selected value type. Narrower
schemas are allowed, such as a Zod enum for a `string` column. Wider schemas are
rejected, such as a nullable Zod field for a non-null Drizzle column.

## Mutation handlers

`applyOpsWithDrizzle` wraps mutation handlers in a transaction, runs optional authorization and conflict hooks, writes a sync event row, and returns server handlers for `valtioSync`.

```ts
const handlers = applyOpsWithDrizzle({
  db,
  syncEvents: {
    write: async ({ tx, ctx, collection, recordId, op }) => {
      const [event] = await tx
        .insert(syncEvents)
        .values({
          userId: ctx.user.id,
          collection,
          recordId,
          op,
        })
        .returning({ seq: syncEvents.seq });

      return event.seq;
    },
  },
  authorize: async ({ ctx, collection, op }) => {
    await assertCanSync(ctx.user, collection, op);
  },
  checkConflict: async ({ tx, ctx, collection, op }) => {
    await assertFreshBaseVersion(tx, ctx.user.id, collection, op);
  },
  handlers: {
    todos: {
      readChanges: async ({ ctx, since }) => readTodoChanges(ctx.user.id, since),
      create: async ({ tx, ctx, record }) => {
        const row = await insertTodo(tx, ctx.user.id, record);
        return { record: row };
      },
      update: async ({ tx, ctx, op, patch }) => {
        const row = await updateTodo(tx, ctx.user.id, op.id, patch);
        return { record: row };
      },
      delete: async ({ tx, ctx, op }) => {
        await deleteTodo(tx, ctx.user.id, op.id);
        return {};
      },
    },
  },
});

const syncServer = valtioSync({
  schema: { account, todos },
  getContext: async (request) => ({ user: await requireUser(request) }),
  handlers,
});

export const POST = syncServer.handle;
```

If a mutation handler omits `serverVersion`, the helper uses the sequence returned by `syncEvents.write`. Return a specific `serverVersion` only when your table already has a better per-record version.

`syncEvents.write` owns the sync event insert, so it can rely on an auto-generated identity or serial column and return the inserted row's `seq`. A global monotonically increasing sequence is fine when `readChanges` filters by account/user and reads events with `seq > since`.

If your application reserves the sequence before inserting the event, use the compatibility shape:

```ts
syncEvents: {
  table: syncEvents,
  nextSeq: async ({ tx, ctx }) => reserveNextSeq(tx, ctx.user.id),
  toRow: ({ ctx, collection, recordId, op, seq }) => ({
    userId: ctx.user.id,
    seq,
    collection,
    recordId,
    op,
  }),
}
```

The helper expects a Drizzle-like `db` with `transaction` and an `insert(table).values(row)` shape for the compatibility path. If `transaction` is unavailable, the callback runs directly against `db`.

Read operations are passed through unchanged. Keep `readChanges` and `readSnapshot` responsible for shaping `CollectionChanges` from your sync event table or application tables.

## Sync event retention

The Drizzle helper writes events, but it does not own your retention policy.
Your application should treat `sync_events` as a retained change feed, not as a
permanent audit log. A typical table is intentionally small:

```txt
sync_events
  user_id or account_id
  seq
  collection
  record_id
  op
  created_at
```

Index it for the way `readChanges` reads:

```txt
(user_id, seq)
```

or, for account-scoped apps:

```txt
(account_id, seq)
```

For upserts, the event can point to the current application row. For deletes,
the event itself is the tombstone until it is pruned.

The simplest cleanup strategy is a retained floor per user or account:

```txt
sync_retention
  user_id or account_id
  pruned_through_seq
```

When a cleanup job deletes events through sequence `100`, update
`pruned_through_seq` to `100` in the same job. If a client later asks for
changes from before that floor, return an authoritative snapshot:

```ts
readChanges: async ({ ctx, since }) => {
  const floor = await readRetainedFloorSeq(ctx.user.id);

  if (since !== null && since < floor) {
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

  return readTodoChanges(ctx.user.id, since);
};
```

For more precise cleanup, track active clients:

```txt
sync_clients
  user_id or account_id
  client_id
  last_server_seq
  last_seen_at
```

On each authenticated sync request, update `last_server_seq` from the client's
incoming `lastServerSeq`. Do not advance it to the `serverSeq` you are about to
return, because the response might fail before the client stores it. A cleanup
job can prune events at or below the minimum `last_server_seq` across active
clients. Treat clients older than your supported offline window as inactive and
let snapshot fallback repair their clean local cache if they return.
