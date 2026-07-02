# Client API

Import the browser/client entrypoint:

```ts
import { valtioSync } from "valtio-sync/client";
```

Create a client with an endpoint, namespace, and schema:

```ts
const sync = valtioSync({
  endpoint: "/api/sync",
  namespace: `my-app:${user.id}`,
  schema: { account, todos },
});

await sync.ready;
```

`namespace` separates local IndexedDB, local storage, session storage, and BroadcastChannel state. Use a stable per-user namespace when multiple users can sign into the same browser.

The returned object exposes:

- `account`: synced singleton account proxy.
- `collections`: named collection APIs.
- `device`: local-only proxy stored in `localStorage`.
- `session`: local-only proxy stored in `sessionStorage`.
- `status`: Valtio proxy with hydration, sync, dirty, online, and error state.
- `ready`: hydration promise.
- `flush()`: wait for pending local writes and recompute pending ops.
- `sync()`: flush and POST pending ops to the configured endpoint.
- `clearLocalData()` and `reset()`: clear local sync, device, and session state.
- `clearCollection(collection)`: clear one collection from local storage.
- `close()`: unsubscribe listeners, timers, channels, and storage handles.

Collection APIs expose:

```ts
const todo = sync.collections.todos.create({ id: "todo_1", title: "Ship" });
sync.collections.todos.update("todo_1", { completed: true });
sync.collections.todos.records.todo_1.title = "Ship v1";
sync.collections.todos.delete("todo_1");

sync.collections.todos.get("todo_1");
sync.collections.todos.list();
await sync.collections.todos.flush();
await sync.collections.todos.sync();
```

Direct proxy mutations and collection helper calls both become dirty sync operations. Local writes are batched briefly; call `flush()` before tests or before inspecting `debug.getPendingOps()`.

Client options include:

- `schemaVersion` and `migrations` for local cache migrations.
- `conflict` is reserved for conflict mode. The current v1 runtime behavior is `rejectStale`.
- `fetch` for tests, non-browser runtimes, or custom request behavior.
- `storage`, `localStorage`, `sessionStorage`, and `indexedDB` for tests or custom environments.
- `broadcast: false` to disable cross-tab local cache notifications.

`debug` is intended for tests and diagnostics:

```ts
sync.debug.getStatus();
sync.debug.getPendingOps();
sync.debug.getDirtyRecords();
sync.debug.getRecordMeta(sync.collections.todos, "todo_1");
sync.debug.getLastSyncRequest();
sync.debug.getLastSyncResponse();
```

Do not store secrets in synced records, `device`, or `session`. Browser storage and IndexedDB are persistence mechanisms, not secure storage.
