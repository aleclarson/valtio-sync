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

/** Minimal Drizzle table shape used to read a table's selected row type. */
export type DrizzleSelectable = {
  readonly $inferSelect: Record<string, unknown>
}

/** Compile-time marker tying a valtio-sync definition to a Drizzle table type. */
export type DrizzleType<TTable extends DrizzleSelectable> = {
  readonly [drizzleTypeMarker]: TTable
}

/** Options for defining a schema entry whose fields must match a Drizzle row type. */
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

/** Capture a Drizzle table type for compile-time field compatibility checks. */
export function $type<TTable extends DrizzleSelectable>(): DrizzleType<TTable> {
  return {} as DrizzleType<TTable>
}

/** Define a singleton account state whose fields are checked against a Drizzle table row. */
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

/** Define a collection whose fields are checked against a Drizzle table row. */
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

/** Minimal transaction interface required by the Drizzle adapter. */
export type DrizzleLikeTransaction = {
  insert(table: unknown): {
    values(row: Record<string, unknown>): Promise<unknown> | unknown
  }
}

/** Minimal database interface required by the Drizzle adapter. */
export type DrizzleLikeDatabase<
  TTransaction extends DrizzleLikeTransaction = DrizzleLikeTransaction,
> = DrizzleLikeTransaction & {
  transaction?<T>(callback: (tx: TTransaction) => T | Promise<T>): Promise<T>
}

/** Input passed when the adapter records a sync event with an assigned sequence. */
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

/** Input passed before a sync event sequence has been assigned. */
export type DrizzleSyncEventWriteInput<
  TContext,
  TTransaction extends DrizzleLikeTransaction = DrizzleLikeTransaction,
> = Omit<DrizzleSyncEventInput<TContext, TTransaction>, 'seq'>

/** Configuration for writing sync events used by readChanges implementations. */
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

/** Shared mutation input passed to Drizzle-backed handlers. */
export type DrizzleMutationInput<
  TContext,
  TOp extends SyncOp,
  TTransaction extends DrizzleLikeTransaction = DrizzleLikeTransaction,
> = ServerHandlerContext<TContext> & {
  tx: TTransaction
  op: TOp
}

/** Input passed to Drizzle-backed create handlers. */
export type DrizzleCreateInput<
  TContext,
  TTransaction extends DrizzleLikeTransaction = DrizzleLikeTransaction,
> = DrizzleMutationInput<TContext, Extract<SyncOp, { type: 'create' }>, TTransaction> & {
  record: JsonRecord
}

/** Input passed to Drizzle-backed update handlers. */
export type DrizzleUpdateInput<
  TContext,
  TTransaction extends DrizzleLikeTransaction = DrizzleLikeTransaction,
> = DrizzleMutationInput<TContext, Extract<SyncOp, { type: 'update' }>, TTransaction> & {
  patch: JsonRecord
}

/** Input passed to Drizzle-backed delete handlers. */
export type DrizzleDeleteInput<
  TContext,
  TTransaction extends DrizzleLikeTransaction = DrizzleLikeTransaction,
> = DrizzleMutationInput<TContext, Extract<SyncOp, { type: 'delete' }>, TTransaction>

/** Mutation result for Drizzle handlers; serverVersion defaults to the written event sequence. */
export type DrizzleMutationResult = Omit<ServerMutationResult, 'serverVersion'> & {
  serverVersion?: number
}

/** Account handlers that receive a Drizzle transaction for mutations. */
export type DrizzleAccountHandlers<
  TContext,
  TTransaction extends DrizzleLikeTransaction = DrizzleLikeTransaction,
> = Omit<AccountServerHandlers<TContext>, 'update'> & {
  update?: (
    input: DrizzleUpdateInput<TContext, TTransaction>,
  ) => DrizzleMutationResult | Promise<DrizzleMutationResult>
}

/** Collection handlers that receive a Drizzle transaction for mutations. */
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

/** Input passed to the optional Drizzle authorization hook. */
export type DrizzleSyncAuthorizeInput<TContext> = {
  ctx: TContext
  collection: string
  op: SyncOp
}

/** Input passed to the optional Drizzle conflict hook inside the mutation transaction. */
export type DrizzleSyncConflictInput<
  TContext,
  TTransaction extends DrizzleLikeTransaction = DrizzleLikeTransaction,
> = DrizzleSyncAuthorizeInput<TContext> & {
  tx: TTransaction
}

/** Options for converting Drizzle-backed handlers into server handlers. */
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

/** Wrap Drizzle-backed mutation handlers with transactions and sync event sequencing. */
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
