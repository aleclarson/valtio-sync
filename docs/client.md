# Client API

Import the browser/client entrypoint:

```ts
import { valtioSync } from 'valtio-sync/client'
```

Create a client with an endpoint and schema, then explicitly activate its local persistence:

```ts
const sync = valtioSync({
  endpoint: '/api/sync',
  schema: { account, todos },
  storage: { namespace: `my-app:${user.id}` },
})

await sync.hydrate()
```

The storage adapter's `namespace` separates local IndexedDB, local storage, session storage, and
BroadcastChannel state. Use a stable per-user namespace when multiple users can sign into the same
browser. Constructing the client does not open or read storage.

The returned object exposes:

- `account`: synced singleton account proxy.
- one direct property for each named collection in the schema.
- `device`: local-only proxy stored in `localStorage`.
- `session`: local-only proxy stored in `sessionStorage`.
- `status`: Valtio proxy with `cold`, `hydrating`, `ready`, or `closed` phase plus sync, dirty,
  online, and error state.
- `hydrate()`: activate the constructor-provided default adapter.
- `hydrate(adapter)`: replace local persistence with another adapter.
- `flush()`: wait for pending local writes and recompute pending ops.
- `sync()`: flush and POST pending ops to the configured endpoint.
- `interceptTransport(interceptor)`: intercept protocol requests before they reach `fetch`.
- `adoptLocalData(source, options)`: copy local synced state from another client, usually from an anonymous namespace into a new authenticated namespace.
- `clearLocalData()` and `reset()`: clear local sync, device, and session state.
- `clearCollection(collection)`: clear one collection from local storage.
- `close()`: unsubscribe listeners, timers, channels, and storage handles.

Collection APIs expose:

```ts
const todo = sync.todos.create({ id: 'todo_1', title: 'Ship' })
sync.todos.update('todo_1', { completed: true })
sync.todos.records.todo_1.title = 'Ship v1'
sync.todos.delete('todo_1')

sync.todos.get('todo_1')
sync.todos.list()
await sync.todos.flush()
await sync.todos.sync()
```

Collection names cannot collide with built-in client properties such as `account`, `device`,
`hydrate`, `sync`, or `debug`.

Direct proxy mutations and collection helper calls both become dirty sync operations. Local writes are batched briefly; call `flush()` before tests or before inspecting `debug.getPendingOps()`.

Local persistence is automatic, but remote sync starts only when the application calls `sync()`.
Failed network syncs retry automatically; creating dirty state alone does not schedule a remote
request. See [Sync Lifecycle](sync-lifecycle.md) for the complete timing, retry, and freshness
model.

## Transport Interception

`interceptTransport()` installs scoped middleware around future sync attempts. The interceptor
receives the complete protocol request and a `next` transport function:

```ts
const removeInterceptor = sync.interceptTransport((request, next) => {
  if (developmentScenarioActive) {
    return fixtureTransport(request)
  }
  return next(request)
})

// Later:
removeInterceptor()
```

An interceptor can:

- call `next(request)` to pass through;
- call `next({ ...request, ops: [] })` with a modified request to allow remote reads without
  sending local writes;
- return a synthetic `SyncResponse` to replace remote reads and acknowledgements; or
- return `null` to drop the entire attempt without treating it as a transport failure.

Dropping or removing writes from a request does not clear their dirty metadata. They remain in
local persistence and can be uploaded by a later unintercepted sync. Returning a synthetic
acknowledgement processes it exactly like a server acknowledgement and may clear matching dirty
operations.

For launchable development fixtures, keep the real client but activate write protection before
switching to isolated memory storage:

```ts
const removeWriteProtection = sync.interceptTransport(preventRemoteWrites)
await sync.hydrate(createMemoryStorageAdapter({ namespace: `my-app:scenario:${scenarioId}` }))

try {
  installScenarioState(sync)
} finally {
  await sync.hydrate()
  removeWriteProtection()
}
```

`preventRemoteWrites` forwards a request with no operations, so ordinary remote pulls still work
without pretending that fixture writes were acknowledged. Those writes remain realistically dirty
inside the memory adapter and are discarded from the active client when the default adapter is
hydrated again. Return to the default adapter before removing protection; a storage namespace
isolates local state, not server authentication.

Installing or removing an interceptor affects future sync attempts; an already running request
keeps the interceptor chain with which it started. The returned removal function is idempotent.

## Explicit Hydration and Context Replacement

`hydrate()` is the persistence boundary. The client requires a default adapter at construction,
but does not open or read it until `hydrate()` is called. Hydration must be awaited before collection
mutations, `flush()`, `sync()`, pruning, clearing, or adoption. An adapter with only a namespace uses
IndexedDB and browser storage:

```ts
const sync = valtioSync({
  endpoint,
  schema,
  storage: { namespace: `my-app:${user.id}` },
})
await sync.hydrate()
```

Calling `hydrate()` again settles queued writes, reconciliation, active synchronization, retries,
and broadcast activity before replacing the live account, collections, device, session, and sync
metadata with fresh objects. Passing an adapter activates that context; calling `hydrate()` without
an argument always activates the constructor-provided default. `hydrate()` always resolves to
`undefined`.

Before the first hydration, the public state contains inert schema defaults and empty collections.
Direct writes are ignored, persisted async operations reject, and collection mutators throw.
Applications must not render this state as authoritative. During a replacement, the public state is
inert again; synchronous mutations throw while async persisted operations queue behind a transition
from an already-ready client. Use `status.phase` to gate rendering and interaction.

If destination hydration fails, the previous context remains active, although preparing the failed
destination may have modified its storage. A storage adapter and its explicit `SyncStorage` object
can belong to only one live client. The owner may reactivate them, and `close()` releases ownership.

## Bounded Local Replicas

`collection.pruneLocal(ids)` evicts application-selected records from the local cache without creating server delete operations or changing the sync cursor. The client refuses to evict dirty creates, updates, pending deletes, and records with rejection or conflict metadata. There is no force option.

```ts
const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000
const oldOrderIds = sync.orders
  .list()
  .filter((order) => order.orderedAt < cutoff)
  .map((order) => order.id)

const report = await sync.orders.pruneLocal(oldOrderIds)
```

The report separates `eligible`, `evicted`, `missing`, and `protected` IDs. Pass `{ dryRun: true }` to run the same safety checks without writing.

Retention and relationship policies stay in application code. Prune related collections in dependency order, deriving each stage from records actually retained by the previous stage:

```ts
await sync.orders.pruneLocal(oldOrderIds)
const retainedProductVersionIds = new Set(
  sync.orders.list().flatMap((order) => order.productVersionIds),
)
await sync.productVersions.pruneLocal(
  sync.productVersions
    .list()
    .filter((version) => !version.current && !retainedProductVersionIds.has(version.id))
    .map((version) => version.id),
)
```

This preserves dependencies referenced by a record that was protected from pruning. A crash between stages only leaves extra cache data. Persistent storage is updated before reactive state, and compare-and-delete semantics preserve a newer concurrent tab mutation. Initial and stale-cursor authoritative snapshots remain the correctness fallback and may repopulate records still in server scope.

## Anonymous Signup Promotion

Use a stable anonymous namespace before signup:

```ts
const anonymousSync = valtioSync({
  endpoint: '/api/sync',
  schema: { account, todos },
  storage: { namespace: `my-app:anon:${anonymousId}` },
})
await anonymousSync.hydrate()
```

After signup succeeds and the request context is authenticated, create the new account client and adopt the anonymous local data:

```ts
const userSync = valtioSync({
  endpoint: '/api/sync',
  schema: { account, todos },
  storage: { namespace: `my-app:user:${user.id}` },
})
await userSync.hydrate()

await userSync.adoptLocalData(anonymousSync, {
  sync: true,
  clearSource: 'afterSuccessfulSync',
})
```

Adoption is intentionally a new-account flow. The target namespace must not already have synced account state or cached records. Imported collection records become dirty create operations, imported account state becomes a dirty account update, and the normal sync endpoint writes the data under the authenticated server context. Local-only `device` and `session` state are copied by default; pass `copyLocalState: false` or `{ device: true, session: false }` to change that.

The source namespace is cleared only when `sync: true` is used, the sync finishes without dirty state or errors, and `clearSource: "afterSuccessfulSync"` is set. If the upload fails, the anonymous source cache remains available.

Client options include:

- `schemaVersion` and `migrations` for local cache migrations.
- `conflict` is reserved for conflict mode. The current v1 runtime behavior is `rejectStale`.
- `fetch` for tests, non-browser runtimes, or custom request behavior.

Storage adapter options passed to the constructor or `hydrate(adapter)` include `namespace`, `storage`, `localStorage`,
`sessionStorage`, `indexedDB`, and `broadcast`. Use `createMemoryStorageAdapter()` for a complete
isolated adapter in tests and development scenarios.

## Migrating from Automatic Hydration

`ready` and the old split persistence constructor options were removed. Group the namespace and
custom persistence configuration in the required default adapter, then hydrate explicitly:

```ts
// Before
const sync = valtioSync({ endpoint, schema, namespace, storage: syncStorage })
await sync.ready

// After
const sync = valtioSync({
  endpoint,
  schema,
  storage: { namespace, storage: syncStorage },
})
await sync.hydrate()
```

Application startup must await `hydrate()` before exposing mutation controls or starting remote
sync triggers. Development-scenario cleanup returns to the default by awaiting `hydrate()` again.

`debug` is intended for tests and diagnostics:

```ts
sync.debug.getStatus()
sync.debug.getPendingOps()
sync.debug.getDirtyRecords()
sync.debug.getRecordMeta(sync.todos, 'todo_1')
sync.debug.getLastSyncRequest()
sync.debug.getLastSyncResponse()
```

Do not store secrets in synced records, `device`, or `session`. Browser storage and IndexedDB are persistence mechanisms, not secure storage.
