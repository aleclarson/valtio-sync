---
name: valtio-sync
description: Use when adding, changing, testing, or debugging valtio-sync usage in an application that consumes the package. Applies to app schemas, client setup, local persistence, sync endpoints, server handlers, Drizzle integration, tests, and troubleshooting for installed valtio-sync projects.
---

# valtio-sync

Use this skill for application code that consumes `valtio-sync`. Do not treat it as maintainer guidance for changing the `valtio-sync` package itself unless the user explicitly asks to work on the package implementation.

## Source of Truth

Use the public docs packaged with the installed dependency for current behavior. In consuming projects, `docs/*` below means the files published with `valtio-sync`, typically under `node_modules/valtio-sync/docs/*`:

- `docs/README.md` for the package overview and intended ownership boundary.
- `docs/quickstart.md` for the minimal schema, client, and endpoint setup.
- `docs/schema.md` for schema definitions, strict validation, defaults, and JSON-only records.
- `docs/client.md` for client options, collection APIs, local persistence, sync, anonymous signup promotion, and debug helpers.
- `docs/server.md` for handler contracts, `readChanges`, `readSnapshot`, idempotency, sync event retention, and `rejectSync`.
- `docs/drizzle.md` for `applyOpsWithDrizzle` and Drizzle type-checked schema wrappers.
- `docs/testing.md` and `docs/troubleshooting.md` for expected test setup and failure behavior.

Prefer the installed docs that match the app's installed `valtio-sync` version over assumptions from memory.

## Integration Rules

Keep app ownership clear. The application owns authentication, authorization, persistence tables, business validation, server conflict policy, database access, and retention jobs. `valtio-sync` owns the client mutation model, local cache behavior, request/response validation, and sync protocol contract.

Define exactly one account schema and any number of collection schemas. Collection records should have an `id: z.string()` field, and synced records and patches must be JSON-serializable plain data validated by Zod.

Use a stable `namespace` that isolates local data per app and user or account. Treat synced records, `device`, and `session` as browser-persisted user data caches, not secure secret storage.

Implement server handlers against the authenticated request context. Mutation handlers should be idempotent by `op.mutationId` for the authenticated user and return `{ serverVersion, record? }`, including `record` when the server canonicalizes stored data.

When using `readChanges`, handle `since: null` as bootstrap for a new device. Return `changes.mode: "snapshot"` when the retained event feed cannot reconstruct complete collection state; otherwise use `readSnapshot` for authoritative full-state reads.

For tests, use the memory storage helpers, call `flush()` before inspecting pending operations, and use `debug` helpers only for diagnostics and assertions.
