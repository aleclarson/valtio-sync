import { z } from 'zod'
import type { JsonRecord } from './protocol.js'
import { isJsonRecord } from './protocol.js'

export const ACCOUNT_COLLECTION = 'account'
export const ACCOUNT_ID = 'singleton'

export type FieldSchema = z.ZodType<unknown>
export type FieldMap = Record<string, FieldSchema>

export type InferFields<TFields extends FieldMap> = {
  -readonly [K in keyof TFields]: z.output<TFields[K]>
}

export type infer<TDefinition> = TDefinition extends SchemaDefinition<infer TFields>
  ? InferFields<TFields>
  : never

export type SchemaKind = 'account' | 'collection'

export type AccountDefinition<TFields extends FieldMap = FieldMap> = {
  readonly kind: 'account'
  readonly fields: TFields
  readonly schema: z.ZodObject<TFields>
}

export type CollectionDefinition<TFields extends FieldMap = FieldMap> = {
  readonly kind: 'collection'
  readonly fields: TFields
  readonly schema: z.ZodObject<TFields>
}

export type SchemaDefinition<TFields extends FieldMap = FieldMap> =
  | AccountDefinition<TFields>
  | CollectionDefinition<TFields>

export type SyncSchema = Record<string, SchemaDefinition>

export type AccountKey<TSchema extends SyncSchema> = {
  [K in keyof TSchema]: TSchema[K] extends AccountDefinition ? K : never
}[keyof TSchema]

export type CollectionKey<TSchema extends SyncSchema> = {
  [K in keyof TSchema]: TSchema[K] extends CollectionDefinition ? K : never
}[keyof TSchema]

export function defineAccount<const TFields extends FieldMap>(options: {
  fields: TFields
}): AccountDefinition<TFields> {
  return {
    kind: 'account',
    fields: options.fields,
    schema: z.object(options.fields).strict(),
  }
}

export function defineCollection<const TFields extends FieldMap>(options: {
  fields: TFields
}): CollectionDefinition<TFields> {
  return {
    kind: 'collection',
    fields: options.fields,
    schema: z.object(options.fields).strict(),
  }
}

export function defineLocalState<const TFields extends FieldMap>(
  fields: TFields,
): z.ZodObject<TFields> {
  return z.object(fields).strict()
}

export function getDefaults<TFields extends FieldMap>(
  definition: SchemaDefinition<TFields>,
): InferFields<TFields> {
  const defaults: Record<string, unknown> = {}

  for (const key of Object.keys(definition.fields)) {
    const result = definition.schema.shape[key]?.safeParse(undefined)
    if (result?.success) {
      defaults[key] = result.data
    }
  }

  return defaults as InferFields<TFields>
}

export function parseRecord<TFields extends FieldMap>(
  definition: SchemaDefinition<TFields>,
  value: unknown,
): InferFields<TFields> {
  const parsed = definition.schema.parse(value)
  assertJsonRecord(parsed, 'Synced records must be JSON-serializable')
  return parsed as InferFields<TFields>
}

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

export function parseLocalState<TFields extends FieldMap>(
  fields: TFields,
  value: unknown,
): InferFields<TFields> {
  const parsed = defineLocalState(fields).parse(value)
  assertJsonRecord(parsed, 'Local state must be JSON-serializable')
  return parsed as InferFields<TFields>
}

export function assertJsonRecord(
  value: unknown,
  message = 'Expected a JSON record',
): asserts value is JsonRecord {
  if (!isJsonRecord(value)) {
    throw new TypeError(message)
  }
}

export function getAccountKey<TSchema extends SyncSchema>(
  schema: TSchema,
): AccountKey<TSchema> {
  const accountKeys = Object.keys(schema).filter(
    (key) => schema[key]?.kind === 'account',
  )

  if (accountKeys.length !== 1) {
    throw new Error('valtio-sync requires exactly one account definition')
  }

  return accountKeys[0] as AccountKey<TSchema>
}

export function getCollectionKeys<TSchema extends SyncSchema>(
  schema: TSchema,
): Array<CollectionKey<TSchema>> {
  return Object.keys(schema).filter(
    (key) => schema[key]?.kind === 'collection',
  ) as Array<CollectionKey<TSchema>>
}

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
