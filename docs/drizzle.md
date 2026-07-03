# Drizzle Helper

Install Drizzle when you want the optional helper:

```sh
pnpm add drizzle-orm
```

Import from the Drizzle entrypoint:

```ts
import { applyOpsWithDrizzle } from "valtio-sync/drizzle";
import { valtioSync } from "valtio-sync/server";
```

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

export const POST = valtioSync({
  schema: { account, todos },
  getContext: async (request) => ({ user: await requireUser(request) }),
  handlers,
});
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
