# Schemas

Schemas are Zod-backed records. They validate local cache hydration, local mutations, inbound server changes, and outbound server responses.

```ts
import { defineAccount, defineCollection, type infer } from "valtio-sync/schema";
import { z } from "zod";

const account = defineAccount({
  fields: {
    theme: z.enum(["light", "dark"]).default("light"),
  },
});

const todos = defineCollection({
  fields: {
    id: z.string(),
    title: z.string().default(""),
    completed: z.boolean().default(false),
  },
});

type Todo = infer<typeof todos>;
```

Use exactly one account definition in each sync schema:

```ts
const schema = { account, todos };
```

Collections should include an `id: z.string()` field. The collection API creates records by id, and strict schema validation rejects values with fields that are not declared.

Defaults are applied when records are created and when local cache data is hydrated:

```ts
const todo = sync.collections.todos.create({ id: "todo_1" });
todo.title; // ""
todo.completed; // false
```

All synced records and patches must be JSON-serializable plain records. Avoid `Date`, `Map`, `Set`, class instances, functions, `undefined`, `NaN`, and infinite numbers. Store encoded strings or plain objects instead.

Local-only state uses the same field-map shape, but it is passed directly to the client as `device` or `session` fields rather than through `defineAccount` or `defineCollection`.
