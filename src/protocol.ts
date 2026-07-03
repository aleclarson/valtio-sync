import { z } from 'zod'

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export type JsonRecord = Record<string, JsonValue>

export type SyncRejectionReason =
  | 'validation'
  | 'forbidden'
  | 'conflict'
  | 'not_found'
  | 'server_error'

export type SyncError = {
  reason: SyncRejectionReason | 'network' | 'auth'
  message?: string
}

export type CreateSyncOp = {
  mutationId: string
  collection: string
  type: 'create'
  id: string
  value: JsonRecord
  touched: string[]
}

export type UpdateSyncOp = {
  mutationId: string
  collection: string
  type: 'update'
  id: string
  patch: JsonRecord
  touched: string[]
  baseServerVersion: number | null
}

export type DeleteSyncOp = {
  mutationId: string
  collection: string
  type: 'delete'
  id: string
  baseServerVersion: number | null
}

export type SyncOp = CreateSyncOp | UpdateSyncOp | DeleteSyncOp

export type SyncRequest = {
  clientId: string
  schemaVersion: number
  lastServerSeq: number | null
  ops: SyncOp[]
}

export type AcceptedSyncOp = {
  mutationId: string
  collection: string
  id: string
  serverVersion: number
  record?: JsonRecord
}

export type RejectedSyncOp = {
  mutationId: string
  collection: string
  id: string
  reason: SyncRejectionReason
  message?: string
  serverRecord?: JsonRecord
  serverVersion?: number
}

export type CollectionChangesMode = 'changes' | 'snapshot'

export type CollectionChanges = {
  mode?: CollectionChangesMode
  upserted: Array<{
    id: string
    serverVersion: number
    record: JsonRecord
  }>
  deleted: Array<{
    id: string
    serverVersion: number
  }>
}

export type SyncResponse = {
  serverSeq: number
  accepted: AcceptedSyncOp[]
  rejected: RejectedSyncOp[]
  changes: Record<string, CollectionChanges>
}

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ])
)

export const jsonRecordSchema: z.ZodType<JsonRecord> = z.record(
  z.string(),
  jsonValueSchema,
)

const syncRejectionReasonSchema = z.enum([
  'validation',
  'forbidden',
  'conflict',
  'not_found',
  'server_error',
])

export const syncOpSchema: z.ZodType<SyncOp> = z.discriminatedUnion('type', [
  z.object({
    mutationId: z.string().min(1),
    collection: z.string().min(1),
    type: z.literal('create'),
    id: z.string().min(1),
    value: jsonRecordSchema,
    touched: z.array(z.string()),
  }),
  z.object({
    mutationId: z.string().min(1),
    collection: z.string().min(1),
    type: z.literal('update'),
    id: z.string().min(1),
    patch: jsonRecordSchema,
    touched: z.array(z.string()),
    baseServerVersion: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    mutationId: z.string().min(1),
    collection: z.string().min(1),
    type: z.literal('delete'),
    id: z.string().min(1),
    baseServerVersion: z.number().int().nonnegative().nullable(),
  }),
])

export const syncRequestSchema: z.ZodType<SyncRequest> = z.object({
  clientId: z.string().min(1),
  schemaVersion: z.number().int().nonnegative(),
  lastServerSeq: z.number().int().nonnegative().nullable(),
  ops: z.array(syncOpSchema),
})

const collectionChangesModeSchema = z.enum(['changes', 'snapshot'])

export const collectionChangesSchema: z.ZodType<CollectionChanges> = z.object({
  mode: collectionChangesModeSchema.optional(),
  upserted: z.array(
    z.object({
      id: z.string().min(1),
      serverVersion: z.number().int().nonnegative(),
      record: jsonRecordSchema,
    }),
  ),
  deleted: z.array(
    z.object({
      id: z.string().min(1),
      serverVersion: z.number().int().nonnegative(),
    }),
  ),
})

export const syncResponseSchema: z.ZodType<SyncResponse> = z.object({
  serverSeq: z.number().int().nonnegative(),
  accepted: z.array(
    z.object({
      mutationId: z.string().min(1),
      collection: z.string().min(1),
      id: z.string().min(1),
      serverVersion: z.number().int().nonnegative(),
      record: jsonRecordSchema.optional(),
    }),
  ),
  rejected: z.array(
    z.object({
      mutationId: z.string().min(1),
      collection: z.string().min(1),
      id: z.string().min(1),
      reason: syncRejectionReasonSchema,
      message: z.string().optional(),
      serverRecord: jsonRecordSchema.optional(),
      serverVersion: z.number().int().nonnegative().optional(),
    }),
  ),
  changes: z.record(z.string(), collectionChangesSchema),
})

export function parseSyncRequest(value: unknown): SyncRequest {
  return syncRequestSchema.parse(value)
}

export function parseSyncResponse(value: unknown): SyncResponse {
  return syncResponseSchema.parse(value)
}

export function isJsonRecord(value: unknown): value is JsonRecord {
  return jsonRecordSchema.safeParse(value).success
}
