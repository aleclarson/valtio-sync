# v1 Scope and Testing

The core v1 should focus on transparent save state:

```txt
valtioSync client factory
valtioSync server handler factory
account singleton
collections
device singleton
session singleton
strict Zod validation
local IndexedDB cache
localStorage device state
sessionStorage session state
direct proxy mutation tracking
collection create/delete helpers
100ms mutation batching
single sync endpoint
server handler grouping by collection/op
optional Drizzle helper
schema version migrations
type inference with vs.infer
```

The core v1 should exclude:

```txt
CRDTs
realtime sync
generic query DSL
server-owned RBAC
arbitrary client-side SQL queries
operation queue
field-level merge logs
general server patch stream
```

## Recommended Build-First Scope

Build this first:

```txt
account singleton
collections
device singleton
session singleton
strict Zod validation
IndexedDB cache
localStorage/sessionStorage persistence
direct proxy mutation tracking
100ms batching
op compaction
single sync endpoint
server handler factory
Drizzle helper with sync_events
rejectStale conflict default
snapshot fallback
debug API
```

Defer this:

```txt
CRDTs
realtime sync
generic query DSL
field-level merge logs
server-driven patch stream
automatic relationship cascades
leader election
arbitrary local SQL/Drizzle queries as public sync API
```

## Debugging

Include debug APIs early. They will save implementation pain.

Keep debug helpers behind a `debug` namespace so the main API stays clean.

## Implementation Details

Recommended debug API:

```ts
vs.flush();
vs.sync();

vs.debug.getStatus();
vs.debug.getDirtyRecords();
vs.debug.getPendingOps();
vs.debug.getRecordMeta(collection, id);
vs.debug.getLastSyncRequest();
vs.debug.getLastSyncResponse();
vs.debug.clearLocalData();
```

The implemented client exposes these debug helpers through `vs.debug`, with `vs.ready` as the local hydration barrier.

Prioritize deterministic sync tests.

Required test cases:

```txt
hydrate from empty cache
hydrate from existing cache
migrate v1 -> v2 -> v3
create -> update -> delete before flush
update -> update compaction
create with default omitted
create with explicitly touched default included
accepted create returns canonical record
server rejects validation
server rejects conflict
network failure preserves dirty record
two tabs mutate same collection
logout clears namespaced cache
remote change applies to clean record
remote change conflicts with dirty record
snapshot fallback works
readChanges cursor works
```

Use fake timers for the 100ms batching tests.
