import type { JsonRecord, SyncOp } from './protocol.js'
import * as schema from './schema.js'
import { z } from 'zod'
import type {
  AccountServerHandlers,
  CollectionServerHandlers,
  ServerHandlerContext,
  ServerHandlers,
  ServerMutationResult,
} from './server.js'

declare const drizzleTypeMarker: unique symbol
const serverOnlyMarker: unique symbol = Symbol('valtio-sync.serverOnly')

/** Minimal Drizzle table shape used to read a table's selected row type. */
export type DrizzleSelectable = {
  readonly $inferSelect: Record<string, unknown>
}

/** Compile-time marker tying a valtio-sync definition to a Drizzle table type. */
export type DrizzleType<TTable extends DrizzleSelectable> = {
  readonly [drizzleTypeMarker]: TTable
}

/** Branded sentinel for a selected Drizzle column that is excluded from sync records. */
export type ServerOnly = z.ZodNever & {
  readonly [serverOnlyMarker]: true
}

type DrizzleField = schema.FieldSchema | ServerOnly
type DrizzleFieldMap = Record<string, DrizzleField>

type SyncedFields<TFields extends DrizzleFieldMap> = {
  [K in keyof TFields as TFields[K] extends ServerOnly ? never : K]: Exclude<TFields[K], ServerOnly>
}

/** Options for defining a schema entry whose fields must match a Drizzle row type. */
export type DrizzleDefinitionOptions<
  TTable extends DrizzleSelectable,
  TFields extends DrizzleFieldMap,
> = {
  readonly dbType: DrizzleType<TTable>
  readonly fields: DrizzleCompatibleFields<TTable['$inferSelect'], TFields>
}

type DrizzleCompatibleFields<
  TRow extends Record<string, unknown>,
  TFields extends DrizzleFieldMap,
> = TFields & {
  [K in Exclude<keyof TFields, keyof TRow>]: never
} & {
  [K in Exclude<keyof TRow, keyof TFields>]-?: DrizzleField
} & {
  [K in keyof TFields & keyof TRow]: TFields[K] extends ServerOnly
    ? TFields[K]
    : TFields[K] extends schema.FieldSchema
      ? z.output<TFields[K]> extends TRow[K]
        ? TFields[K]
        : never
      : never
}

/** Capture a Drizzle table type for compile-time field compatibility checks. */
export function $type<TTable extends DrizzleSelectable>(): DrizzleType<TTable> {
  return {} as DrizzleType<TTable>
}

/** Mark a selected Drizzle column as persistence-only and exclude it from sync. */
export function serverOnly(): ServerOnly {
  const sentinel = z.never() as ServerOnly
  Object.defineProperty(sentinel, serverOnlyMarker, { value: true })
  return sentinel
}

function syncedFields<TFields extends DrizzleFieldMap>(fields: TFields): SyncedFields<TFields> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, field]) => !(serverOnlyMarker in field)),
  ) as SyncedFields<TFields>
}

/** Define a singleton account state whose fields are checked against a Drizzle table row. */
export function defineAccount<
  TTable extends DrizzleSelectable,
  const TFields extends DrizzleFieldMap,
>(
  options: DrizzleDefinitionOptions<TTable, TFields>,
): schema.AccountDefinition<SyncedFields<TFields>> {
  return schema.defineAccount({
    fields: syncedFields<TFields>(options.fields),
  })
}

/** Define a collection whose fields are checked against a Drizzle table row. */
export function defineCollection<
  TTable extends DrizzleSelectable,
  const TFields extends DrizzleFieldMap,
>(
  options: DrizzleDefinitionOptions<TTable, TFields>,
): schema.CollectionDefinition<SyncedFields<TFields>> {
  return schema.defineCollection({
    fields: syncedFields<TFields>(options.fields),
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
