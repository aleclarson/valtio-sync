# Sync Lifecycle

`valtio-sync` saves local changes automatically, but the application starts the first remote
sync. A successful local write does not by itself mean the change has reached the server.

## What Happens After a Mutation

When application code mutates an account or collection proxy, `valtio-sync`:

1. updates the reactive proxy immediately;
2. marks the affected fields as dirty;
3. batches the local persistence work for approximately `100` ms; and
4. stores the change in the client's local persistence.

The client does not automatically POST the change after this batch. Call `sync()` to send all
pending operations and pull remote changes:

```ts
sync.todos.records.todo_1.completed = true
await sync.sync()
```

Collection-level `flush()` and `sync()` methods delegate to the same client-wide operations, so
they are conveniences rather than collection-only network requests.

## `flush()` Compared with `sync()`

- `await sync.flush()` waits for pending local writes and recomputes the pending operation list.
  It does not contact the server.
- `await sync.sync()` flushes local writes, POSTs pending operations, and applies the server
  response.

Use `flush()` in tests, diagnostics, and code that must know local persistence has caught up. Use
`sync()` when changes should be remotely backed up or when the client should pull newer server
state.

## What Is Automatic

- Proxy mutation tracking and local persistence are automatic.
- Failed network requests and non-auth HTTP failures are retried automatically while dirty work
  remains, using exponential backoff with jitter.
- Validation, authorization, conflict, and other operation rejections are not retried unchanged.
- There is no automatic initial sync, sync-after-every-mutation, polling, or server-push/realtime
  connection.

Automatic retries begin only after an application-triggered sync attempt fails. Merely creating
dirty local state does not schedule a remote request.

## Intercepting the Transport

`sync.interceptTransport()` wraps future protocol requests before the built-in HTTP transport.
Interceptors can pass through or modify a `SyncRequest`, replace its `SyncResponse`, or return
`null` to drop the attempt. A scheduled retry also passes through the currently installed
interceptors, so a dropping interceptor prevents that retry from reaching the endpoint.

A dropped attempt is not a success or failure: it does not advance the server cursor, apply a
response, clear dirty operations, or schedule another retry. Likewise, stripping `ops` before
calling the remote transport leaves those local operations pending. If the interceptor is later
removed, a normal `sync()` may send them.

Use `preventRemoteWrites` with a temporary memory storage adapter when fixture state must never mix
with a real account. The interceptor strips operations but passes the pull request through, while
the memory adapter isolates the normal local persistence and mutation lifecycle. Hydrate the
constructor-provided default adapter again before removing the interceptor. A storage namespace is
not sent as server authentication.

## Choosing Sync Triggers

Applications should choose triggers that match their durability and freshness needs. Common
triggers include startup after authentication, important save actions, reconnect, returning to a
visible tab, and a periodic timer while the app is active.

```ts
await sync.hydrate()
await sync.sync()

const syncWhenOnline = () => void sync.sync()
window.addEventListener('online', syncWhenOnline)

const timer = window.setInterval(() => void sync.sync(), 30_000)

// During application teardown:
window.removeEventListener('online', syncWhenOnline)
window.clearInterval(timer)
sync.close()
```

Calling `sync()` while another sync is running returns without starting an overlapping request.
Choose a polling interval appropriate for the application's traffic, battery, and freshness
requirements.

Browser shutdown hooks are best-effort and should not be the only remote durability mechanism. If
a tab closes before a remote sync succeeds, the dirty changes remain in that client's local
persistence and can be sent when that client is opened again. Other devices will not see those
changes until remote sync completes, and they must also sync to pull the changes.

## Realtime Expectations

`valtio-sync` is designed for single-user save state and multi-device synchronization, not
realtime collaboration. It does not keep devices continuously current or provide a server-driven
change stream. Applications that need live collaboration or immediate cross-device updates need
an additional realtime transport and conflict model.
