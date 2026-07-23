import { ZodError } from 'zod'
import type {
  CollectionChanges,
  CreateSyncOp,
  DeleteSyncOp,
  JsonRecord,
  RejectedSyncOp,
  SyncOp,
  SyncRequest,
  SyncResponse,
  SyncRejectionReason,
  UpdateSyncOp,
} from './protocol.js'
import { parseSyncRequest, parseSyncResponse } from './protocol.js'
import {
  ACCOUNT_COLLECTION,
  ACCOUNT_ID,
  type SchemaDefinition,
  type SyncSchema,
  getAccountKey,
  getCollectionDefinition,
  getCollectionKeys,
  parsePatch,
  parseRecord,
} from './schema.js'

export type {
  AcceptedSyncOp,
  CollectionChanges,
  CollectionChangesMode,
  CreateSyncOp,
  DeleteSyncOp,
  JsonRecord,
  JsonValue,
  RejectedSyncOp,
  SyncError,
  SyncOp,
  SyncRequest,
  SyncResponse,
  SyncRejectionReason,
  UpdateSyncOp,
} from './protocol.js'
export { parseSyncRequest, parseSyncResponse } from './protocol.js'
export type {
  AccountDefinition,
  CollectionDefinition,
  FieldMap,
  InferFields,
  SyncSchema,
  infer,
} from './schema.js'

/** Result returned by a mutation handler after applying a client operation. */
export type ServerMutationResult = {
  serverVersion: number
  record?: JsonRecord
}

/** Result returned by server-side change readers. */
export type ServerChangesResult = {
  serverSeq?: number
  changes: CollectionChanges
}

/** Request and user context passed to every server handler. */
export type ServerHandlerContext<TContext> = {
  request: Request
  ctx: TContext
}

/** Handlers for the singleton account state. */
export type AccountServerHandlers<TContext> = {
  readChanges?: (input: ServerHandlerContext<TContext> & { since: number | null }) =>
    | ServerChangesResult
    | Promise<ServerChangesResult>
  readSnapshot?: (input: ServerHandlerContext<TContext>) =>
    | ServerChangesResult
    | Promise<ServerChangesResult>
  update?: (
    input: ServerHandlerContext<TContext> & {
      op: UpdateSyncOp
      patch: JsonRecord
    },
  ) => ServerMutationResult | Promise<ServerMutationResult>
}

/** Handlers for a record collection. */
export type CollectionServerHandlers<TContext> = {
  readChanges?: (input: ServerHandlerContext<TContext> & { since: number | null }) =>
    | ServerChangesResult
    | Promise<ServerChangesResult>
  readSnapshot?: (input: ServerHandlerContext<TContext>) =>
    | ServerChangesResult
    | Promise<ServerChangesResult>
  create?: (
    input: ServerHandlerContext<TContext> & {
      op: CreateSyncOp
      record: JsonRecord
    },
  ) => ServerMutationResult | Promise<ServerMutationResult>
  update?: (
    input: ServerHandlerContext<TContext> & {
      op: UpdateSyncOp
      patch: JsonRecord
    },
  ) => ServerMutationResult | Promise<ServerMutationResult>
  delete?: (
    input: ServerHandlerContext<TContext> & {
      op: DeleteSyncOp
    },
  ) => ServerMutationResult | Promise<ServerMutationResult>
}

/** Server handler map keyed by schema account and collection names. */
export type ServerHandlers<TContext> = Record<
  string,
  AccountServerHandlers<TContext> | CollectionServerHandlers<TContext>
>

/** Options for creating a Fetch-compatible sync endpoint handler. */
export type ValtioSyncServerOptions<TSchema extends SyncSchema, TContext> = {
  schema: TSchema
  handlers: ServerHandlers<TContext>
  getContext?: (request: Request) => TContext | Promise<TContext>
}

/** Fetch-compatible sync server returned by the server entrypoint. */
export type ValtioSyncServer = {
  handle(request: Request): Promise<Response>
}

/** Error type used inside handlers to reject a sync operation with a protocol reason. */
export class SyncRejection extends Error {
  reason: SyncRejectionReason
  serverRecord?: JsonRecord
  serverVersion?: number

  constructor(
    reason: SyncRejectionReason,
    message?: string,
    options?: {
      serverRecord?: JsonRecord
      serverVersion?: number
    },
  ) {
    super(message ?? reason)
    this.reason = reason
    this.serverRecord = options?.serverRecord
    this.serverVersion = options?.serverVersion
  }
}

/** Reject the current sync operation from inside a server mutation handler. */
export function rejectSync(
  reason: SyncRejectionReason,
  message?: string,
  options?: {
    serverRecord?: JsonRecord
    serverVersion?: number
  },
): never {
  throw new SyncRejection(reason, message, options)
}

/** Create a server-side sync endpoint for a schema and handler map. */
export function valtioSync<
  const TSchema extends SyncSchema,
  TContext = undefined,
>(options: ValtioSyncServerOptions<TSchema, TContext>): ValtioSyncServer {
  const accountKey = String(getAccountKey(options.schema))
  const collectionKeys = getCollectionKeys(options.schema) as string[]

  return {
    async handle(request: Request): Promise<Response> {
      if (request.method && request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405)
      }

      let syncRequest: SyncRequest
      try {
        syncRequest = parseSyncRequest(await request.json())
      } catch (error) {
        return jsonResponse(
          {
            error: error instanceof Error ? error.message : 'Invalid sync request',
          },
          400,
        )
      }

      const ctx = options.getContext
        ? await options.getContext(request)
        : (undefined as TContext)
      const accepted: SyncResponse['accepted'] = []
      const rejected: RejectedSyncOp[] = []
      const changes: SyncResponse['changes'] = {}
      let serverSeq = syncRequest.lastServerSeq ?? 0

      for (const op of syncRequest.ops) {
        const result = await applyOp(options, accountKey, request, ctx, op)
        if ('rejected' in result) {
          rejected.push(result.rejected)
        } else {
          accepted.push(result.accepted)
          serverSeq = Math.max(serverSeq, result.accepted.serverVersion)
        }
      }

      for (const collection of [accountKey, ...collectionKeys]) {
        const responseCollection =
          collection === accountKey ? ACCOUNT_COLLECTION : collection
        const handler = options.handlers[collection]
        if (!handler) {
          continue
        }

        const readResult = await readCollectionChanges(
          handler,
          request,
          ctx,
          syncRequest.lastServerSeq,
        )
        if (!readResult) {
          continue
        }

        changes[responseCollection] = mergeChanges(
          changes[responseCollection],
          validateChanges(options.schema, responseCollection, readResult.changes),
        )
        serverSeq = Math.max(serverSeq, readResult.serverSeq ?? serverSeq)
      }

      const response: SyncResponse = {
        serverSeq,
        accepted,
        rejected,
        changes,
      }
      parseSyncResponse(response)
      return jsonResponse(response)
    },
  }
}

async function applyOp<TContext>(
  options: ValtioSyncServerOptions<SyncSchema, TContext>,
  accountKey: string,
  request: Request,
  ctx: TContext,
  op: SyncOp,
): Promise<
  | {
      accepted: SyncResponse['accepted'][number]
    }
  | {
      rejected: RejectedSyncOp
    }
> {
  try {
    const collection = op.collection === ACCOUNT_COLLECTION ? accountKey : op.collection
    const definition = getCollectionDefinition(options.schema, op.collection)
    const handler = options.handlers[collection]

    if (!definition || !handler) {
      rejectSync('not_found', `Unknown sync collection: ${op.collection}`)
    }
    if (op.collection === ACCOUNT_COLLECTION && op.id !== ACCOUNT_ID) {
      rejectSync('validation', 'Account operations must use the singleton id')
    }

    if (op.type === 'create') {
      if (!('create' in handler) || !handler.create) {
        rejectSync('not_found', `Collection ${op.collection} cannot create`)
      }
      const record = parseRecord(definition, op.value) as JsonRecord
      if (definition.kind === 'collection' && record.id !== op.id) {
        rejectSync('validation', 'Record id must match operation id')
      }
      const result = await handler.create({
        request,
        ctx,
        op,
        record,
      })
      return {
        accepted: {
          mutationId: op.mutationId,
          collection: op.collection,
          id: op.id,
          serverVersion: result.serverVersion,
          record: result.record
            ? parseReturnedRecord(definition, op.id, result.record)
            : undefined,
        },
      }
    }

    if (op.type === 'update') {
      if (!handler.update) {
        rejectSync('not_found', `Collection ${op.collection} cannot update`)
      }
      const patch = parsePatch(definition, op.patch) as JsonRecord
      const result = await handler.update({
        request,
        ctx,
        op,
        patch,
      })
      return {
        accepted: {
          mutationId: op.mutationId,
          collection: op.collection,
          id: op.id,
          serverVersion: result.serverVersion,
          record: result.record
            ? parseReturnedRecord(definition, op.id, result.record)
            : undefined,
        },
      }
    }

    if (!('delete' in handler) || !handler.delete) {
      rejectSync('not_found', `Collection ${op.collection} cannot delete`)
    }
    const result = await handler.delete({
      request,
      ctx,
      op,
    })
    return {
      accepted: {
        mutationId: op.mutationId,
        collection: op.collection,
        id: op.id,
        serverVersion: result.serverVersion,
        record: result.record
          ? parseReturnedRecord(definition, op.id, result.record)
          : undefined,
      },
    }
  } catch (error) {
    const rejection =
      error instanceof SyncRejection
        ? error
        : new SyncRejection(
            error instanceof ZodError ? 'validation' : 'server_error',
            error instanceof Error ? error.message : 'Invalid sync operation',
          )

    return {
      rejected: {
        mutationId: op.mutationId,
        collection: op.collection,
        id: op.id,
        reason: rejection.reason,
        message: rejection.message,
        serverRecord: rejection.serverRecord,
        serverVersion: rejection.serverVersion,
      },
    }
  }
}

async function readCollectionChanges<TContext>(
  handler: AccountServerHandlers<TContext> | CollectionServerHandlers<TContext>,
  request: Request,
  ctx: TContext,
  since: number | null,
): Promise<ServerChangesResult | null> {
  if (handler.readChanges) {
    return handler.readChanges({
      request,
      ctx,
      since,
    })
  }

  if (handler.readSnapshot) {
    const result = await handler.readSnapshot({
      request,
      ctx,
    })
    return {
      ...result,
      changes: {
        ...result.changes,
        mode: result.changes.mode ?? 'snapshot',
      },
    }
  }

  return null
}

function validateChanges(
  schema: SyncSchema,
  collection: string,
  changes: CollectionChanges,
): CollectionChanges {
  const definition = getCollectionDefinition(schema, collection)
  if (!definition) {
    throw new Error(`Unknown changed collection: ${collection}`)
  }

  return {
    mode: changes.mode,
    upserted: changes.upserted.map((change) => {
      assertEnvelopeId(definition, change.id)
      return {
        ...change,
        record: parseReturnedRecord(definition, change.id, change.record),
      }
    }),
    deleted: changes.deleted.map((change) => {
      assertEnvelopeId(definition, change.id)
      return change
    }),
  }
}

function parseReturnedRecord(
  definition: SchemaDefinition,
  envelopeId: string,
  value: unknown,
): JsonRecord {
  const record = parseRecord(definition, value) as JsonRecord
  if (definition.kind === 'collection' && record.id !== envelopeId) {
    throw new Error('Returned record id must match its envelope id')
  }
  return record
}

function assertEnvelopeId(definition: SchemaDefinition, id: string) {
  if (definition.kind === 'account' && id !== ACCOUNT_ID) {
    throw new Error('Account changes must use the singleton id')
  }
}

function mergeChanges(
  existing: CollectionChanges | undefined,
  next: CollectionChanges,
): CollectionChanges {
  if (!existing) {
    return next
  }

  return {
    mode:
      existing.mode === 'snapshot' || next.mode === 'snapshot'
        ? 'snapshot'
        : existing.mode ?? next.mode,
    upserted: [...existing.upserted, ...next.upserted],
    deleted: [...existing.deleted, ...next.deleted],
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  })
}
