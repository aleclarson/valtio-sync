import type { JsonRecord, SyncOp } from './protocol.js'
import type {
  AccountServerHandlers,
  CollectionServerHandlers,
  ServerHandlerContext,
  ServerHandlers,
  ServerMutationResult,
} from './server.js'

export type DrizzleLikeDatabase = {
  transaction?<T>(callback: (tx: DrizzleLikeDatabase) => Promise<T>): Promise<T>
  insert(table: unknown): {
    values(row: Record<string, unknown>): Promise<unknown> | unknown
  }
}

export type DrizzleSyncEventInput<TContext> = {
  tx: DrizzleLikeDatabase
  ctx: TContext
  collection: string
  recordId: string
  op: SyncOp['type']
  seq: number
}

export type DrizzleSyncEventConfig<TContext> = {
  table: unknown
  nextSeq(input: Omit<DrizzleSyncEventInput<TContext>, 'seq'>): number | Promise<number>
  toRow(input: DrizzleSyncEventInput<TContext>): Record<string, unknown>
}

export type DrizzleMutationInput<TContext, TOp extends SyncOp> =
  ServerHandlerContext<TContext> & {
    tx: DrizzleLikeDatabase
    op: TOp
  }

export type DrizzleCreateInput<TContext> = DrizzleMutationInput<TContext, Extract<
  SyncOp,
  { type: 'create' }
>> & {
  record: JsonRecord
}

export type DrizzleUpdateInput<TContext> = DrizzleMutationInput<TContext, Extract<
  SyncOp,
  { type: 'update' }
>> & {
  patch: JsonRecord
}

export type DrizzleDeleteInput<TContext> = DrizzleMutationInput<TContext, Extract<
  SyncOp,
  { type: 'delete' }
>>

export type DrizzleMutationResult = Omit<ServerMutationResult, 'serverVersion'> & {
  serverVersion?: number
}

export type DrizzleAccountHandlers<TContext> = Omit<
  AccountServerHandlers<TContext>,
  'update'
> & {
  update?: (
    input: DrizzleUpdateInput<TContext>,
  ) => DrizzleMutationResult | Promise<DrizzleMutationResult>
}

export type DrizzleCollectionHandlers<TContext> = Omit<
  CollectionServerHandlers<TContext>,
  'create' | 'update' | 'delete'
> & {
  create?: (
    input: DrizzleCreateInput<TContext>,
  ) => DrizzleMutationResult | Promise<DrizzleMutationResult>
  update?: (
    input: DrizzleUpdateInput<TContext>,
  ) => DrizzleMutationResult | Promise<DrizzleMutationResult>
  delete?: (
    input: DrizzleDeleteInput<TContext>,
  ) => DrizzleMutationResult | Promise<DrizzleMutationResult>
}

export type DrizzleSyncAuthorizeInput<TContext> = {
  ctx: TContext
  collection: string
  op: SyncOp
}

export type DrizzleSyncConflictInput<TContext> = DrizzleSyncAuthorizeInput<TContext> & {
  tx: DrizzleLikeDatabase
}

export type ApplyOpsWithDrizzleOptions<TContext> = {
  db: DrizzleLikeDatabase
  syncEvents: DrizzleSyncEventConfig<TContext>
  handlers: Record<
    string,
    DrizzleAccountHandlers<TContext> | DrizzleCollectionHandlers<TContext>
  >
  authorize?: (input: DrizzleSyncAuthorizeInput<TContext>) => void | Promise<void>
  checkConflict?: (input: DrizzleSyncConflictInput<TContext>) => void | Promise<void>
}

export function applyOpsWithDrizzle<TContext>(
  options: ApplyOpsWithDrizzleOptions<TContext>,
): ServerHandlers<TContext> {
  const handlers: ServerHandlers<TContext> = {}

  for (const [collection, handler] of Object.entries(options.handlers)) {
    handlers[collection] = {
      readChanges: handler.readChanges,
      readSnapshot: handler.readSnapshot,
      create:
        'create' in handler && handler.create
          ? async (input) =>
              runMutation(options, collection, input.op, input.ctx, async (tx) =>
                handler.create!({
                  ...input,
                  tx,
                }),
              )
          : undefined,
      update: handler.update
        ? async (input) =>
            runMutation(options, collection, input.op, input.ctx, async (tx) =>
              handler.update!({
                ...input,
                tx,
              }),
            )
        : undefined,
      delete:
        'delete' in handler && handler.delete
          ? async (input) =>
              runMutation(options, collection, input.op, input.ctx, async (tx) =>
                handler.delete!({
                  ...input,
                  tx,
                }),
              )
          : undefined,
    }
  }

  return handlers
}

async function runMutation<TContext>(
  options: ApplyOpsWithDrizzleOptions<TContext>,
  collection: string,
  op: SyncOp,
  ctx: TContext,
  mutate: (tx: DrizzleLikeDatabase) => DrizzleMutationResult | Promise<DrizzleMutationResult>,
): Promise<ServerMutationResult> {
  return runTransaction(options.db, async (tx) => {
    await options.authorize?.({
      ctx,
      collection,
      op,
    })
    await options.checkConflict?.({
      tx,
      ctx,
      collection,
      op,
    })

    const result = await mutate(tx)
    const seq = await options.syncEvents.nextSeq({
      tx,
      ctx,
      collection,
      recordId: op.id,
      op: op.type,
    })
    await tx.insert(options.syncEvents.table).values(
      options.syncEvents.toRow({
        tx,
        ctx,
        collection,
        recordId: op.id,
        op: op.type,
        seq,
      }),
    )

    return {
      ...result,
      serverVersion: result.serverVersion ?? seq,
    }
  })
}

async function runTransaction<T>(
  db: DrizzleLikeDatabase,
  callback: (tx: DrizzleLikeDatabase) => Promise<T>,
): Promise<T> {
  if (db.transaction) {
    return db.transaction(callback)
  }

  return callback(db)
}
