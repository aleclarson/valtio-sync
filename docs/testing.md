# Testing

Use memory storage to avoid IndexedDB and browser storage in unit tests:

```ts
import {
  createMemorySyncStorage,
  createMemoryWebStorage,
  valtioSync,
} from "valtio-sync/client";

const sync = valtioSync({
  endpoint: "/api/sync",
  schema: { account, todos },
  storage: createMemorySyncStorage(),
  localStorage: createMemoryWebStorage(),
  sessionStorage: createMemoryWebStorage(),
  fetch: async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    return Response.json({
      serverSeq: 1,
      accepted: request.ops.map((op) => ({
        mutationId: op.mutationId,
        collection: op.collection,
        id: op.id,
        serverVersion: 1,
      })),
      rejected: [],
      changes: {},
    });
  },
});

await sync.ready;
```

Call `flush()` before inspecting pending operations:

```ts
sync.collections.todos.create({ id: "todo_1", title: "Draft" });
await sync.flush();

expect(sync.debug.getPendingOps()).toMatchObject([
  { collection: "todos", type: "create", id: "todo_1" },
]);
```

When using fake timers, advance the local write batch window before `flush()`:

```ts
vi.useFakeTimers();

sync.collections.todos.records.todo_1.title = "Changed";
await vi.advanceTimersByTimeAsync(100);
await sync.flush();
```

Test server handlers by calling the returned server's handle method with a `Request`:

```ts
import { valtioSync } from "valtio-sync/server";

const syncServer = valtioSync({
  schema: { account, todos },
  handlers: {
    todos: {
      create: ({ record }) => ({ serverVersion: 1, record }),
    },
  },
});

const response = await syncServer.handle(
  new Request("https://app.test/api/sync", {
    method: "POST",
    body: JSON.stringify({
      clientId: "device_1",
      schemaVersion: 1,
      lastServerSeq: null,
      ops: [
        {
          mutationId: "m1",
          collection: "todos",
          type: "create",
          id: "todo_1",
          value: { id: "todo_1", title: "Local" },
          touched: ["id", "title"],
        },
      ],
    }),
  }),
);
```

Use `debug.getLastSyncRequest()` and `debug.getLastSyncResponse()` for end-to-end sync assertions.
