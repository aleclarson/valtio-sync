---
name: valtio-sync
description: Use when changing the valtio-sync package implementation, tests, public package documentation, or API surface. Applies to Valtio client sync behavior, schema validation, local persistence, server sync handlers, the Drizzle helper, API snapshots, and agent-facing repository guidance.
---

# valtio-sync

## Working Rules

Preserve the package goal: local-first Valtio persistence and sync for single-user save state. Avoid turning the package into realtime collaboration, CRDTs, a query DSL, or a general backend framework unless the user explicitly asks.

Use public docs for current user-facing behavior:

- `docs/schema.md` for schema, strict validation, defaults, and JSON-only records.
- `docs/client.md` for client options, collection APIs, local persistence, sync, and debug behavior.
- `docs/server.md` for handler contracts, `readChanges`, `readSnapshot`, and `rejectSync`.
- `docs/drizzle.md` for `applyOpsWithDrizzle`.
- `docs/testing.md` and `docs/troubleshooting.md` for expected testing and failure behavior.

Keep app ownership clear. The app owns authentication, authorization, persistence tables, business validation, server conflict policy, and database access. `valtio-sync` owns local cache hydration, dirty metadata, mutation compaction, request/response validation, and client application of accepted, rejected, and remote changes.

## Invariants

- Require exactly one account definition in a sync schema.
- Keep collection user records under `collections.<name>.records`; do not put metadata inside user proxies.
- Validate synced records and patches through Zod and require JSON-serializable plain records.
- Treat `device` and `session` as local-only state, not synced state.
- Preserve explicit touched-field tracking. Creates should include touched fields, and untouched defaults should not be sent as user edits.
- Keep rejected validation, forbidden, conflict, not-found, and server-error mutations from retrying indefinitely.
- Preserve network retry behavior for dirty operations that could not reach the server.
- Keep IndexedDB and Web Storage usage scoped by `namespace`.

## Change Workflow

Read the narrow public doc that matches the change before editing behavior. Update docs when public API or user-visible semantics change.

Prefer local, explicit code over helper sprawl. Extract only for durable boundaries such as schema validation, storage, protocol parsing, server contracts, or Drizzle integration.

Before committing, run relevant checks:

```sh
pnpm typecheck
pnpm test -- --run
pnpm lint
pnpm build
```

API snapshots are review-sensitive. If an API snapshot test fails, inspect the diff first. Run `pnpm tsnapi -u` only when the API change is intentional and should become the committed contract.
