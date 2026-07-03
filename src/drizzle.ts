import type { JsonRecord, SyncOp } from './protocol.js'
import * as schema from './schema.js'
import type {
  AccountServerHandlers,
  CollectionServerHandlers,
  ServerHandlerContext,
  ServerHandlers,
  ServerMutationResult,
} from './server.js'

declare const drizzleTypeMarker: unique symbol

export type DrizzleSelectable = {
  readonly $inferSelect: Record<string, unknown>
}

export type DrizzleType<TTable extends DrizzleSelectable> = {
  readonly [drizzleTypeMarker]: TTable
}

export type DrizzleDefinitionOptions<
  TTable extends DrizzleSelectable,
  TFields extends schema.FieldMap,
> = {
  readonly dbType: DrizzleType<TTable>
  readonly fields: DrizzleCompatibleFields<TTable['$inferSelect'], TFields>
}

type DrizzleCompatibleFields<
  TRow extends Record<string, unknown>,
  TFields extends schema.FieldMap,
> = TFields & {
  [K in Exclude<keyof TFields, keyof TRow>]: never
} & {
  [K in Exclude<keyof TRow, keyof TFields>]-?: schema.FieldSchema
} & {
  [K in keyof TFields & keyof TRow]: schema.InferFields<TFields>[K] extends TRow[K]
    ? TFields[K]
    : never
}

export function $type<TTable extends DrizzleSelectable>(): DrizzleType<TTable> {
  return {} as DrizzleType<TTable>
}

export function defineAccount<
  TTable extends DrizzleSelectable,
  const TFields extends schema.FieldMap,
>(
  options: DrizzleDefinitionOptions<TTable, TFields>,
): schema.AccountDefinition<TFields> {
  return schema.defineAccount({
    fields: options.fields,
  })
}

export function defineCollection<
  TTable extends DrizzleSelectable,
  const TFields extends schema.FieldMap,
>(
  options: DrizzleDefinitionOptions<TTable, TFields>,
): schema.CollectionDefinition<TFields> {
  return schema.defineCollection({
    fields: options.fields,
  })
}

export type DrizzleLikeTransaction = {
  insert(table: unknown): {
    values(row: Record<string, unknown>): Promise<unknown> | unknown
  }
}

export type DrizzleLikeDatabase<
  TTransaction extends DrizzleLikeTransaction = DrizzleLikeTransaction,
> = DrizzleLikeTransaction & {
  transaction?<T>(callback: (tx: TTransaction) => T | Promise<T>): Promise<T>
}

export type DrizzleSyncEventInput<
  TContext,
  TTransaction extends DrizzleLikeTransaction = DrizzleLikeTransaction,
> = {
  tx: TTransaction
  ctx: TContext
  collection: string
  recordId: string
  op: SyncOp['type']
  seq: number
}

export type DrizzleSyncEventWriteInput<
  TContext,
  TTransaction extends DrizzleLikeTransaction = DrizzleLikeTransaction,
> = Omit<DrizzleSyncEventInput<TContext, TTransaction>, 'seq'>

export type DrizzleSyncEventConfig<
  TContext,
  TTransaction extends DrizzleLikeTransaction = DrizzleLikeTransaction,
> =
  | {
      write(input: DrizzleSyncEventWriteInput<TContext, TTransaction>): number | Promise<number>
    }
  | {
      table: unknown
      nextSeq(input: DrizzleSyncEventWriteInput<TContext, TTransaction>): number | Promise<number>
      toRow(input: DrizzleSyncEventInput<TContext, TTransaction>): Record<string, unknown>
    }

export type DrizzleMutationInput<
  TContext,
  TOp extends SyncOp,
  TTransaction extends DrizzleLikeTransaction = DrizzleLikeTransaction,
> = ServerHandlerContext<TContext> & {
  tx: TTransaction
  op: TOp
}

export type DrizzleCreateInput<
  TContext,
  TTransaction extends DrizzleLikeTransaction = DrizzleLikeTransaction,
> = DrizzleMutationInput<TContext, Extract<SyncOp, { type: 'create' }>, TTransaction> & {
  record: JsonRecord
}

export type DrizzleUpdateInput<
  TContext,
  TTransaction extends DrizzleLikeTransaction = DrizzleLikeTransaction,
> = DrizzleMutationInput<TContext, Extract<SyncOp, { type: 'update' }>, TTransaction> & {
  patch: JsonRecord
}

export type DrizzleDeleteInput<
  TContext,
  TTransaction extends DrizzleLikeTransaction = DrizzleLikeTransaction,
> = DrizzleMutationInput<TContext, Extract<SyncOp, { type: 'delete' }>, TTransaction>

export type DrizzleMutationResult = Omit<ServerMutationResult, 'serverVersion'> & {
  serverVersion?: number
}

export type DrizzleAccountHandlers<
  TContext,
  TTransaction extends DrizzleLikeTransaction = DrizzleLikeTransaction,
> = Omit<AccountServerHandlers<TContext>, 'update'> & {
  update?: (
    input: DrizzleUpdateInput<TContext, TTransaction>,
  ) => DrizzleMutationResult | Promise<DrizzleMutationResult>
}

export type DrizzleCollectionHandlers<
  TContext,
  TTransaction extends DrizzleLikeTransaction = DrizzleLikeTransaction,
> = Omit<CollectionServerHandlers<TContext>, 'create' | 'update' | 'delete'> & {
  create?: (
    input: DrizzleCreateInput<TContext, TTransaction>,
  ) => DrizzleMutationResult | Promise<DrizzleMutationResult>
  update?: (
    input: DrizzleUpdateInput<TContext, TTransaction>,
  ) => DrizzleMutationResult | Promise<DrizzleMutationResult>
  delete?: (
    input: DrizzleDeleteInput<TContext, TTransaction>,
  ) => DrizzleMutationResult | Promise<DrizzleMutationResult>
}

export type DrizzleSyncAuthorizeInput<TContext> = {
  ctx: TContext
  collection: string
  op: SyncOp
}

export type DrizzleSyncConflictInput<
  TContext,
  TTransaction extends DrizzleLikeTransaction = DrizzleLikeTransaction,
> = DrizzleSyncAuthorizeInput<TContext> & {
  tx: TTransaction
}

export type ApplyOpsWithDrizzleOptions<
  TContext,
  TTransaction extends DrizzleLikeTransaction = DrizzleLikeTransaction,
> = {
  db: DrizzleLikeDatabase<TTransaction>
  syncEvents: DrizzleSyncEventConfig<TContext, TTransaction>
  handlers: Record<
    string,
    | DrizzleAccountHandlers<TContext, TTransaction>
    | DrizzleCollectionHandlers<TContext, TTransaction>
  >
  authorize?: (input: DrizzleSyncAuthorizeInput<TContext>) => void | Promise<void>
  checkConflict?: (input: DrizzleSyncConflictInput<TContext, TTransaction>) => void | Promise<void>
}

export function applyOpsWithDrizzle<
  TContext,
  TTransaction extends DrizzleLikeTransaction = DrizzleLikeTransaction,
>(options: ApplyOpsWithDrizzleOptions<TContext, TTransaction>): ServerHandlers<TContext> {
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

async function runMutation<
  TContext,
  TTransaction extends DrizzleLikeTransaction = DrizzleLikeTransaction,
>(
  options: ApplyOpsWithDrizzleOptions<TContext, TTransaction>,
  collection: string,
  op: SyncOp,
  ctx: TContext,
  mutate: (tx: TTransaction) => DrizzleMutationResult | Promise<DrizzleMutationResult>,
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
    const seq = await writeSyncEvent(options, {
      tx,
      ctx,
      collection,
      recordId: op.id,
      op: op.type,
    })

    return {
      ...result,
      serverVersion: result.serverVersion ?? seq,
    }
  })
}

async function writeSyncEvent<
  TContext,
  TTransaction extends DrizzleLikeTransaction = DrizzleLikeTransaction,
>(
  options: ApplyOpsWithDrizzleOptions<TContext, TTransaction>,
  input: DrizzleSyncEventWriteInput<TContext, TTransaction>,
): Promise<number> {
  if ('write' in options.syncEvents) {
    return options.syncEvents.write(input)
  }

  const seq = await options.syncEvents.nextSeq(input)
  await input.tx.insert(options.syncEvents.table).values(
    options.syncEvents.toRow({
      ...input,
      seq,
    }),
  )
  return seq
}

async function runTransaction<
  T,
  TTransaction extends DrizzleLikeTransaction = DrizzleLikeTransaction,
>(db: DrizzleLikeDatabase<TTransaction>, callback: (tx: TTransaction) => Promise<T>): Promise<T> {
  if (db.transaction) {
    return db.transaction(callback)
  }

  return callback(db as TTransaction)
}
