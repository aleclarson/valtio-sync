import { z } from 'zod'
import type { JsonRecord } from './protocol.js'
import { isJsonRecord } from './protocol.js'

/** Reserved sync collection name used for singleton account state on the wire. */
export const ACCOUNT_COLLECTION = 'account'
/** Reserved sync record id used for singleton account state on the wire. */
export const ACCOUNT_ID = 'singleton'

/** Zod field schema accepted by valtio-sync schema definitions. */
export type FieldSchema = z.ZodType<unknown>
/** Named field map used to define account, collection, device, or session state. */
export type FieldMap = Record<string, FieldSchema>

/** Infer the parsed output object from a field map. */
export type InferFields<TFields extends FieldMap> = {
  -readonly [K in keyof TFields]: z.output<TFields[K]>
}

/** Infer the parsed record type from an account or collection definition. */
export type infer<TDefinition> =
  TDefinition extends SchemaDefinition<infer TFields> ? InferFields<TFields> : never

/** Discriminator for account and collection schema definitions. */
export type SchemaKind = 'account' | 'collection'

/** Singleton account state definition for a sync schema. */
export type AccountDefinition<TFields extends FieldMap = FieldMap> = {
  readonly kind: 'account'
  readonly fields: TFields
  readonly recordSchema: z.ZodObject<TFields>
  /** @deprecated Use `recordSchema` for the effective synced record schema. */
  readonly schema: z.ZodObject<TFields>
}

/** Record collection definition for a sync schema. */
export type CollectionDefinition<TFields extends FieldMap = FieldMap> = {
  readonly kind: 'collection'
  readonly fields: TFields
  readonly recordSchema: z.ZodObject<TFields>
  /** @deprecated Use `recordSchema` for the effective synced record schema. */
  readonly schema: z.ZodObject<TFields>
}

/** Any schema definition accepted in a valtio-sync schema map. */
export type SchemaDefinition<TFields extends FieldMap = FieldMap> =
  | AccountDefinition<TFields>
  | CollectionDefinition<TFields>

/** Complete sync schema keyed by user-defined account and collection names. */
export type SyncSchema = Record<string, SchemaDefinition>

/** Extract the account key from a sync schema type. */
export type AccountKey<TSchema extends SyncSchema> = {
  [K in keyof TSchema]: TSchema[K] extends AccountDefinition ? K : never
}[keyof TSchema]

/** Extract collection keys from a sync schema type. */
export type CollectionKey<TSchema extends SyncSchema> = {
  [K in keyof TSchema]: TSchema[K] extends CollectionDefinition ? K : never
}[keyof TSchema]

/** Define the singleton account portion of a sync schema. */
export function defineAccount<const TFields extends FieldMap>(options: {
  fields: TFields
}): AccountDefinition<TFields> {
  const recordSchema = createRecordSchema(options)
  return {
    kind: 'account',
    fields: options.fields,
    recordSchema,
    schema: recordSchema,
  }
}

/** Define a record collection in a sync schema. */
export function defineCollection<const TFields extends FieldMap>(options: {
  fields: TFields
}): CollectionDefinition<TFields> {
  const recordSchema = createRecordSchema(options)
  return {
    kind: 'collection',
    fields: options.fields,
    recordSchema,
    schema: recordSchema,
  }
}

function createRecordSchema<TFields extends FieldMap>(options: {
  fields: TFields
}): z.ZodObject<TFields> {
  return z.object(options.fields).strict()
}

/** Create a strict Zod object schema for client-only device or session state. */
export function defineLocalState<const TFields extends FieldMap>(
  fields: TFields,
): z.ZodObject<TFields> {
  return z.object(fields).strict()
}

/** Return default values supplied by fields in a schema definition. */
export function getDefaults<TFields extends FieldMap>(
  definition: SchemaDefinition<TFields>,
): InferFields<TFields> {
  const defaults: Record<string, unknown> = {}

  for (const key of Object.keys(definition.fields)) {
    const result = definition.recordSchema.shape[key]?.safeParse(undefined)
    if (result?.success) {
      defaults[key] = result.data
    }
  }

  return defaults as InferFields<TFields>
}

/** Parse a full synced record and ensure the parsed output is JSON-serializable. */
export function parseRecord<TFields extends FieldMap>(
  definition: SchemaDefinition<TFields>,
  value: unknown,
): InferFields<TFields> {
  const parsed = definition.recordSchema.parse(value)
  assertJsonRecord(parsed, 'Synced records must be JSON-serializable')
  return parsed as InferFields<TFields>
}

/** Parse a partial update against known fields and reject unknown patch keys. */
export function parsePatch<TFields extends FieldMap>(
  definition: SchemaDefinition<TFields>,
  value: unknown,
): Partial<InferFields<TFields>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Expected patch to be an object')
  }

  const parsed: Record<string, unknown> = {}
  const patch = value as Record<string, unknown>

  for (const key of Object.keys(patch)) {
    const field = definition.fields[key]
    if (!field) {
      throw new Error(`Unknown patch field: ${key}`)
    }
    parsed[key] = field.parse(patch[key])
  }

  assertJsonRecord(parsed, 'Synced patches must be JSON-serializable')
  return parsed as Partial<InferFields<TFields>>
}

/** Parse client-only local state and ensure the parsed output is JSON-serializable. */
export function parseLocalState<TFields extends FieldMap>(
  fields: TFields,
  value: unknown,
): InferFields<TFields> {
  const parsed = defineLocalState(fields).parse(value)
  assertJsonRecord(parsed, 'Local state must be JSON-serializable')
  return parsed as InferFields<TFields>
}

/** Assert that a parsed value is an object-shaped JSON payload. */
export function assertJsonRecord(
  value: unknown,
  message = 'Expected a JSON record',
): asserts value is JsonRecord {
  if (!isJsonRecord(value)) {
    throw new TypeError(message)
  }
}

/** Return the single account key or throw when the schema does not define exactly one. */
export function getAccountKey<TSchema extends SyncSchema>(schema: TSchema): AccountKey<TSchema> {
  const accountKeys = Object.keys(schema).filter((key) => schema[key]?.kind === 'account')

  if (accountKeys.length !== 1) {
    throw new Error('valtio-sync requires exactly one account definition')
  }

  return accountKeys[0] as AccountKey<TSchema>
}

/** Return every collection key from a sync schema. */
export function getCollectionKeys<TSchema extends SyncSchema>(
  schema: TSchema,
): Array<CollectionKey<TSchema>> {
  return Object.keys(schema).filter((key) => schema[key]?.kind === 'collection') as Array<
    CollectionKey<TSchema>
  >
}

/** Look up a schema definition by wire collection name. */
export function getCollectionDefinition(
  schema: SyncSchema,
  collection: string,
): SchemaDefinition | undefined {
  if (collection === ACCOUNT_COLLECTION) {
    const accountKey = getAccountKey(schema)
    return schema[accountKey as string]
  }

  return schema[collection]
}
