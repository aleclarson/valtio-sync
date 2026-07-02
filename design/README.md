# Internal Design Notes

These documents contain internal architecture notes, rationale, and deferred-scope decisions for `valtio-sync`. They are not usage documentation and are not the package docs published from `docs/`.

The intended direction is a local-first persistence and sync layer for Valtio state, focused on single-user save state rather than realtime collaboration.

Read in this order:

- [Product Positioning](product-positioning.md)
- [Package API](package-api.md)
- [State Model](state-model.md)
- [Local Persistence](local-persistence.md)
- [Mutation Lifecycle](mutation-lifecycle.md)
- [Sync Model](sync-model.md)
- [Server Integration](server-integration.md)
- [Queries](queries.md)
- [v1 Scope and Testing](v1-scope.md)

Each concept document starts with product and architecture decisions, then keeps concrete API shapes, storage shapes, and protocol sketches in an `Implementation Details` section at the bottom.
