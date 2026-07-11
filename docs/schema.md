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
type TodoFromZod = z.infer<typeof todos.recordSchema>; // Same as Todo
```

Each definition exposes its effective strict Zod schema as `recordSchema`. This is the same
schema valtio-sync uses for cache hydration, local mutations, inbound changes, and outbound
validation, including field defaults and transforms. This makes the definition the source of
truth without requiring a separate Zod object:

```ts
export const Food = foods.recordSchema;
export type Food = infer<typeof foods>;
```

Use the definition-level `refine` callback for invariants involving multiple fields. It has
the same record and issue context as Zod's `superRefine`:

```ts
const account = defineAccount({
  fields: {
    mealsPerDay: z.number().int().positive(),
    meals: z.array(z.string()),
  },
  refine: (record, ctx) => {
    if (record.meals.length !== record.mealsPerDay) {
      ctx.addIssue({
        code: "custom",
        path: ["meals"],
        message: "Meals must match mealsPerDay",
      });
    }
  },
});
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
