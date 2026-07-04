import { z } from 'zod'

/** JSON value shape accepted by sync payloads and persisted records. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/** Object-shaped JSON payload used for account data, collection records, and patches. */
export type JsonRecord = Record<string, JsonValue>

/** Server-side reason codes a mutation handler can return for a rejected sync op. */
export type SyncRejectionReason =
  | 'validation'
  | 'forbidden'
  | 'conflict'
  | 'not_found'
  | 'server_error'

/** Last sync error tracked by the client for status and record metadata. */
export type SyncError = {
  reason: SyncRejectionReason | 'network' | 'auth'
  message?: string
}

/** Client request to create a record in a synced collection. */
export type CreateSyncOp = {
  mutationId: string
  collection: string
  type: 'create'
  id: string
  value: JsonRecord
  touched: string[]
}

/** Client request to patch selected fields of an existing synced record. */
export type UpdateSyncOp = {
  mutationId: string
  collection: string
  type: 'update'
  id: string
  patch: JsonRecord
  touched: string[]
  baseServerVersion: number | null
}

/** Client request to delete an existing synced record. */
export type DeleteSyncOp = {
  mutationId: string
  collection: string
  type: 'delete'
  id: string
  baseServerVersion: number | null
}

/** Any mutation operation sent by a client during sync. */
export type SyncOp = CreateSyncOp | UpdateSyncOp | DeleteSyncOp

/** HTTP request body sent by the client sync loop to the server endpoint. */
export type SyncRequest = {
  clientId: string
  schemaVersion: number
  lastServerSeq: number | null
  ops: SyncOp[]
}

/** Server acknowledgement for a mutation that was applied successfully. */
export type AcceptedSyncOp = {
  mutationId: string
  collection: string
  id: string
  serverVersion: number
  record?: JsonRecord
}

/** Server acknowledgement for a mutation that was refused. */
export type RejectedSyncOp = {
  mutationId: string
  collection: string
  id: string
  reason: SyncRejectionReason
  message?: string
  serverRecord?: JsonRecord
  serverVersion?: number
}

/** Whether returned changes are incremental or an authoritative collection snapshot. */
export type CollectionChangesMode = 'changes' | 'snapshot'

/** Server-provided remote changes for a single collection. */
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

/** HTTP response body returned by the server sync endpoint. */
export type SyncResponse = {
  serverSeq: number
  accepted: AcceptedSyncOp[]
  rejected: RejectedSyncOp[]
  changes: Record<string, CollectionChanges>
}

/** Zod schema for values that can be serialized into valtio-sync records. */
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

/** Zod schema for object-shaped JSON values. */
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

/** Zod schema for client mutation operations. */
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

/** Zod schema for the client-to-server sync request body. */
export const syncRequestSchema: z.ZodType<SyncRequest> = z.object({
  clientId: z.string().min(1),
  schemaVersion: z.number().int().nonnegative(),
  lastServerSeq: z.number().int().nonnegative().nullable(),
  ops: z.array(syncOpSchema),
})

const collectionChangesModeSchema = z.enum(['changes', 'snapshot'])

/** Zod schema for a server change set for one collection. */
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

/** Zod schema for the server-to-client sync response body. */
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

/** Parse and validate an unknown value as a sync request. */
export function parseSyncRequest(value: unknown): SyncRequest {
  return syncRequestSchema.parse(value)
}

/** Parse and validate an unknown value as a sync response. */
export function parseSyncResponse(value: unknown): SyncResponse {
  return syncResponseSchema.parse(value)
}

/** Return true when a value is an object-shaped JSON record. */
export function isJsonRecord(value: unknown): value is JsonRecord {
  return jsonRecordSchema.safeParse(value).success
}
