# Queries

Earlier name: derived collections.

Current name: queries.

Queries are downstream from collections:

```txt
collection = mutable source
query = filtered/ordered projection
```

Queries should not have insert/delete:

```ts
openTodos.insert(...) // no
openTodos.delete(...) // no
```

Collection owns mutations:

```ts
todos.create(...);
todos.delete(id);
todos.records[id].completed = true;
```

## Direction

Queries may be useful if/when the framework supports named cached projections.

Important idea:

```txt
queries known to both client and server
client cannot send arbitrary SQL-ish filters
application can limit allowed queries
access patterns are predictable
hardened against abuse
```

However, this started feeling bespoke and may be too much for the core.

Current recentered view:

```txt
queries are probably not the center of v1
collections + account + transparent save state are the center
named queries can be added later if needed
```

## Related Deferred Ideas

CRDTs are not needed for the core.

Reason:

```txt
no realtime sync
no operation queue
single-user save state
state-based syncing is enough
```

CRDT support was initially considered for specific large text columns, but after recentering, it is out of scope for the core design. If added later, it should be opt-in and column-specific.

Field-level touched tracking can improve compact update patches, but it should not become a sophisticated conflict-resolution system in v1.

Clean field-level merging usually requires more machinery:

```txt
field-level updated_at
or short-term field-level update log
or base snapshot for 3-way merge
```

This is probably too much for the simple core.

## Implementation Details

Potential query shape:

```ts
export const openTodos = vs.query(...);
```

Authenticated query idea discussed:

```ts
{ user: current(users) }
```

or:

```ts
{ org: contains(orgs, "members", current(users)) }
```

followed by a column-level `where` filter.

These query ideas should remain deferred unless v1 collection/account sync proves they are necessary.
