# Local Persistence

The local database is a durable SWR cache plus optimistic local writes.

The client should expose state quickly from local cache. Remote sync should not block initial render.

The implemented client exposes `vs.ready` for code that needs to wait until local hydration, migration, and validation are complete.

## Storage Responsibilities

Synced and cached data should use IndexedDB.

Recommended storage layout:

```txt
one IndexedDB store for account
one IndexedDB store per collection
```

Example:

```txt
account
collection:todos
collection:projects
```

`device` state is persisted to `localStorage`.

`session` state is persisted to `sessionStorage`.

## Local-First Boot

Use a local-first boot lifecycle:

```txt
1. create proxies with defaults
2. load device from localStorage
3. load session from sessionStorage
4. open IndexedDB
5. read account + collection caches
6. run local migrations if needed
7. validate cached data
8. hydrate proxies without mutation tracking
9. mark client as hydrated
10. optionally start background sync
```

Internal framework writes, such as hydration, refetch, or acknowledgement application, must not themselves create dirty mutations.

## Migrations

Migrations apply to local persisted state:

```txt
account cache
collection caches
device state
session state
```

Remote database migrations remain the application's responsibility.

Use linear ordered migrations for v1. A migration key means "the migration that produces schema version N."

For example, when the current local version is `1` and the target version is `3`, run migration `2`, then migration `3`.

No explicit `fromVersion` parameter is needed unless non-linear migrations are introduced later.

## Multi-Tab Behavior

Use `BroadcastChannel` in v1.

Do not build complex leader election initially.

Recommended behavior:

```txt
each tab may mutate
each tab writes to IndexedDB
each tab broadcasts local changes
other tabs re-read affected records from IndexedDB
server handles idempotency/conflicts
```

Every op should have a stable mutation ID so accidental duplicate sends are safe. If duplicate sync traffic becomes a problem later, add optional leader election.

## User Switching and Logout

Require a cache namespace.

IndexedDB, `localStorage`, and `sessionStorage` keys should include the namespace.

On logout, provide an explicit local data clearing API.

Recommended behavior:

```txt
logout without clearLocalData:
  stop syncing and detach auth-sensitive state

logout with clearLocalData:
  delete account + collections + device/session state for namespace
```

Default docs should strongly recommend clearing local data on shared devices.

## Anonymous to New Account Promotion

Anonymous usage should use a stable local namespace, such as:

```txt
my-app:anon:<anonymous-id>
```

After signup creates an authenticated account, the app should create a client for the new account namespace:

```txt
my-app:user:<user-id>
```

The client may adopt the anonymous namespace's local data into that new account namespace. This is a new-account flow, not an existing-account merge flow.

Recommended behavior:

```txt
target namespace must not already have synced account state or cached records
collection records are imported as dirty create state
account state is imported as a dirty account update
lastServerSeq is reset to null
serverVersion/baseServerVersion are reset to null
device/session state may be copied for UX continuity, but is never synced
anonymous source data is cleared only after explicitly requested successful authenticated sync
```

The sync protocol should not carry anonymous identity or user identity for this flow. Server ownership still comes from authenticated request context.

## Security and Privacy

Document clearly:

```txt
IndexedDB, localStorage, and sessionStorage are not secure storage
do not store secrets in valtio-sync state
clear local data on logout when appropriate
```

The framework should support clearing all local namespace data, clearing a collection, and resetting in-memory/local state.

## Implementation Details

No `_protocolVersion` is needed for now.

If the protocol or storage format changes significantly later, versioning can be handled by appending the protocol/storage version to IndexedDB store names:

```txt
v1:account
v1:collection:todos

v2:account
v2:collection:todos
```

The account store/record holds:

```txt
_schemaVersion
possibly _lastServerSeq
```

Recommended status object:

```ts
vs.status = proxy({
  hydrated: false,
  syncing: false,
  dirty: false,
  online: true,
  lastSyncAt: null,
  lastError: null,
});
```

Migration config:

```ts
migrations: {
  2: migrateV1ToV2,
  3: migrateV2ToV3,
}
```

Hydration and sync application should use a no-tracking guard:

```ts
runWithoutTracking(() => {
  applyHydratedState(...);
});
```

Namespace config:

```ts
const vs = valtioSync({
  endpoint: "/api/sync",
  namespace: `my-app:${user.id}`,
  schema,
  device,
  session,
});
```

Clearing APIs:

```ts
await vs.clearLocalData();
await vs.clearCollection(todos);
await vs.reset();
```
