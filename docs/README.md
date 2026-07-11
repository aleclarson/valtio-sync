# valtio-sync Documentation

`valtio-sync` persists Valtio state locally, tracks dirty mutations, and sends those mutations to an app-owned sync endpoint. It is aimed at single-user save state, not realtime collaboration.

Start here:

- [Quickstart](quickstart.md)
- [Sync Lifecycle](sync-lifecycle.md)
- [Schemas](schema.md)
- [Client API](client.md)
- [Server API](server.md)
- [Drizzle Helper](drizzle.md)
- [Testing](testing.md)
- [Troubleshooting](troubleshooting.md)

The app still owns authentication, authorization, database schema, and business rules. `valtio-sync` only defines the client mutation model, local cache behavior, and sync request/response contract.
