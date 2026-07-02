# Server API

Import the server entrypoint:

```ts
import { rejectSync, valtioSync } from "valtio-sync/server";
```

Create a POST handler with the same schema used by the client:

```ts
export const POST = valtioSync({
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
