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

## Suspending Remote Synchronization

`await sync.suspendSync()` starts a scoped local-only period and returns an async resume function.
During the period, neither explicit `sync()` calls nor previously scheduled retries contact the
endpoint. Account and collection interactions remain reactive in memory but are excluded from
synced persistence and pending operations. Local-only `device` and `session` state continues its
normal persistence behavior.

When the final nested suspension resumes, account and collection proxies are restored from the
durable state captured at the suspension boundary. Pre-existing dirty operations remain pending;
changes made during suspension are discarded and cannot be uploaded by a later sync. A canceled
network retry for that pre-existing dirty work is scheduled again only after restoration.

```ts
const resumeSync = await sync.suspendSync()
try {
  installDevelopmentFixture(sync)
  await inspectFlow()
} finally {
  await resumeSync()
}
```

The suspension starts after `suspendSync()` resolves, so callers should await it before applying
fixture state. Resume is also asynchronous and should be awaited before ordinary synced work
continues.

## Choosing Sync Triggers

Applications should choose triggers that match their durability and freshness needs. Common
triggers include startup after authentication, important save actions, reconnect, returning to a
visible tab, and a periodic timer while the app is active.

```ts
await sync.ready
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
