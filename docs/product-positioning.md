# Product Positioning

`valtio-sync` is primarily for single-user transparent save state.

The target developer experience is ordinary Valtio mutation:

```ts
todo.title = "New title";
```

Behind that mutation, the data should be persisted locally, batched, sent to a remote backend, stored in the app database, available across devices, and restored instantly on reload.

The clean positioning is:

```txt
valtio-sync lets you use Valtio like normal,
while automatically saving state locally and remotely.
```

Expanded:

```txt
Edit state in memory.
Reload instantly from local cache.
Sync to your own backend.
Back up to your own database.
Pick up changes on another device.
Keep your backend, auth, and data model.
```

## Primary Use Cases

The core use cases are:

```txt
remote backups
multi-device sync
instant reloads from local cache
transparent persistence for app state
single-user data/state
```

This is not primarily a realtime collaboration system.

## Non-Goals

The framework should not try to become:

```txt
a full sync server
an RBAC framework
a query engine
a CRDT framework
a realtime sync layer
a generic access-control DSL
a server-owned persistence platform
```

The application owns:

```txt
authentication
authorization
database writes
database reads
RBAC / tenancy rules
conflict policy if custom
mapping sync ops to actual tables
```

`valtio-sync` owns:

```txt
Valtio proxies
mutation tracking
local persistence
batching
sync transport
schema validation
basic protocol shape
optional backend helpers
```

## Security Boundary

The local database is trusted only for UX and cache behavior. The backend is trusted for correctness, and the remote database remains the source of truth.

Local IndexedDB, `localStorage`, and `sessionStorage` should contain only rows and columns the user is allowed to have, but the framework must not rely on local data for real security decisions.

## Implementation Details

There are no required low-level implementation details in the product positioning itself. The rest of the docs map each owned responsibility to a concrete API, storage model, sync lifecycle, and server integration.
