# Testing

Use memory storage to avoid IndexedDB and browser storage in unit tests:

```ts
import { createMemoryStorageAdapter, preventRemoteWrites, valtioSync } from 'valtio-sync/client'

const sync = valtioSync({
  endpoint: '/api/sync',
  schema: { account, todos },
  storage: createMemoryStorageAdapter({ namespace: 'test' }),
  fetch: async (_input, init) => {
    const request = JSON.parse(String(init?.body))
    return Response.json({
      serverSeq: 1,
      accepted: request.ops.map((op) => ({
        mutationId: op.mutationId,
        collection: op.collection,
        id: op.id,
        serverVersion: 1,
      })),
      rejected: [],
      changes: {},
    })
  },
})

await sync.hydrate()
```

Call `flush()` before inspecting pending operations:

```ts
sync.todos.create({ id: 'todo_1', title: 'Draft' })
await sync.flush()

expect(sync.debug.getPendingOps()).toMatchObject([
  { collection: 'todos', type: 'create', id: 'todo_1' },
])
```

When using fake timers, advance the local write batch window before `flush()`:

```ts
vi.useFakeTimers()

sync.todos.records.todo_1.title = 'Changed'
await vi.advanceTimersByTimeAsync(100)
await sync.flush()
```

Test server handlers by calling the returned server's handle method with a `Request`:

```ts
import { valtioSync } from 'valtio-sync/server'

const syncServer = valtioSync({
  schema: { account, todos },
  handlers: {
    todos: {
      readSnapshot: () => ({
        serverSeq: 1,
        changes: {
          upserted: [],
          deleted: [],
        },
      }),
      create: ({ record }) => ({ serverVersion: 1, record }),
    },
  },
})

const response = await syncServer.handle(
  new Request('https://app.test/api/sync', {
    method: 'POST',
    body: JSON.stringify({
      clientId: 'device_1',
      schemaVersion: 1,
      lastServerSeq: null,
      ops: [
        {
          mutationId: 'm1',
          collection: 'todos',
          type: 'create',
          id: 'todo_1',
          value: { id: 'todo_1', title: 'Local' },
          touched: ['id', 'title'],
        },
      ],
    }),
  }),
)
```

Use `debug.getLastSyncRequest()` and `debug.getLastSyncResponse()` for end-to-end sync assertions.

For fixture-driven UI scenarios, keep the real client and temporarily hydrate an isolated memory
adapter. Install `preventRemoteWrites` first so pulls continue but fixture operations never reach
the endpoint, then reactivate the default local persistence before removing protection:

```ts
const removeWriteProtection = sync.interceptTransport(preventRemoteWrites)
await sync.hydrate(createMemoryStorageAdapter({ namespace: `scenario:${scenarioId}` }))

try {
  installScenarioState(sync)
} finally {
  await sync.hydrate()
  removeWriteProtection()
}
```

Argument-free `hydrate()` always reactivates the constructor-provided default adapter and reads its
current contents. Scenario cleanup must await it before removing write protection.
