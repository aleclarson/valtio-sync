# Troubleshooting

`status.lastError.reason === "validation"`

The local record, local patch, cached record, server change, or server response does not match the schema. Check for undeclared fields, non-JSON values, missing collection `id`, and Zod refinements that reject defaults.

`status.lastError.reason === "network"`

The client could not reach the sync endpoint, the response was not `ok`, or no `fetch` implementation was available. Dirty operations stay pending and the client schedules a retry while data remains dirty.

`status.lastError.reason === "auth"`

The sync endpoint returned `401` or `403`. Refresh auth state, reauthenticate, or clear user-local data when switching accounts.

`status.lastError.reason === "conflict"`

The server or client detected stale base data. The current v1 behavior keeps the optimistic local value, records the conflict in metadata, and stops retrying the rejected operation. Use `debug.getRecordMeta(collection, id)` to inspect conflict details.

Pending ops are empty after a rejected operation

Validation, forbidden, conflict, not-found, and server-error rejections are treated as handled for that mutation. The optimistic value may remain local with `lastError` metadata, but the operation is no longer dirty.

A test sees no pending operation after a mutation

Local proxy writes are batched. Use fake timers to advance `100` ms when needed, then call `await sync.flush()` before reading `debug.getPendingOps()`.

Data appears under the wrong user

Set a stable per-user `namespace`, such as `my-app:${user.id}`. The namespace scopes IndexedDB, local storage, session storage, and BroadcastChannel state.

Need to clear local data

Use:

```ts
await sync.clearLocalData();
```

This clears synced records, account state, device state, session state, and notifies other tabs in the same namespace.

Do not store secrets

Synced records, `device`, and `session` are stored in browser-managed persistence. Treat them as user data caches, not secure secret storage.
