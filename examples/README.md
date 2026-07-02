# Examples

These examples are intentionally small and framework-free. They show the copyable wiring for `valtio-sync` without adding a database, auth framework, or UI framework.

- [`basic-todos`](basic-todos/index.ts) wires a client to an in-memory sync endpoint.
- [`server-handler`](server-handler/index.ts) shows a server handler backed by an in-memory store.
- [`testing`](testing/todos.example.ts) shows memory storage, fake `fetch`, `flush()`, and debug assertions.

The examples import from the published package entrypoints, such as `valtio-sync/client`, so they match how application code should use the package.

The testing file uses `.example.ts` so this repository's default Vitest run does not collect it; copy it into an app test suite as a `.test.ts` file.
