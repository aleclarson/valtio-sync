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
- one direct property for each named collection in the schema.
- `device`: local-only proxy stored in `localStorage`.
- `session`: local-only proxy stored in `sessionStorage`.
- `status`: Valtio proxy with hydration, sync, dirty, online, and error state.
- `ready`: hydration promise.
- `flush()`: wait for pending local writes and recompute pending ops.
- `sync()`: flush and POST pending ops to the configured endpoint.
- `adoptLocalData(source, options)`: copy local synced state from another client, usually from an anonymous namespace into a new authenticated namespace.
- `clearLocalData()` and `reset()`: clear local sync, device, and session state.
- `clearCollection(collection)`: clear one collection from local storage.
- `close()`: unsubscribe listeners, timers, channels, and storage handles.

Collection APIs expose:

```ts
const todo = sync.todos.create({ id: "todo_1", title: "Ship" });
sync.todos.update("todo_1", { completed: true });
sync.todos.records.todo_1.title = "Ship v1";
sync.todos.delete("todo_1");

sync.todos.get("todo_1");
sync.todos.list();
await sync.todos.flush();
await sync.todos.sync();
```

Collection names cannot collide with built-in client properties such as `account`, `device`,
`ready`, `sync`, or `debug`.

Direct proxy mutations and collection helper calls both become dirty sync operations. Local writes are batched briefly; call `flush()` before tests or before inspecting `debug.getPendingOps()`.

## Bounded Local Replicas

`collection.pruneLocal(ids)` evicts application-selected records from the local cache without creating server delete operations or changing the sync cursor. The client refuses to evict dirty creates, updates, pending deletes, and records with rejection or conflict metadata. There is no force option.

```ts
const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
const oldOrderIds = sync.orders
  .list()
  .filter((order) => order.orderedAt < cutoff)
  .map((order) => order.id);

const report = await sync.orders.pruneLocal(oldOrderIds);
```

The report separates `eligible`, `evicted`, `missing`, and `protected` IDs. Pass `{ dryRun: true }` to run the same safety checks without writing.

Retention and relationship policies stay in application code. Prune related collections in dependency order, deriving each stage from records actually retained by the previous stage:

```ts
await sync.orders.pruneLocal(oldOrderIds);
const retainedProductVersionIds = new Set(
  sync.orders.list().flatMap((order) => order.productVersionIds),
);
await sync.productVersions.pruneLocal(
  sync.productVersions
    .list()
    .filter(
      (version) => !version.current && !retainedProductVersionIds.has(version.id),
    )
    .map((version) => version.id),
);
```

This preserves dependencies referenced by a record that was protected from pruning. A crash between stages only leaves extra cache data. Persistent storage is updated before reactive state, and compare-and-delete semantics preserve a newer concurrent tab mutation. Initial and stale-cursor authoritative snapshots remain the correctness fallback and may repopulate records still in server scope.

## Anonymous Signup Promotion

Use a stable anonymous namespace before signup:

```ts
const anonymousSync = valtioSync({
  endpoint: "/api/sync",
  namespace: `my-app:anon:${anonymousId}`,
  schema: { account, todos },
});
```

After signup succeeds and the request context is authenticated, create the new account client and adopt the anonymous local data:

```ts
const userSync = valtioSync({
  endpoint: "/api/sync",
  namespace: `my-app:user:${user.id}`,
  schema: { account, todos },
});

await userSync.adoptLocalData(anonymousSync, {
  sync: true,
  clearSource: "afterSuccessfulSync",
});
```

Adoption is intentionally a new-account flow. The target namespace must not already have synced account state or cached records. Imported collection records become dirty create operations, imported account state becomes a dirty account update, and the normal sync endpoint writes the data under the authenticated server context. Local-only `device` and `session` state are copied by default; pass `copyLocalState: false` or `{ device: true, session: false }` to change that.

The source namespace is cleared only when `sync: true` is used, the sync finishes without dirty state or errors, and `clearSource: "afterSuccessfulSync"` is set. If the upload fails, the anonymous source cache remains available.

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
sync.debug.getRecordMeta(sync.todos, "todo_1");
sync.debug.getLastSyncRequest();
sync.debug.getLastSyncResponse();
```

Do not store secrets in synced records, `device`, or `session`. Browser storage and IndexedDB are persistence mechanisms, not secure storage.
