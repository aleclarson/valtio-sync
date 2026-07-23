import { proxy, snapshot, subscribe, unstable_enableOp } from 'valtio/vanilla'
import type { INTERNAL_Op } from 'valtio/vanilla'
import type {
  JsonRecord,
  JsonValue,
  SyncError,
  SyncOp,
  SyncRequest,
  SyncResponse,
} from './protocol.js'
import { parseSyncResponse } from './protocol.js'
import {
  ACCOUNT_COLLECTION,
  ACCOUNT_ID,
  type AccountDefinition,
  type CollectionDefinition,
  type CollectionKey,
  type FieldMap,
  type InferFields,
  type SyncSchema,
  getAccountKey,
  getCollectionKeys,
  getDefaults,
  parseLocalState,
  parsePatch,
  parseRecord,
} from './schema.js'
import {
  type StoredAccount,
  type StoredRecord,
  type SyncStorage,
  type SyncStorageAdapter,
  type WebStorageLike,
  createIndexedDbSyncStorage,
  createMemoryWebStorage,
} from './storage.js'

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
export type {
  AccountDefinition,
  CollectionDefinition,
  FieldMap,
  InferFields,
  SyncSchema,
  infer,
} from './schema.js'
export type {
  StoredAccount,
  StoredRecord,
  SyncStorage,
  SyncStorageAdapter,
  WebStorageLike,
} from './storage.js'
export { createMemorySyncStorage, createMemoryWebStorage } from './storage.js'
export { createMemoryStorageAdapter } from './storage.js'

/** Serializable snapshot of all client-owned local data. */
export type LocalDataSnapshot = {
  account: JsonRecord
  collections: Record<string, StoredRecord[]>
  device: JsonRecord
  session: JsonRecord
}

/** Migration function used to upgrade persisted local data between schema versions. */
export type LocalMigration = (
  state: LocalDataSnapshot,
) => LocalDataSnapshot | Promise<LocalDataSnapshot>

/** Options for importing unsynced local data from another valtio-sync client. */
export type AdoptLocalDataOptions = {
  mode?: 'newAccount'
  copyLocalState?:
    | boolean
    | {
        device?: boolean
        session?: boolean
      }
  sync?: boolean
  clearSource?: 'never' | 'afterSuccessfulSync'
}

/** Request-level sync transport used by transport interceptors. Returning null drops the attempt. */
export type SyncTransport = (
  request: SyncRequest,
) => SyncResponse | null | Promise<SyncResponse | null>

/** Scoped middleware that can pass through, replace, modify, or drop sync transport calls. */
export type SyncTransportInterceptor = (
  request: SyncRequest,
  next: SyncTransport,
) => ReturnType<SyncTransport>

/** Prevent mutation operations from reaching the server while preserving ordinary pulls. */
export const preventRemoteWrites: SyncTransportInterceptor = (request, next) =>
  next({
    ...request,
    ops: [],
  })

/** Reactive client status flags and the latest sync error. */
export type ValtioSyncStatus = {
  phase: 'cold' | 'hydrating' | 'ready' | 'closed'
  syncing: boolean
  dirty: boolean
  online: boolean
  lastSyncAt: number | null
  lastError: SyncError | null
}

/** Result of a local-only collection pruning pass. */
export type LocalPruneResult = {
  readonly dryRun: boolean
  readonly requested: string[]
  readonly eligible: string[]
  readonly evicted: string[]
  readonly missing: string[]
  readonly protected: Array<{
    id: string
    reason: 'pending' | 'error' | 'changed'
  }>
}

/** Reactive collection facade for reading and mutating synced records. */
export type SyncedCollection<TRecord extends JsonRecord = JsonRecord> = {
  readonly name: string
  readonly records: Record<string, TRecord>
  create(value: Partial<TRecord> & { id?: string }): TRecord
  update(id: string, patch: Partial<TRecord>): void
  delete(id: string): void
  get(id: string): TRecord | undefined
  list(): TRecord[]
  pruneLocal(ids: readonly string[], options?: { dryRun?: boolean }): Promise<LocalPruneResult>
  flush(): Promise<void>
  sync(): Promise<void>
}

type CollectionMap<TSchema extends SyncSchema> = {
  [K in Extract<CollectionKey<TSchema>, string>]: TSchema[K] extends CollectionDefinition<
    infer TFields
  >
    ? SyncedCollection<InferFields<TFields> & JsonRecord>
    : never
}

const clientPropertyKeys = [
  'account',
  'device',
  'session',
  'status',
  'hydrate',
  'flush',
  'sync',
  'interceptTransport',
  'adoptLocalData',
  'clearLocalData',
  'clearCollection',
  'reset',
  'close',
  'debug',
] as const

type ClientPropertyKey = (typeof clientPropertyKeys)[number]

type ClientSchema<TSchema extends SyncSchema> = TSchema & {
  [K in Extract<CollectionKey<TSchema>, ClientPropertyKey>]: never
}

type AccountState<TSchema extends SyncSchema> =
  TSchema[Extract<keyof TSchema, string>] extends AccountDefinition<infer TFields>
    ? InferFields<TFields> & JsonRecord
    : JsonRecord

type LocalState<TFields extends FieldMap | undefined> = TFields extends FieldMap
  ? InferFields<TFields> & JsonRecord
  : JsonRecord

/** Client returned by the browser/client entrypoint. */
export type ValtioSyncClient<TSchema extends SyncSchema = SyncSchema> = CollectionMap<TSchema> & {
  readonly account: AccountState<TSchema>
  readonly device: JsonRecord
  readonly session: JsonRecord
  readonly status: ValtioSyncStatus
  hydrate(adapter?: SyncStorageAdapter): Promise<void>
  flush(): Promise<void>
  sync(): Promise<void>
  interceptTransport(interceptor: SyncTransportInterceptor): () => void
  adoptLocalData(source: ValtioSyncClient, options?: AdoptLocalDataOptions): Promise<void>
  clearLocalData(): Promise<void>
  clearCollection(collection: SyncedCollection): Promise<void>
  reset(): Promise<void>
  close(): void
  debug: {
    getStatus(): ValtioSyncStatus
    getDirtyRecords(): Array<{ collection: string; id: string; record: StoredRecord }>
    getPendingOps(): SyncOp[]
    getRecordMeta(collection: SyncedCollection, id: string): StoredRecord['meta'] | undefined
    getLastSyncRequest(): SyncRequest | null
    getLastSyncResponse(): SyncResponse | null
    clearLocalData(): Promise<void>
  }
}

/** Options for creating a valtio-sync client. */
export type ValtioSyncClientOptions<
  TSchema extends SyncSchema,
  TDevice extends FieldMap | undefined = undefined,
  TSession extends FieldMap | undefined = undefined,
> = {
  endpoint: string
  schema: ClientSchema<TSchema>
  /** Default local persistence adapter activated by `hydrate()`. */
  storage: SyncStorageAdapter
  device?: TDevice
  session?: TSession
  schemaVersion?: number
  conflict?: 'rejectStale' | 'lww' | 'serverWins'
  fetch?: typeof fetch
  migrations?: Record<number, LocalMigration>
}

type ClientInternals = {
  accountKey: string
  collectionKeys: string[]
  storage: SyncStorage | null
  status: ValtioSyncStatus
  accountMeta: StoredAccount['meta']
  accountData: JsonRecord
  recordMeta: Map<string, StoredRecord['meta']>
  storedRecords: Map<string, StoredRecord>
  recordCollections: Map<string, string>
  pendingOps: SyncOp[]
  lastSyncRequest: SyncRequest | null
  lastSyncResponse: SyncResponse | null
  flush(): Promise<void>
  sync(): Promise<void>
  waitUntilHydrated(): Promise<void>
  readLocalDataSnapshot(): Promise<LocalDataSnapshot>
  mutateCollection(collection: string, mutation: CollectionMutation): void
  pruneLocal(
    collection: string,
    ids: readonly string[],
    options?: { dryRun?: boolean },
  ): Promise<LocalPruneResult>
}

const clientInternalsKey = Symbol('valtio-sync client internals')

type ValtioSyncClientWithInternals = ValtioSyncClient & {
  [clientInternalsKey]: ClientInternals
}

type CollectionMutation =
  | {
      type: 'create'
      value: JsonRecord
    }
  | {
      type: 'update'
      id: string
      patch: JsonRecord
    }
  | {
      type: 'delete'
      id: string
    }

type ResolvedStorageContext = {
  namespace: string
  storage: SyncStorage
  localStorage: WebStorageLike
  sessionStorage: WebStorageLike
  broadcast: boolean
}

type PreparedStorageContext = {
  account: JsonRecord
  accountMeta: StoredAccount['meta']
  collections: Record<string, StoredRecord[]>
  device: JsonRecord
  session: JsonRecord
  error: SyncError | null
}

const adapterOwners = new WeakMap<SyncStorageAdapter, object>()
const storageOwners = new WeakMap<SyncStorage, object>()

unstable_enableOp()

/** Create a reactive sync client backed by local persistence and a server endpoint. */
export function valtioSync<
  const TSchema extends SyncSchema,
  const TDevice extends FieldMap | undefined = undefined,
  const TSession extends FieldMap | undefined = undefined,
>(
  options: ValtioSyncClientOptions<TSchema, TDevice, TSession>,
): ValtioSyncClient<TSchema> & {
  readonly device: LocalState<TDevice>
  readonly session: LocalState<TSession>
} {
  const accountKey = getAccountKey(options.schema)
  const accountDefinition = options.schema[accountKey] as AccountDefinition
  const collectionKeys = getCollectionKeys(options.schema) as string[]
  const reservedCollectionKey = collectionKeys.find((key) =>
    (clientPropertyKeys as readonly string[]).includes(key),
  )
  if (reservedCollectionKey) {
    throw new Error(`Collection name is reserved by the client API: ${reservedCollectionKey}`)
  }
  const schemaVersion = getTargetSchemaVersion(options.schemaVersion, options.migrations)
  const status = proxy<ValtioSyncStatus>({
    phase: 'cold',
    syncing: false,
    dirty: false,
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    lastSyncAt: null,
    lastError: null,
  })
  const accountDefaults = getDefaults(accountDefinition) as JsonRecord
  const deviceDefaults = getLocalDefaults(options.device)
  const sessionDefaults = getLocalDefaults(options.session)
  let account = createInertJsonRecord(accountDefaults)
  let device = createInertJsonRecord(deviceDefaults)
  let session = createInertJsonRecord(sessionDefaults)
  const recordMeta = new Map<string, StoredRecord['meta']>()
  const storedRecords = new Map<string, StoredRecord>()
  const recordCollections = new Map<string, string>()
  let collections: Record<string, SyncedCollection> = {}
  let stateSubscriptions: Array<() => void> = []
  let storage!: SyncStorage
  let localStorage!: WebStorageLike
  let sessionStorage!: WebStorageLike
  let storageNamespace = ''
  let deviceKey = ''
  let sessionKey = ''
  let channel: BroadcastChannel | null = null
  let accountMeta: StoredAccount['meta'] = {
    schemaVersion,
    lastServerSeq: null,
    sync: cleanMeta(null, 'system'),
  }
  let closed = false
  let trackingPaused = false
  let contextTransitionsPending = 0
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryAttempt = 0
  let writeQueue = Promise.resolve()
  let reconciliationQueue = Promise.resolve()
  let contextTransitionQueue = Promise.resolve()
  let activeSyncPromise: Promise<void> | undefined
  const inFlightMutationIds = new Set<string>()
  const transportInterceptors: Array<{ interceptor: SyncTransportInterceptor }> = []
  const owner = {}
  const defaultAdapter = options.storage
  const contextsByAdapter = new WeakMap<SyncStorageAdapter, ResolvedStorageContext>()
  const ownedAdapters = new Set<SyncStorageAdapter>()
  const ownedStorages = new Set<SyncStorage>()
  let activeContext: ResolvedStorageContext | null = null

  claimAdapter(defaultAdapter)
  class SyncTransportError extends Error {
    readonly reason: 'auth' | 'network'

    constructor(reason: 'auth' | 'network', message: string) {
      super(message)
      this.reason = reason
    }
  }

  const internals: ClientInternals = {
    accountKey: String(accountKey),
    collectionKeys,
    storage: null,
    status,
    accountMeta,
    accountData: cloneJsonRecord(accountDefaults),
    recordMeta,
    storedRecords,
    recordCollections,
    pendingOps: [],
    lastSyncRequest: null,
    lastSyncResponse: null,
    flush: async () => flush(),
    sync: async () => sync(),
    waitUntilHydrated: async () => waitUntilHydrated(),
    readLocalDataSnapshot: async () => readLocalDataSnapshot(),
    mutateCollection: (collection, mutation) => mutateCollection(collection, mutation),
    pruneLocal: (collection, ids, pruneOptions) => pruneLocal(collection, ids, pruneOptions),
  }

  collections = createInertCollections(collectionKeys, internals)

  function claimAdapter(adapter: SyncStorageAdapter) {
    const adapterOwner = adapterOwners.get(adapter)
    if (adapterOwner && adapterOwner !== owner) {
      throw new Error('A sync storage adapter can belong to only one live valtio-sync client')
    }

    if (adapter.storage) {
      const storageOwner = storageOwners.get(adapter.storage)
      if (storageOwner && storageOwner !== owner) {
        throw new Error('Sync storage can belong to only one live valtio-sync client')
      }
    }

    adapterOwners.set(adapter, owner)
    ownedAdapters.add(adapter)
    if (adapter.storage) {
      storageOwners.set(adapter.storage, owner)
      ownedStorages.add(adapter.storage)
    }
  }

  function getStorageContext(adapter: SyncStorageAdapter): ResolvedStorageContext {
    claimAdapter(adapter)
    const cached = contextsByAdapter.get(adapter)
    if (cached) {
      return cached
    }

    const context = resolveStorageContext(adapter, collectionKeys)
    const storageOwner = storageOwners.get(context.storage)
    if (storageOwner && storageOwner !== owner) {
      throw new Error('Sync storage can belong to only one live valtio-sync client')
    }
    storageOwners.set(context.storage, owner)
    ownedStorages.add(context.storage)
    contextsByAdapter.set(adapter, context)
    return context
  }

  function hideActiveState() {
    for (const unsubscribe of stateSubscriptions) {
      unsubscribe()
    }
    stateSubscriptions = []
    assignClientState(
      createInertJsonRecord(accountDefaults),
      createInertJsonRecord(deviceDefaults),
      createInertJsonRecord(sessionDefaults),
      createInertCollections(collectionKeys, internals),
    )
  }

  function publishActiveState() {
    assignClientState(account, device, session, collections)
  }

  function assignClientState(
    nextAccount: JsonRecord,
    nextDevice: JsonRecord,
    nextSession: JsonRecord,
    nextCollections: Record<string, SyncedCollection>,
  ) {
    Object.assign(client, nextCollections, {
      account: nextAccount,
      device: nextDevice,
      session: nextSession,
    })
  }

  function subscribeToActiveState() {
    for (const unsubscribe of stateSubscriptions) {
      unsubscribe()
    }
    stateSubscriptions = [
      subscribe(
        device,
        () => {
          if (status.phase === 'ready' && contextTransitionsPending === 0) {
            persistWebState(localStorage, deviceKey, snapshotJsonRecord(device), status)
          }
        },
        true,
      ),
      subscribe(
        session,
        () => {
          if (status.phase === 'ready' && contextTransitionsPending === 0) {
            persistWebState(sessionStorage, sessionKey, snapshotJsonRecord(session), status)
          }
        },
        true,
      ),
      subscribe(
        account,
        (ops) => {
          if (status.phase === 'ready' && !trackingPaused && contextTransitionsPending === 0) {
            void markAccountDirty(ops)
          }
        },
        true,
      ),
    ]
    for (const [collection, collectionState] of Object.entries(collections)) {
      stateSubscriptions.push(
        subscribe(
          collectionState.records,
          (ops) => {
            if (status.phase === 'ready' && !trackingPaused && contextTransitionsPending === 0) {
              void markRecordMutations(collection, ops)
            }
          },
          true,
        ),
      )
    }
  }

  function hydrate(adapter: SyncStorageAdapter = defaultAdapter): Promise<void> {
    if (closed) {
      return Promise.reject(new Error('Cannot hydrate a closed valtio-sync client'))
    }

    let context: ResolvedStorageContext
    try {
      context = getStorageContext(adapter)
    } catch (error) {
      return Promise.reject(error)
    }

    contextTransitionsPending += 1
    status.phase = 'hydrating'
    hideActiveState()

    const result = enqueueContextTransition(async () => {
      const previousContext = activeContext
      try {
        if (closed) {
          throw new Error('Cannot hydrate a closed valtio-sync client')
        }
        await activateStorageContext(context)
        activeContext = context
      } catch (error) {
        if (previousContext) {
          try {
            await activateStorageContext(previousContext)
            activeContext = previousContext
          } catch {
            // Keep the original failure. The previous context remains the logical active context,
            // even if its storage cannot currently be read again.
          }
        }
        throw error
      }
    })

    return result.finally(() => {
      contextTransitionsPending -= 1
      if (contextTransitionsPending === 0 && !closed) {
        if (activeContext) {
          publishActiveState()
          status.phase = 'ready'
        } else {
          status.phase = 'cold'
        }
      }
    })
  }

  function enqueueContextTransition<T>(transition: () => Promise<T>): Promise<T> {
    const result = contextTransitionQueue.then(transition, transition)
    contextTransitionQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async function activateStorageContext(context: ResolvedStorageContext) {
    await settleActiveContext()
    // Read, migrate, and validate the destination before changing the live context. A failed
    // adapter therefore cannot strand the client between two persistence backends.
    const prepared = await prepareStorageContext(context)
    if (closed) {
      throw new Error('Cannot hydrate a closed valtio-sync client')
    }

    channel?.close()
    channel = null
    storage = context.storage
    localStorage = context.localStorage
    sessionStorage = context.sessionStorage
    storageNamespace = context.namespace
    deviceKey = storageKey(storageNamespace, 'device')
    sessionKey = storageKey(storageNamespace, 'session')
    internals.storage = storage
    installPreparedStorageContext(prepared)
    attachBroadcastChannel(context)
  }

  async function settleActiveContext() {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
    // Queued writes close over the mutable active storage variables. They must finish before an
    // adapter switch or an old mutation could be written into the newly activated context.
    await reconciliationQueue
    await writeQueue
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
  }

  async function prepareStorageContext(
    context: ResolvedStorageContext,
  ): Promise<PreparedStorageContext> {
    const candidateStatus: ValtioSyncStatus = {
      phase: 'hydrating',
      syncing: false,
      dirty: false,
      online: status.online,
      lastSyncAt: null,
      lastError: null,
    }
    const contextDeviceKey = storageKey(context.namespace, 'device')
    const contextSessionKey = storageKey(context.namespace, 'session')
    let nextDevice = readWebState(
      options.device,
      context.localStorage,
      contextDeviceKey,
      candidateStatus,
    )
    let nextSession = readWebState(
      options.session,
      context.sessionStorage,
      contextSessionKey,
      candidateStatus,
    )
    let storedAccount = await context.storage.readAccount()
    const collectionsSnapshot: Record<string, StoredRecord[]> = {}
    for (const key of collectionKeys) {
      collectionsSnapshot[key] = await context.storage.listRecords(key)
    }

    let state: LocalDataSnapshot = {
      account: storedAccount?.data ?? (getDefaults(accountDefinition) as JsonRecord),
      collections: collectionsSnapshot,
      device: nextDevice,
      session: nextSession,
    }
    const currentVersion = storedAccount?.meta.schemaVersion ?? 1
    if (currentVersion < schemaVersion) {
      state = await migrateLocalData(state, currentVersion, schemaVersion, options.migrations)
      const migratedMeta: StoredAccount['meta'] = {
        schemaVersion,
        lastServerSeq: storedAccount?.meta.lastServerSeq ?? null,
        sync: storedAccount?.meta.sync ?? cleanMeta(null, currentDeviceId(state.device)),
      }
      await writeStorageContextSnapshot(context, state, migratedMeta, candidateStatus)
      storedAccount = {
        data: state.account,
        meta: migratedMeta,
      }
      nextDevice = parseLocalOrDefaults(options.device, state.device, candidateStatus)
      nextSession = parseLocalOrDefaults(options.session, state.session, candidateStatus)
    }

    const nextAccount = parseRecordOrDefaults(accountDefinition, state.account, candidateStatus)
    const nextAccountMeta: StoredAccount['meta'] = {
      schemaVersion,
      lastServerSeq: storedAccount?.meta.lastServerSeq ?? null,
      sync: ensureMutationId(
        storedAccount?.meta.sync ?? cleanMeta(null, currentDeviceId(nextDevice)),
      ),
    }
    const parsedCollections: Record<string, StoredRecord[]> = {}
    for (const key of collectionKeys) {
      const definition = options.schema[key]
      parsedCollections[key] = []
      if (!definition || definition.kind !== 'collection') {
        continue
      }
      for (const record of state.collections[key] ?? []) {
        try {
          const normalizedRecord = {
            ...record,
            data: parseRecord(definition, record.data) as JsonRecord,
            meta: ensureMutationId(record.meta),
          }
          parsedCollections[key].push(normalizedRecord)
          if (normalizedRecord.meta !== record.meta) {
            await context.storage.writeRecord(key, normalizedRecord)
          }
        } catch (error) {
          setStatusError(candidateStatus, {
            reason: 'validation',
            message: error instanceof Error ? error.message : 'Invalid cached record',
          })
        }
      }
    }

    await context.storage.writeAccount({
      data: nextAccount,
      meta: nextAccountMeta,
    })
    persistWebState(context.localStorage, contextDeviceKey, nextDevice, candidateStatus)
    persistWebState(context.sessionStorage, contextSessionKey, nextSession, candidateStatus)

    return {
      account: nextAccount,
      accountMeta: nextAccountMeta,
      collections: parsedCollections,
      device: nextDevice,
      session: nextSession,
      error: candidateStatus.lastError,
    }
  }

  async function writeStorageContextSnapshot(
    context: ResolvedStorageContext,
    state: LocalDataSnapshot,
    meta: StoredAccount['meta'],
    candidateStatus: ValtioSyncStatus,
  ) {
    await context.storage.writeAccount({ data: state.account, meta })
    for (const key of collectionKeys) {
      await context.storage.clearCollection(key)
      for (const record of state.collections[key] ?? []) {
        await context.storage.writeRecord(key, record)
      }
    }
    persistWebState(
      context.localStorage,
      storageKey(context.namespace, 'device'),
      state.device,
      candidateStatus,
    )
    persistWebState(
      context.sessionStorage,
      storageKey(context.namespace, 'session'),
      state.session,
      candidateStatus,
    )
  }

  function installPreparedStorageContext(prepared: PreparedStorageContext) {
    account = proxy<JsonRecord>(prepared.account)
    device = proxy<JsonRecord>(prepared.device)
    session = proxy<JsonRecord>(prepared.session)
    collections = {}
    accountMeta = prepared.accountMeta
    internals.accountMeta = accountMeta
    internals.accountData = prepared.account
    recordMeta.clear()
    storedRecords.clear()
    for (const key of collectionKeys) {
      const records = proxy<Record<string, JsonRecord>>({})
      collections[key] = makeCollection(key, records, internals)
      hydrateCollectionFromRecords(key, prepared.collections[key] ?? [])
    }
    subscribeToActiveState()
    retryAttempt = 0
    internals.lastSyncRequest = null
    internals.lastSyncResponse = null
    status.lastError = prepared.error
    status.lastSyncAt = null
    refreshPendingOps(internals)
    status.dirty = internals.pendingOps.length > 0
  }

  function attachBroadcastChannel(context: ResolvedStorageContext) {
    channel = createBroadcastChannel(context.namespace, context.broadcast)
    if (!channel) {
      return
    }
    channel.onmessage = (event) => {
      const message = event.data as BroadcastMessage
      if (message.namespace !== storageNamespace || closed || contextTransitionsPending > 0) {
        return
      }
      if (message.type === 'clear') {
        void resetProxiesToDefaults()
      } else if (message.type === 'collectionChanged' && message.collection) {
        void writeQueue.then(() => hydrateCollection(message.collection!))
      }
    }
  }

  async function readLocalDataSnapshot(
    storedAccount?: StoredAccount | null,
  ): Promise<LocalDataSnapshot> {
    if (storedAccount === undefined) {
      storedAccount = await storage.readAccount()
    }
    const collectionsSnapshot: Record<string, StoredRecord[]> = {}

    for (const key of collectionKeys) {
      collectionsSnapshot[key] = await storage.listRecords(key)
    }

    return {
      account: storedAccount?.data ?? (getDefaults(accountDefinition) as JsonRecord),
      collections: collectionsSnapshot,
      device: snapshotJsonRecord(device),
      session: snapshotJsonRecord(session),
    }
  }

  async function hydrateCollection(collection: string) {
    const definition = options.schema[collection]
    const collectionState = collections[collection]
    if (!definition || definition.kind !== 'collection' || !collectionState) {
      return
    }
    hydrateCollectionFromRecords(collection, await storage.listRecords(collection))
    refreshPendingOps(internals)
    status.dirty = internals.pendingOps.length > 0
  }

  function hydrateCollectionFromRecords(collection: string, records: StoredRecord[]) {
    const definition = options.schema[collection]
    const collectionState = collections[collection]
    if (!definition || definition.kind !== 'collection' || !collectionState) {
      return
    }

    const nextRecords: Record<string, JsonRecord> = {}
    for (const key of storedRecords.keys()) {
      if (key.startsWith(`${collection}:`)) {
        storedRecords.delete(key)
        recordMeta.delete(key)
      }
    }
    for (const record of records) {
      try {
        const parsed = parseRecord(definition, record.data) as JsonRecord
        const meta = ensureMutationId(record.meta)
        const normalizedRecord = {
          ...record,
          data: parsed,
          meta,
        }
        recordMeta.set(metaKey(collection, record.id), meta)
        storedRecords.set(metaKey(collection, record.id), normalizedRecord)
        if (meta !== record.meta) {
          enqueueStorageWrite(() => storage.writeRecord(collection, normalizedRecord))
        }
        recordCollections.set(collectionState.name, collection)
        if (!record.meta.deleted) {
          nextRecords[record.id] = parsed
        }
      } catch (error) {
        setStatusError(status, {
          reason: 'validation',
          message: error instanceof Error ? error.message : 'Invalid cached record',
        })
      }
    }
    runWithoutTracking(() => {
      replaceObject(collectionState.records, nextRecords)
    })
  }

  async function resetProxiesToDefaults() {
    runWithoutTracking(() => {
      replaceObject(account, getDefaults(accountDefinition) as JsonRecord)
      replaceObject(device, getLocalDefaults(options.device))
      replaceObject(session, getLocalDefaults(options.session))
      for (const collection of Object.values(collections)) {
        replaceObject(collection.records, {})
      }
      recordMeta.clear()
      storedRecords.clear()
      internals.pendingOps = []
      status.dirty = false
      status.lastError = null
      accountMeta = {
        schemaVersion,
        lastServerSeq: null,
        sync: cleanMeta(null, 'system'),
      }
      internals.accountMeta = accountMeta
      internals.accountData = snapshotJsonRecord(account)
    })
  }

  async function flush(): Promise<void> {
    assertPersistedOperationCanQueue()
    return enqueueContextTransition(async () => {
      assertHydrated()
      await flushActiveContext()
    })
  }

  async function flushActiveContext(): Promise<void> {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }
    await writeQueue
    refreshPendingOps(internals)
  }

  async function sync(): Promise<void> {
    assertPersistedOperationCanQueue()
    if (activeSyncPromise) {
      return activeSyncPromise
    }

    activeSyncPromise = enqueueContextTransition(async () => {
      assertHydrated()
      await performSync()
    })
    try {
      await activeSyncPromise
    } finally {
      activeSyncPromise = undefined
    }
  }

  async function performSync(): Promise<void> {
    await flushActiveContext()
    if (closed) {
      return
    }

    const request: SyncRequest = {
      clientId: currentDeviceId(device),
      schemaVersion,
      lastServerSeq: accountMeta.lastServerSeq,
      ops: [...internals.pendingOps],
    }

    internals.lastSyncRequest = request
    status.syncing = true
    for (const op of request.ops) {
      inFlightMutationIds.add(op.mutationId)
    }

    try {
      const transport = transportInterceptors.reduceRight<SyncTransport>(
        (next, registration) => (nextRequest) => registration.interceptor(nextRequest, next),
        sendSyncRequest,
      )
      const interceptedResponse = await transport(request)
      if (interceptedResponse === null) {
        return
      }

      const syncResponse = parseSyncResponse(interceptedResponse)
      internals.lastSyncResponse = syncResponse
      status.lastError = null
      await enqueueReconciliation(() => applySyncResponse(syncResponse, request.ops))
      accountMeta = {
        ...accountMeta,
        lastServerSeq: syncResponse.serverSeq,
      }
      internals.accountMeta = accountMeta
      await storage.writeAccount({
        data: snapshotJsonRecord(account),
        meta: accountMeta,
      })
      retryAttempt = 0
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = undefined
      }
      status.lastSyncAt = Date.now()
    } catch (error) {
      const reason = error instanceof SyncTransportError ? error.reason : 'network'
      setStatusError(status, {
        reason,
        message: error instanceof Error ? error.message : 'Sync request failed',
      })
      if (reason !== 'auth') {
        scheduleRetry()
      }
    } finally {
      for (const op of request.ops) {
        inFlightMutationIds.delete(op.mutationId)
      }
      status.syncing = false
      refreshPendingOps(internals)
      status.dirty = internals.pendingOps.length > 0
    }
  }

  async function waitUntilHydrated() {
    await contextTransitionQueue
    assertHydrated()
  }

  function assertHydrated() {
    if (closed) {
      throw new Error('Cannot use a closed valtio-sync client')
    }
    if (!activeContext) {
      throw new Error('Call hydrate() before using persisted valtio-sync operations')
    }
  }

  function assertPersistedOperationCanQueue() {
    assertHydrated()
  }

  async function sendSyncRequest(request: SyncRequest): Promise<SyncResponse> {
    const fetchSync = options.fetch ?? globalThis.fetch
    if (!fetchSync) {
      throw new SyncTransportError(
        'network',
        'No fetch implementation is available for valtio-sync',
      )
    }

    const response = await fetchSync(options.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
    })

    if (!response.ok) {
      const message = await response.text().catch(() => response.statusText)
      throw new SyncTransportError(
        response.status === 401 || response.status === 403 ? 'auth' : 'network',
        message || response.statusText,
      )
    }

    return parseSyncResponse(await response.json())
  }

  function interceptTransport(interceptor: SyncTransportInterceptor): () => void {
    if (closed) {
      throw new Error('Cannot intercept transport on a closed valtio-sync client')
    }

    const registration = { interceptor }
    transportInterceptors.push(registration)
    let removed = false
    return () => {
      if (removed) {
        return
      }
      removed = true
      const index = transportInterceptors.indexOf(registration)
      if (index !== -1) {
        transportInterceptors.splice(index, 1)
      }
    }
  }

  async function applySyncResponse(response: SyncResponse, sentOps: SyncOp[]) {
    const sentByMutation = new Map(sentOps.map((op) => [op.mutationId, op]))

    for (const accepted of response.accepted) {
      const op = sentByMutation.get(accepted.mutationId)
      if (!op) {
        continue
      }
      assertResponseOpIdentity(op, accepted.collection, accepted.id)
      await applyAcceptedOp(op, accepted.serverVersion, accepted.record)
    }

    for (const rejected of response.rejected) {
      const op = sentByMutation.get(rejected.mutationId)
      if (!op) {
        continue
      }
      assertResponseOpIdentity(op, rejected.collection, rejected.id)
      await applyRejectedOp(op, {
        reason: rejected.reason,
        message: rejected.message,
      })
    }

    for (const [collection, changes] of Object.entries(response.changes)) {
      const snapshotIds = changes.mode === 'snapshot' ? new Set<string>() : null
      for (const change of changes.upserted) {
        snapshotIds?.add(change.id)
        await applyRemoteUpsert(collection, change.id, change.record, change.serverVersion)
      }
      for (const change of changes.deleted) {
        snapshotIds?.add(change.id)
        await applyRemoteDelete(collection, change.id, change.serverVersion)
      }
      if (snapshotIds) {
        await pruneSnapshotRecords(collection, snapshotIds)
      }
    }
  }

  async function applyAcceptedOp(
    op: SyncOp,
    serverVersion: number,
    canonicalRecord: JsonRecord | undefined,
  ) {
    if (op.collection === ACCOUNT_COLLECTION) {
      const currentSync = accountMeta.sync
      const hasNewerMutation =
        currentSync?.dirty === true && currentSync.mutationId !== op.mutationId
      const currentAccount = snapshotJsonRecord(account)
      const canonicalAccount = canonicalRecord
        ? (parseRecord(accountDefinition, canonicalRecord) as JsonRecord)
        : currentAccount
      const nextAccount = hasNewerMutation
        ? overlayTouched(canonicalAccount, currentAccount, currentSync.touched ?? [])
        : canonicalAccount
      accountMeta = {
        ...accountMeta,
        sync: hasNewerMutation
          ? {
              ...currentSync,
              serverVersion,
              baseServerVersion: serverVersion,
              lastSyncedAt: Date.now(),
            }
          : {
              ...cleanMeta(serverVersion, currentDeviceId(device)),
              lastSyncedAt: Date.now(),
            },
      }
      internals.accountMeta = accountMeta
      internals.accountData = nextAccount
      runWithoutTracking(() => {
        replaceObject(account, nextAccount)
      })
      return
    }

    const collectionState = collections[op.collection]
    const definition = options.schema[op.collection]
    if (!collectionState || !definition || definition.kind !== 'collection') {
      return
    }

    if (op.type === 'delete') {
      const key = metaKey(op.collection, op.id)
      storedRecords.delete(key)
      recordMeta.delete(key)
      runWithoutTracking(() => {
        delete collectionState.records[op.id]
      })
      await storage.deleteRecord(op.collection, op.id)
      return
    }

    const key = metaKey(op.collection, op.id)
    const existing = storedRecords.get(key)
    const hasNewerMutation =
      existing?.meta.dirty === true && existing.meta.mutationId !== op.mutationId
    const currentRecord = collectionState.records[op.id]
    const canonicalData = canonicalRecord
      ? (parseRecord(definition, canonicalRecord) as JsonRecord)
      : undefined
    if (canonicalData) {
      assertWireRecordIdentity(op.collection, op.id, canonicalData)
    }
    const data = hasNewerMutation
      ? canonicalData
        ? overlayTouched(canonicalData, existing.data, existing.meta.touched ?? [])
        : existing.data
      : (canonicalData ?? currentRecord ?? existing?.data)

    if (!data) {
      return
    }

    const record: StoredRecord = {
      id: op.id,
      data,
      meta: hasNewerMutation
        ? {
            ...existing.meta,
            serverVersion,
            baseServerVersion: serverVersion,
            lastSyncedAt: Date.now(),
          }
        : {
            ...cleanMeta(serverVersion, currentDeviceId(device)),
            lastSyncedAt: Date.now(),
          },
    }
    runWithoutTracking(() => {
      if (record.meta.deleted) {
        delete collectionState.records[op.id]
      } else {
        collectionState.records[op.id] = data
      }
    })
    persistStoredRecord(op.collection, record)
  }

  async function applyRejectedOp(op: SyncOp, error: SyncError) {
    if (op.collection === ACCOUNT_COLLECTION) {
      const hasNewerMutation =
        accountMeta.sync?.dirty === true && accountMeta.sync.mutationId !== op.mutationId
      accountMeta = {
        ...accountMeta,
        sync: {
          ...(accountMeta.sync ?? cleanMeta(null, currentDeviceId(device))),
          dirty: hasNewerMutation,
          lastError: hasNewerMutation ? undefined : error,
        },
      }
      internals.accountMeta = accountMeta
      await storage.writeAccount({
        data: snapshotJsonRecord(account),
        meta: accountMeta,
      })
      setStatusError(status, error)
      return
    }

    const key = metaKey(op.collection, op.id)
    const existing = storedRecords.get(key)
    if (!existing) {
      return
    }

    const hasNewerMutation =
      existing.meta.dirty === true && existing.meta.mutationId !== op.mutationId
    const rejectedRecord: StoredRecord = {
      ...existing,
      meta: {
        ...existing.meta,
        dirty: hasNewerMutation,
        lastError: hasNewerMutation ? undefined : error,
      },
    }
    persistStoredRecord(op.collection, rejectedRecord)
    setStatusError(status, error)
  }

  async function applyRemoteUpsert(
    collection: string,
    id: string,
    record: JsonRecord,
    serverVersion: number,
  ) {
    if (collection === ACCOUNT_COLLECTION) {
      assertWireRecordIdentity(collection, id, record)
      const syncMeta = accountMeta.sync ?? cleanMeta(null, currentDeviceId(device))
      if (syncMeta.dirty) {
        const error: SyncError = {
          reason: 'conflict',
          message: 'Remote account change conflicts with local dirty state',
        }
        accountMeta = {
          ...accountMeta,
          sync: {
            ...syncMeta,
            dirty: false,
            lastError: error,
          },
        }
        internals.accountMeta = accountMeta
        setStatusError(status, error)
        return
      }

      const parsed = parseRecord(accountDefinition, record) as JsonRecord
      accountMeta = {
        ...accountMeta,
        sync: cleanMeta(serverVersion, currentDeviceId(device)),
      }
      internals.accountMeta = accountMeta
      internals.accountData = parsed
      runWithoutTracking(() => {
        replaceObject(account, parsed)
      })
      return
    }

    const collectionState = collections[collection]
    const definition = options.schema[collection]
    if (!collectionState || !definition || definition.kind !== 'collection') {
      return
    }

    const parsed = parseRecord(definition, record) as JsonRecord
    assertWireRecordIdentity(collection, id, parsed)
    const key = metaKey(collection, id)
    const existing = storedRecords.get(key)
    if (existing?.meta.dirty) {
      const error: SyncError = {
        reason: 'conflict',
        message: `Remote change conflicts with local dirty record ${collection}:${id}`,
      }
      const conflictRecord: StoredRecord = {
        ...existing,
        meta: {
          ...existing.meta,
          dirty: false,
          lastError: error,
        },
      }
      persistStoredRecord(collection, conflictRecord)
      setStatusError(status, error)
      return
    }

    const storedRecord: StoredRecord = {
      id,
      data: parsed,
      meta: cleanMeta(serverVersion, currentDeviceId(device)),
    }
    runWithoutTracking(() => {
      collectionState.records[id] = parsed
    })
    persistStoredRecord(collection, storedRecord)
  }

  async function applyRemoteDelete(collection: string, id: string, serverVersion: number) {
    if (collection === ACCOUNT_COLLECTION) {
      throw new Error('Remote account deletion is not supported')
    }
    const collectionState = collections[collection]
    if (!collectionState) {
      return
    }

    const key = metaKey(collection, id)
    const existing = storedRecords.get(key)
    if (existing?.meta.dirty) {
      const error: SyncError = {
        reason: 'conflict',
        message: `Remote delete conflicts with local dirty record ${collection}:${id}`,
      }
      const conflictRecord: StoredRecord = {
        ...existing,
        meta: {
          ...existing.meta,
          dirty: false,
          lastError: error,
        },
      }
      persistStoredRecord(collection, conflictRecord)
      setStatusError(status, error)
      return
    }

    runWithoutTracking(() => {
      delete collectionState.records[id]
    })
    storedRecords.set(key, {
      id,
      data: existing?.data ?? ({ id } as JsonRecord),
      meta: {
        ...cleanMeta(serverVersion, currentDeviceId(device)),
        deleted: true,
      },
    })
    recordMeta.set(key, storedRecords.get(key)!.meta)
    await storage.deleteRecord(collection, id)
  }

  async function pruneSnapshotRecords(collection: string, snapshotIds: Set<string>) {
    if (collection === ACCOUNT_COLLECTION) {
      return
    }

    if (!collections[collection]) {
      return
    }

    const candidates: StoredRecord[] = []
    for (const [key, existing] of storedRecords) {
      if (!key.startsWith(`${collection}:`) || snapshotIds.has(existing.id)) {
        continue
      }

      // Snapshot absence is authoritative only for server-clean records.
      if (getLocalPruneProtection(existing.meta)) {
        continue
      }
      candidates.push(existing)
    }

    await evictObservedRecords(collection, candidates)
  }

  async function pruneLocal(
    collection: string,
    ids: readonly string[],
    pruneOptions: { dryRun?: boolean } = {},
  ): Promise<LocalPruneResult> {
    assertPersistedOperationCanQueue()
    return enqueueContextTransition(async () => {
      assertHydrated()
      await flushActiveContext()
      return enqueueReconciliation(async () => {
        const collectionState = collections[collection]
        if (!collectionState) {
          throw new Error(`Unknown synced collection: ${collection}`)
        }

        const requested = unique([...ids])
        const candidates: StoredRecord[] = []
        const missing: string[] = []
        const protectedRecords: LocalPruneResult['protected'] = []

        for (const id of requested) {
          const record = storedRecords.get(metaKey(collection, id))
          if (!record) {
            missing.push(id)
            continue
          }

          const protection = getLocalPruneProtection(record.meta)
          if (protection) {
            protectedRecords.push({ id, reason: protection })
          } else {
            candidates.push(record)
          }
        }

        if (pruneOptions.dryRun) {
          return {
            dryRun: true,
            requested,
            eligible: candidates.map((record) => record.id),
            evicted: [],
            missing,
            protected: protectedRecords,
          }
        }

        const { evicted, changed } = await evictObservedRecords(collection, candidates)
        for (const id of changed) {
          protectedRecords.push({ id, reason: 'changed' })
        }

        return {
          dryRun: false,
          requested,
          eligible: candidates.map((record) => record.id),
          evicted,
          missing,
          protected: protectedRecords,
        }
      })
    })
  }

  async function evictObservedRecords(collection: string, candidates: StoredRecord[]) {
    const collectionState = collections[collection]
    if (!collectionState || candidates.length === 0) {
      return { evicted: [] as string[], changed: [] as string[] }
    }

    // Another tab may have made a candidate actionable after our view was hydrated. The
    // storage transaction preserves any record that no longer matches our clean observation.
    const evicted = await storage.deleteRecordsIfUnchanged(collection, candidates)
    const evictedSet = new Set(evicted)
    for (const id of evicted) {
      const key = metaKey(collection, id)
      runWithoutTracking(() => {
        delete collectionState.records[id]
      })
      storedRecords.delete(key)
      recordMeta.delete(key)
    }

    const changed = candidates
      .filter((record) => !evictedSet.has(record.id))
      .map((record) => record.id)
    if (changed.length > 0) {
      await hydrateCollection(collection)
    }
    if (evicted.length > 0) {
      channel?.postMessage({
        namespace: storageNamespace,
        type: 'collectionChanged',
        collection,
      } satisfies BroadcastMessage)
    }
    return { evicted, changed }
  }

  function mutateCollection(collection: string, mutation: CollectionMutation) {
    if (status.phase !== 'ready' || contextTransitionsPending > 0) {
      throw new Error('Await hydrate() before mutating a synced collection')
    }
    const definition = options.schema[collection]
    const collectionState = collections[collection]

    if (!definition || definition.kind !== 'collection' || !collectionState) {
      throw new Error(`Unknown synced collection: ${collection}`)
    }

    if (mutation.type === 'create') {
      const id = String(mutation.value.id ?? createId())
      const key = metaKey(collection, id)
      const existing = storedRecords.get(key)

      if (existing?.meta.deleted) {
        throw new Error(`Cannot recreate deleted record ${collection}:${id}`)
      }
      if (existing) {
        throw new Error(`Cannot create existing record ${collection}:${id}`)
      }

      const parsed = parseRecord(definition, {
        ...getDefaults(definition),
        ...mutation.value,
        id,
      }) as JsonRecord
      const touched = unique(['id', ...Object.keys(mutation.value)])
      const meta = markMetaDirty(cleanMeta(null, currentDeviceId(device)), touched)

      runWithoutTracking(() => {
        collectionState.records[id] = parsed
      })
      persistStoredRecord(collection, {
        id,
        data: parsed,
        meta,
      })
      markDirtyState()
      return
    }

    if (mutation.type === 'update') {
      const current = collectionState.records[mutation.id]
      if (!current) {
        throw new Error(`Cannot update missing record ${collection}:${mutation.id}`)
      }

      const patch = parsePatch(definition, mutation.patch) as JsonRecord
      const parsed = parseRecord(definition, {
        ...current,
        ...patch,
      }) as JsonRecord
      const key = metaKey(collection, mutation.id)
      const existing = storedRecords.get(key)

      if (existing?.meta.deleted) {
        throw new Error(`Cannot update deleted record ${collection}:${mutation.id}`)
      }

      runWithoutTracking(() => {
        collectionState.records[mutation.id] = parsed
      })
      persistStoredRecord(collection, {
        id: mutation.id,
        data: parsed,
        meta: markMetaDirty(
          existing?.meta ?? cleanMeta(null, currentDeviceId(device)),
          Object.keys(patch),
        ),
      })
      markDirtyState()
      return
    }

    const key = metaKey(collection, mutation.id)
    const existing = storedRecords.get(key)
    const current = collectionState.records[mutation.id]

    if (!existing && !current) {
      return
    }

    runWithoutTracking(() => {
      delete collectionState.records[mutation.id]
    })

    if (
      existing &&
      existing.meta.serverVersion == null &&
      existing.meta.dirty &&
      !isMutationInFlight(existing.meta)
    ) {
      storedRecords.delete(key)
      recordMeta.delete(key)
      enqueueStorageWrite(async () => {
        await storage.deleteRecord(collection, mutation.id)
        channel?.postMessage({
          namespace: storageNamespace,
          type: 'collectionChanged',
          collection,
        } satisfies BroadcastMessage)
      })
      refreshPendingOps(internals)
      status.dirty = internals.pendingOps.length > 0
      return
    }

    const deletedRecord: StoredRecord = {
      id: mutation.id,
      data: existing?.data ?? current ?? ({ id: mutation.id } as JsonRecord),
      meta: {
        ...markMetaDirty(existing?.meta ?? cleanMeta(null, currentDeviceId(device)), []),
        deleted: true,
      },
    }
    persistStoredRecord(collection, deletedRecord)
    markDirtyState()
  }

  function markAccountDirty(ops: INTERNAL_Op[]) {
    const touched = touchedFieldsFromOps(ops, 0)
    if (touched.length === 0) {
      return
    }

    try {
      const parsed = parseRecord(accountDefinition, snapshotJsonRecord(account)) as JsonRecord
      internals.accountData = parsed
      accountMeta = {
        ...accountMeta,
        sync: markMetaDirty(
          accountMeta.sync ?? cleanMeta(null, currentDeviceId(device)),
          touched,
        ),
      }
      internals.accountMeta = accountMeta
      enqueueStorageWrite(() =>
        storage.writeAccount({
          data: parsed,
          meta: accountMeta,
        }),
      )
      markDirtyState()
    } catch (error) {
      setStatusError(status, {
        reason: 'validation',
        message: error instanceof Error ? error.message : 'Invalid account mutation',
      })
    }
  }

  function markRecordMutations(collection: string, ops: INTERNAL_Op[]) {
    const definition = options.schema[collection]
    const collectionState = collections[collection]
    if (!definition || definition.kind !== 'collection' || !collectionState) {
      return
    }

    const touchedById = new Map<string, string[]>()
    const wholeRecordIds = new Set<string>()
    const deletedIds = new Set<string>()

    for (const op of ops) {
      const path = op[1]
      const id = path[0]
      if (typeof id !== 'string') {
        continue
      }
      if (op[0] === 'delete' && path.length === 1) {
        deletedIds.add(id)
        continue
      }

      const touchedField = path[1]
      if (typeof touchedField === 'string') {
        touchedById.set(id, unique([...(touchedById.get(id) ?? []), touchedField]))
      } else {
        wholeRecordIds.add(id)
      }
    }

    for (const id of deletedIds) {
      mutateCollection(collection, {
        type: 'delete',
        id,
      })
    }

    for (const id of wholeRecordIds) {
      if (!touchedById.has(id)) {
        const key = metaKey(collection, id)
        const current = collectionState.records[id] ?? {}
        const previous = storedRecords.get(key)?.data
        touchedById.set(id, changedFields(previous, current))
      }
    }

    for (const [id, touched] of touchedById) {
      const current = collectionState.records[id]
      if (!current) {
        continue
      }

      try {
        const parsed = parseRecord(definition, current) as JsonRecord
        const key = metaKey(collection, id)
        const existing = storedRecords.get(key)
        persistStoredRecord(collection, {
          id,
          data: parsed,
          meta: markMetaDirty(
            existing?.meta ?? cleanMeta(null, currentDeviceId(device)),
            touched,
          ),
        })
        markDirtyState()
      } catch (error) {
        setStatusError(status, {
          reason: 'validation',
          message: error instanceof Error ? error.message : `Invalid record ${collection}:${id}`,
        })
      }
    }
  }

  function persistStoredRecord(collection: string, record: StoredRecord) {
    const key = metaKey(collection, record.id)
    storedRecords.set(key, record)
    recordMeta.set(key, record.meta)
    enqueueStorageWrite(async () => {
      await storage.writeRecord(collection, record)
      channel?.postMessage({
        namespace: storageNamespace,
        type: 'collectionChanged',
        collection,
      } satisfies BroadcastMessage)
    })
  }

  function markDirtyState() {
    refreshPendingOps(internals)
    status.dirty = internals.pendingOps.length > 0
    scheduleFlush()
  }

  function scheduleFlush() {
    if (flushTimer) {
      clearTimeout(flushTimer)
    }
    flushTimer = setTimeout(() => {
      void flush()
    }, 100)
  }

  function scheduleRetry() {
    if (status.phase !== 'ready' || contextTransitionsPending > 0 || !status.dirty || retryTimer) {
      return
    }

    const baseDelay = Math.min(30_000, 1_000 * 2 ** retryAttempt)
    const jitter = 0.75 + Math.random() * 0.5
    retryAttempt += 1
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      if (status.phase === 'ready' && status.dirty && !closed && contextTransitionsPending === 0) {
        void sync()
      }
    }, baseDelay * jitter)
  }

  function enqueueStorageWrite(write: () => Promise<void>) {
    writeQueue = writeQueue.then(write, write).catch((error: unknown) => {
      setStatusError(status, {
        reason: 'server_error',
        message: error instanceof Error ? error.message : 'Failed to persist local mutation',
      })
    })
  }

  function enqueueReconciliation<T>(reconcile: () => Promise<T>): Promise<T> {
    const result = reconciliationQueue.then(reconcile, reconcile)
    reconciliationQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  function runWithoutTracking<T>(fn: () => T): T {
    trackingPaused = true
    try {
      return fn()
    } finally {
      trackingPaused = false
    }
  }

  function isMutationInFlight(meta: StoredRecord['meta']) {
    return meta.mutationId !== undefined && inFlightMutationIds.has(meta.mutationId)
  }

  function markMetaDirty(previous: StoredRecord['meta'], touched: string[]) {
    return dirtyMeta(previous, touched, isMutationInFlight(previous))
  }

  async function adoptLocalData(
    source: ValtioSyncClient,
    adoptOptions: AdoptLocalDataOptions = {},
  ): Promise<void> {
    assertPersistedOperationCanQueue()
    return enqueueContextTransition(async () => {
      assertHydrated()
      await adoptLocalDataActive(source, adoptOptions)
    })
  }

  async function adoptLocalDataActive(
    source: ValtioSyncClient,
    adoptOptions: AdoptLocalDataOptions,
  ): Promise<void> {
    const sourceInternals = getClientInternals(source)
    const copyLocalState = adoptOptions.copyLocalState ?? true
    const clearSource = adoptOptions.clearSource ?? 'never'
    const shouldSync = adoptOptions.sync === true

    if (adoptOptions.mode && adoptOptions.mode !== 'newAccount') {
      throw new Error(`Unsupported local data adoption mode: ${adoptOptions.mode}`)
    }
    if (source === client) {
      throw new Error('Cannot adopt local data from the same valtio-sync client')
    }
    if (clearSource === 'afterSuccessfulSync' && !shouldSync) {
      throw new Error('clearSource: "afterSuccessfulSync" requires sync: true')
    }
    if (closed) {
      throw new Error('Cannot adopt local data into a closed valtio-sync client')
    }

    assertCompatibleLocalDataSource(sourceInternals, String(accountKey), collectionKeys)

    await sourceInternals.waitUntilHydrated()
    await Promise.all([flushActiveContext(), sourceInternals.flush()])
    assertNewAccountAdoptionTargetIsEmpty(internals, getDefaults(accountDefinition) as JsonRecord)

    const sourceState = await sourceInternals.readLocalDataSnapshot()
    await importNewAccountLocalData(sourceState, copyLocalState)

    if (shouldSync) {
      await performSync()
    }

    if (clearSource === 'afterSuccessfulSync') {
      if (status.dirty || status.lastError) {
        throw new Error(
          'Promoted local data was not fully synced; source local data was not cleared',
        )
      }
      await source.clearLocalData()
    }
  }

  async function importNewAccountLocalData(
    sourceState: LocalDataSnapshot,
    copyLocalState: NonNullable<AdoptLocalDataOptions['copyLocalState']>,
  ) {
    const nextDevice = shouldCopyLocalState(copyLocalState, 'device')
      ? parseLocalOrDefaults(options.device, sourceState.device, status)
      : snapshotJsonRecord(device)
    const nextSession = shouldCopyLocalState(copyLocalState, 'session')
      ? parseLocalOrDefaults(options.session, sourceState.session, status)
      : snapshotJsonRecord(session)
    const updatedByDevice = currentDeviceId(nextDevice)
    const nextAccount = parseRecord(accountDefinition, {
      ...getDefaults(accountDefinition),
      ...sourceState.account,
    }) as JsonRecord
    const promotedCollections: Record<string, StoredRecord[]> = {}

    for (const collection of collectionKeys) {
      const definition = options.schema[collection]
      if (!definition || definition.kind !== 'collection') {
        continue
      }

      promotedCollections[collection] = []
      for (const record of sourceState.collections[collection] ?? []) {
        if (record.meta.deleted) {
          continue
        }

        const data = parseRecord(definition, record.data) as JsonRecord
        promotedCollections[collection].push({
          id: record.id,
          data,
          meta: dirtyMeta(
            cleanMeta(null, updatedByDevice),
            getPromotedRecordTouchedFields(record, data),
          ),
        })
      }
    }

    await writeQueue
    await storage.clearAll()

    const accountTouched = Object.keys(nextAccount)
    accountMeta = {
      schemaVersion,
      lastServerSeq: null,
      sync:
        accountTouched.length > 0
          ? dirtyMeta(cleanMeta(null, updatedByDevice), accountTouched)
          : cleanMeta(null, updatedByDevice),
    }
    internals.accountMeta = accountMeta
    internals.accountData = nextAccount

    recordMeta.clear()
    storedRecords.clear()

    runWithoutTracking(() => {
      replaceObject(account, nextAccount)
      replaceObject(device, nextDevice)
      replaceObject(session, nextSession)

      for (const collection of collectionKeys) {
        const collectionState = collections[collection]
        if (!collectionState) {
          continue
        }

        const nextRecords: Record<string, JsonRecord> = {}
        for (const record of promotedCollections[collection] ?? []) {
          nextRecords[record.id] = record.data
        }
        replaceObject(collectionState.records, nextRecords)
      }
    })

    await storage.writeAccount({
      data: nextAccount,
      meta: accountMeta,
    })

    for (const collection of collectionKeys) {
      await storage.clearCollection(collection)
      for (const record of promotedCollections[collection] ?? []) {
        storedRecords.set(metaKey(collection, record.id), record)
        recordMeta.set(metaKey(collection, record.id), record.meta)
        await storage.writeRecord(collection, record)
      }
      channel?.postMessage({
        namespace: storageNamespace,
        type: 'collectionChanged',
        collection,
      } satisfies BroadcastMessage)
    }

    persistWebState(localStorage, deviceKey, nextDevice, status)
    persistWebState(sessionStorage, sessionKey, nextSession, status)
    status.lastError = null
    status.lastSyncAt = null
    refreshPendingOps(internals)
    status.dirty = internals.pendingOps.length > 0
  }

  const clearLocalData = async (): Promise<void> => {
    assertPersistedOperationCanQueue()
    return enqueueContextTransition(async () => {
      assertHydrated()
      await writeQueue
      await storage.clearAll()
      await resetProxiesToDefaults()
      await Promise.resolve()
      localStorage.removeItem(deviceKey)
      sessionStorage.removeItem(sessionKey)
      channel?.postMessage({
        namespace: storageNamespace,
        type: 'clear',
      } satisfies BroadcastMessage)
    })
  }

  const clearCollection = async (collection: SyncedCollection): Promise<void> => {
    assertPersistedOperationCanQueue()
    return enqueueContextTransition(async () => {
      assertHydrated()
      await writeQueue
      const collectionName = recordCollections.get(collection.name) ?? collection.name
      await storage.clearCollection(collectionName)
      runWithoutTracking(() => {
        replaceObject(collection.records, {})
      })
      for (const key of recordMeta.keys()) {
        if (key.startsWith(`${collectionName}:`)) {
          recordMeta.delete(key)
          storedRecords.delete(key)
        }
      }
      refreshPendingOps(internals)
      status.dirty = internals.pendingOps.length > 0
      channel?.postMessage({
        namespace: storageNamespace,
        type: 'collectionChanged',
        collection: collectionName,
      } satisfies BroadcastMessage)
    })
  }

  const client: ValtioSyncClient<TSchema> & {
    readonly device: LocalState<TDevice>
    readonly session: LocalState<TSession>
  } = {
    ...(collections as CollectionMap<TSchema>),
    account: account as AccountState<TSchema>,
    device: device as LocalState<TDevice>,
    session: session as LocalState<TSession>,
    status,
    hydrate,
    flush,
    sync,
    interceptTransport,
    adoptLocalData,
    clearLocalData,
    clearCollection,
    async reset() {
      await clearLocalData()
    },
    close() {
      closed = true
      status.phase = 'closed'
      if (flushTimer) {
        clearTimeout(flushTimer)
      }
      if (retryTimer) {
        clearTimeout(retryTimer)
      }
      for (const unsubscribe of stateSubscriptions) {
        unsubscribe()
      }
      stateSubscriptions = []
      transportInterceptors.length = 0
      channel?.close()
      channel = null
      activeContext = null
      internals.storage = null
      assignClientState(
        createInertJsonRecord(accountDefaults),
        createInertJsonRecord(deviceDefaults),
        createInertJsonRecord(sessionDefaults),
        createInertCollections(collectionKeys, internals),
      )
      for (const ownedStorage of ownedStorages) {
        try {
          ownedStorage.close?.()
        } finally {
          if (storageOwners.get(ownedStorage) === owner) {
            storageOwners.delete(ownedStorage)
          }
        }
      }
      ownedStorages.clear()
      for (const ownedAdapter of ownedAdapters) {
        if (adapterOwners.get(ownedAdapter) === owner) {
          adapterOwners.delete(ownedAdapter)
        }
      }
      ownedAdapters.clear()
    },
    debug: {
      getStatus: () => snapshot(status) as ValtioSyncStatus,
      getDirtyRecords: () =>
        [...storedRecords.entries()]
          .filter(([, record]) => record.meta.dirty)
          .map(([key, record]) => {
            const separator = key.indexOf(':')
            return {
              collection: key.slice(0, separator),
              id: key.slice(separator + 1),
              record,
            }
          }),
      getPendingOps: () => [...internals.pendingOps],
      getRecordMeta: (collection: SyncedCollection, id: string) =>
        recordMeta.get(metaKey(recordCollections.get(collection.name) ?? collection.name, id)),
      getLastSyncRequest: () => internals.lastSyncRequest,
      getLastSyncResponse: () => internals.lastSyncResponse,
      clearLocalData,
    },
  }

  Object.defineProperty(client, clientInternalsKey, {
    value: internals,
  })

  return client
}

function makeCollection(
  name: string,
  records: Record<string, JsonRecord>,
  internals: ClientInternals,
): SyncedCollection {
  const collection: SyncedCollection = {
    name,
    records,
    create(value) {
      const id = String(value.id ?? createId())
      internals.mutateCollection(name, {
        type: 'create',
        value: {
          ...value,
          id,
        } as JsonRecord,
      })
      return records[id]
    },
    update(id, patch) {
      internals.mutateCollection(name, {
        type: 'update',
        id,
        patch: patch as JsonRecord,
      })
    },
    delete(id) {
      internals.mutateCollection(name, {
        type: 'delete',
        id,
      })
    },
    get(id) {
      return records[id]
    },
    list() {
      return Object.values(records)
    },
    pruneLocal(ids, options) {
      return internals.pruneLocal(name, ids, options)
    },
    flush: internals.flush,
    sync: internals.sync,
  }
  internals.recordCollections.set(collection.name, name)
  return collection
}

function createInertCollections(
  collectionKeys: string[],
  internals: ClientInternals,
): Record<string, SyncedCollection> {
  return Object.fromEntries(
    collectionKeys.map((key) => [
      key,
      makeCollection(key, createInertJsonRecord({}) as Record<string, JsonRecord>, internals),
    ]),
  )
}

function createInertJsonRecord(value: JsonRecord): JsonRecord {
  const cache = new WeakMap<object, object>()
  const wrap = (current: JsonValue): JsonValue => {
    if (current === null || typeof current !== 'object') {
      return current
    }
    const cached = cache.get(current)
    if (cached) {
      return cached as JsonValue
    }
    const target = Array.isArray(current) ? [...current] : { ...current }
    const inert = new Proxy(target, {
      get(targetValue, property, receiver) {
        return wrap(Reflect.get(targetValue, property, receiver) as JsonValue)
      },
      set() {
        return true
      },
      deleteProperty(targetValue, property) {
        return Reflect.getOwnPropertyDescriptor(targetValue, property)?.configurable !== false
      },
      defineProperty() {
        return true
      },
    })
    cache.set(current, inert)
    return inert as JsonValue
  }
  return wrap(cloneJsonRecord(value)) as JsonRecord
}

function resolveStorageContext(
  adapter: SyncStorageAdapter,
  collections: string[],
): ResolvedStorageContext {
  if (!adapter.namespace.trim()) {
    throw new Error('Sync storage adapter namespace must not be empty')
  }

  return {
    namespace: adapter.namespace,
    storage:
      adapter.storage ??
      createIndexedDbSyncStorage({
        namespace: adapter.namespace,
        collections,
        indexedDB: adapter.indexedDB,
      }),
    localStorage:
      adapter.localStorage ?? getBrowserStorage('localStorage') ?? createMemoryWebStorage(),
    sessionStorage:
      adapter.sessionStorage ?? getBrowserStorage('sessionStorage') ?? createMemoryWebStorage(),
    broadcast: adapter.broadcast !== false,
  }
}

function getTargetSchemaVersion(
  configuredVersion: number | undefined,
  migrations: Record<number, LocalMigration> | undefined,
) {
  return configuredVersion ?? Math.max(1, ...Object.keys(migrations ?? {}).map(Number))
}

async function migrateLocalData(
  state: LocalDataSnapshot,
  currentVersion: number,
  targetVersion: number,
  migrations: Record<number, LocalMigration> | undefined,
): Promise<LocalDataSnapshot> {
  let nextState = state

  for (let version = currentVersion + 1; version <= targetVersion; version += 1) {
    const migration = migrations?.[version]
    if (!migration) {
      throw new Error(`Missing valtio-sync migration for schema version ${version}`)
    }
    nextState = await migration(nextState)
  }

  return nextState
}

function refreshPendingOps(internals: ClientInternals) {
  const ops: SyncOp[] = []
  const accountSync = internals.accountMeta.sync

  if (accountSync?.dirty && !accountSync.deleted) {
    accountSync.mutationId ??= createMutationId()
    ops.push({
      mutationId: accountSync.mutationId,
      collection: ACCOUNT_COLLECTION,
      type: 'update',
      id: ACCOUNT_ID,
      patch: pickTouched(internals.accountData, accountSync.touched ?? []),
      touched: accountSync.touched ?? [],
      baseServerVersion: accountSync.baseServerVersion,
    })
  }

  for (const [key, record] of internals.storedRecords) {
    if (!record.meta.dirty) {
      continue
    }

    const separator = key.indexOf(':')
    const collection = key.slice(0, separator)
    const id = key.slice(separator + 1)
    record.meta.mutationId ??= createMutationId()
    const mutationId = record.meta.mutationId

    if (record.meta.deleted) {
      if (record.meta.serverVersion != null) {
        ops.push({
          mutationId,
          collection,
          type: 'delete',
          id,
          baseServerVersion: record.meta.baseServerVersion,
        })
      }
      continue
    }

    const touched = record.meta.touched ?? Object.keys(record.data)
    if (record.meta.serverVersion == null) {
      ops.push({
        mutationId,
        collection,
        type: 'create',
        id,
        value: {
          id,
          ...pickTouched(record.data, touched),
        },
        touched: unique(['id', ...touched]),
      })
      continue
    }

    ops.push({
      mutationId,
      collection,
      type: 'update',
      id,
      patch: pickTouched(record.data, touched),
      touched,
      baseServerVersion: record.meta.baseServerVersion,
    })
  }

  internals.pendingOps = ops
}

function ensureMutationId(meta: StoredRecord['meta']): StoredRecord['meta'] {
  if (!meta.dirty || meta.mutationId) {
    return meta
  }
  return {
    ...meta,
    mutationId: createMutationId(),
  }
}

function cleanMeta(serverVersion: number | null, updatedByDevice: string): StoredRecord['meta'] {
  return {
    dirty: false,
    deleted: false,
    serverVersion,
    baseServerVersion: serverVersion,
    updatedAtClient: Date.now(),
    updatedByDevice,
    lastSyncedAt: null,
    touched: [],
  }
}

function dirtyMeta(
  previous: StoredRecord['meta'],
  touched: string[],
  supersedesInFlightMutation = false,
): StoredRecord['meta'] {
  const nextTouched = supersedesInFlightMutation
    ? unique(touched)
    : unique([...(previous.touched ?? []), ...touched])
  return {
    ...previous,
    dirty: true,
    deleted: false,
    baseServerVersion: previous.dirty ? previous.baseServerVersion : previous.serverVersion,
    updatedAtClient: Date.now(),
    mutationId:
      supersedesInFlightMutation || !previous.mutationId
        ? createMutationId()
        : previous.mutationId,
    touched: nextTouched,
    lastError: undefined,
  }
}

function getLocalPruneProtection(
  meta: StoredRecord['meta'],
): LocalPruneResult['protected'][number]['reason'] | undefined {
  if (meta.dirty || meta.deleted) {
    return 'pending'
  }
  if (meta.lastError) {
    return 'error'
  }
  return undefined
}

function pickTouched(record: JsonRecord, touched: string[]): JsonRecord {
  const picked: JsonRecord = {}
  for (const field of touched) {
    if (field in record) {
      picked[field] = record[field]
    }
  }
  return picked
}

function overlayTouched(base: JsonRecord, local: JsonRecord, touched: string[]): JsonRecord {
  return {
    ...base,
    ...pickTouched(local, touched),
  }
}

function assertResponseOpIdentity(op: SyncOp, collection: string, id: string) {
  if (collection !== op.collection || id !== op.id) {
    throw new Error(`Sync response identity does not match mutation ${op.mutationId}`)
  }
}

function assertWireRecordIdentity(collection: string, id: string, record: JsonRecord) {
  if (collection === ACCOUNT_COLLECTION) {
    if (id !== ACCOUNT_ID) {
      throw new Error('Account changes must use the singleton id')
    }
    return
  }

  if (record.id !== id) {
    throw new Error(`Record id does not match change envelope for ${collection}:${id}`)
  }
}

function changedFields(previous: JsonRecord | undefined, current: JsonRecord): string[] {
  if (!previous) {
    return Object.keys(current)
  }

  return Object.keys(current).filter(
    (key) => JSON.stringify(previous[key]) !== JSON.stringify(current[key]),
  )
}

function touchedFieldsFromOps(ops: INTERNAL_Op[], pathIndex: number): string[] {
  const fields = new Set<string>()
  for (const op of ops) {
    const field = op[1][pathIndex]
    if (typeof field === 'string') {
      fields.add(field)
    }
  }
  return [...fields]
}

function currentDeviceId(device: JsonRecord): string {
  return typeof device.deviceId === 'string' ? device.deviceId : 'unknown-device'
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? createMutationId()
}

function createMutationId(): string {
  return `mut_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function getLocalDefaults(fields: FieldMap | undefined): JsonRecord {
  if (!fields) {
    return {}
  }

  const defaults: JsonRecord = {}
  for (const [key, schema] of Object.entries(fields)) {
    const result = schema.safeParse(undefined)
    if (result.success && isJsonValue(result.data)) {
      defaults[key] = result.data
    }
  }
  return defaults
}

function readWebState(
  fields: FieldMap | undefined,
  storage: WebStorageLike,
  key: string,
  status: ValtioSyncStatus,
): JsonRecord {
  const defaults = getLocalDefaults(fields)
  const raw = storage.getItem(key)
  if (!raw || !fields) {
    return defaults
  }

  try {
    return parseLocalState(fields, { ...defaults, ...JSON.parse(raw) }) as JsonRecord
  } catch (error) {
    setStatusError(status, {
      reason: 'validation',
      message: error instanceof Error ? error.message : `Invalid local state at ${key}`,
    })
    return defaults
  }
}

function parseLocalOrDefaults(
  fields: FieldMap | undefined,
  value: unknown,
  status: ValtioSyncStatus,
): JsonRecord {
  if (!fields) {
    return {}
  }
  try {
    const objectValue = value && typeof value === 'object' ? value : {}
    return parseLocalState(fields, { ...getLocalDefaults(fields), ...objectValue }) as JsonRecord
  } catch (error) {
    setStatusError(status, {
      reason: 'validation',
      message: error instanceof Error ? error.message : 'Invalid migrated local state',
    })
    return getLocalDefaults(fields)
  }
}

function parseRecordOrDefaults(
  definition: AccountDefinition,
  value: unknown,
  status: ValtioSyncStatus,
): JsonRecord {
  try {
    return parseRecord(definition, value) as JsonRecord
  } catch (error) {
    setStatusError(status, {
      reason: 'validation',
      message: error instanceof Error ? error.message : 'Invalid cached account',
    })
    return getDefaults(definition) as JsonRecord
  }
}

function persistWebState(
  storage: WebStorageLike,
  key: string,
  value: JsonRecord,
  status: ValtioSyncStatus,
) {
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch (error) {
    setStatusError(status, {
      reason: 'server_error',
      message: error instanceof Error ? error.message : `Failed to persist ${key}`,
    })
  }
}

function snapshotJsonRecord(value: object): JsonRecord {
  return JSON.parse(JSON.stringify(snapshot(value)))
}

function cloneJsonRecord(value: JsonRecord): JsonRecord {
  return JSON.parse(JSON.stringify(value))
}

function replaceObject(target: Record<string, unknown>, value: Record<string, unknown>) {
  for (const key of Object.keys(target)) {
    if (!(key in value)) {
      delete target[key]
    }
  }
  Object.assign(target, value)
}

function storageKey(namespace: string, kind: 'device' | 'session') {
  return `valtio-sync:${namespace}:${kind}`
}

function metaKey(collection: string, id: string) {
  return `${collection}:${id}`
}

function getClientInternals(client: ValtioSyncClient): ClientInternals {
  const internals = (client as Partial<ValtioSyncClientWithInternals>)[clientInternalsKey]
  if (!internals) {
    throw new Error('Can only adopt local data from a valtio-sync client')
  }
  return internals
}

function assertCompatibleLocalDataSource(
  sourceInternals: ClientInternals,
  accountKey: string,
  collectionKeys: string[],
) {
  if (sourceInternals.accountKey !== accountKey) {
    throw new Error('Cannot adopt local data from a client with a different account schema')
  }

  const sourceCollections = [...sourceInternals.collectionKeys].sort()
  const targetCollections = [...collectionKeys].sort()
  if (
    sourceCollections.length !== targetCollections.length ||
    sourceCollections.some((collection, index) => collection !== targetCollections[index])
  ) {
    throw new Error('Cannot adopt local data from a client with different collections')
  }
}

function assertNewAccountAdoptionTargetIsEmpty(
  internals: ClientInternals,
  defaultAccount: JsonRecord,
) {
  if (internals.accountMeta.lastServerSeq != null) {
    throw new Error('Cannot adopt anonymous local data into a namespace with remote sync state')
  }
  if (internals.accountMeta.sync?.serverVersion != null) {
    throw new Error('Cannot adopt anonymous local data into a namespace with remote account state')
  }
  if (internals.accountMeta.sync?.dirty) {
    throw new Error('Cannot adopt anonymous local data into a dirty target account')
  }
  if (!jsonRecordsEqual(internals.accountData, defaultAccount)) {
    throw new Error('Cannot adopt anonymous local data into a target account with local data')
  }
  if (internals.storedRecords.size > 0) {
    throw new Error('Cannot adopt anonymous local data into a target with cached records')
  }
}

function shouldCopyLocalState(
  copyLocalState: NonNullable<AdoptLocalDataOptions['copyLocalState']>,
  kind: 'device' | 'session',
) {
  if (typeof copyLocalState === 'boolean') {
    return copyLocalState
  }
  return copyLocalState[kind] === true
}

function getPromotedRecordTouchedFields(record: StoredRecord, data: JsonRecord) {
  if (record.meta.serverVersion == null && record.meta.touched?.length) {
    return record.meta.touched
  }
  return Object.keys(data)
}

function jsonRecordsEqual(left: JsonRecord, right: JsonRecord) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return typeof value !== 'number' || Number.isFinite(value)
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue)
  }

  if (typeof value !== 'object') {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(value as Record<string, unknown>).every(isJsonValue)
  )
}

function setStatusError(status: ValtioSyncStatus, error: SyncError) {
  status.lastError = error
}

type BroadcastMessage =
  | {
      namespace: string
      type: 'clear'
    }
  | {
      namespace: string
      type: 'collectionChanged'
      collection: string
    }

function createBroadcastChannel(namespace: string, enabled: boolean) {
  if (!enabled || typeof BroadcastChannel === 'undefined') {
    return null
  }

  const channel = new BroadcastChannel(`valtio-sync:${namespace}`)
  ;(channel as BroadcastChannel & { unref?: () => void }).unref?.()
  return channel
}

function getBrowserStorage(kind: 'localStorage' | 'sessionStorage'): WebStorageLike | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }

  try {
    return window[kind]
  } catch {
    return undefined
  }
}
