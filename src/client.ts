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
  type WebStorageLike,
  createIndexedDbSyncStorage,
  createMemoryWebStorage,
} from './storage.js'

export type {
  AcceptedSyncOp,
  CollectionChanges,
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
export type { StoredAccount, StoredRecord, SyncStorage, WebStorageLike } from './storage.js'
export { createMemorySyncStorage, createMemoryWebStorage } from './storage.js'

export type LocalDataSnapshot = {
  account: JsonRecord
  collections: Record<string, StoredRecord[]>
  device: JsonRecord
  session: JsonRecord
}

export type LocalMigration = (
  state: LocalDataSnapshot,
) => LocalDataSnapshot | Promise<LocalDataSnapshot>

export type ValtioSyncStatus = {
  hydrated: boolean
  syncing: boolean
  dirty: boolean
  online: boolean
  lastSyncAt: number | null
  lastError: SyncError | null
}

export type SyncedCollection<TRecord extends JsonRecord = JsonRecord> = {
  readonly name: string
  readonly records: Record<string, TRecord>
  create(value: Partial<TRecord> & { id?: string }): TRecord
  update(id: string, patch: Partial<TRecord>): void
  delete(id: string): void
  get(id: string): TRecord | undefined
  list(): TRecord[]
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

type AccountState<TSchema extends SyncSchema> =
  TSchema[Extract<keyof TSchema, string>] extends AccountDefinition<infer TFields>
    ? InferFields<TFields> & JsonRecord
    : JsonRecord

type LocalState<TFields extends FieldMap | undefined> = TFields extends FieldMap
  ? InferFields<TFields> & JsonRecord
  : JsonRecord

export type ValtioSyncClient<TSchema extends SyncSchema = SyncSchema> = {
  readonly account: AccountState<TSchema>
  readonly collections: CollectionMap<TSchema>
  readonly device: JsonRecord
  readonly session: JsonRecord
  readonly status: ValtioSyncStatus
  readonly ready: Promise<void>
  flush(): Promise<void>
  sync(): Promise<void>
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

export type ValtioSyncClientOptions<
  TSchema extends SyncSchema,
  TDevice extends FieldMap | undefined = undefined,
  TSession extends FieldMap | undefined = undefined,
> = {
  endpoint: string
  namespace?: string
  schema: TSchema
  device?: TDevice
  session?: TSession
  schemaVersion?: number
  conflict?: 'rejectStale' | 'lww' | 'serverWins'
  fetch?: typeof fetch
  migrations?: Record<number, LocalMigration>
  storage?: SyncStorage
  localStorage?: WebStorageLike
  sessionStorage?: WebStorageLike
  indexedDB?: IDBFactory
  broadcast?: boolean
}

type ClientInternals = {
  storage: SyncStorage
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
  mutateCollection(collection: string, mutation: CollectionMutation): void
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

unstable_enableOp()

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
  const namespace = options.namespace ?? 'default'
  const accountKey = getAccountKey(options.schema)
  const accountDefinition = options.schema[accountKey] as AccountDefinition
  const collectionKeys = getCollectionKeys(options.schema) as string[]
  const schemaVersion = getTargetSchemaVersion(options.schemaVersion, options.migrations)
  const status = proxy<ValtioSyncStatus>({
    hydrated: false,
    syncing: false,
    dirty: false,
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    lastSyncAt: null,
    lastError: null,
  })
  const storage =
    options.storage ??
    createIndexedDbSyncStorage({
      namespace,
      collections: collectionKeys,
      indexedDB: options.indexedDB,
    })
  const localStorage =
    options.localStorage ?? getBrowserStorage('localStorage') ?? createMemoryWebStorage()
  const sessionStorage =
    options.sessionStorage ?? getBrowserStorage('sessionStorage') ?? createMemoryWebStorage()
  const deviceKey = storageKey(namespace, 'device')
  const sessionKey = storageKey(namespace, 'session')
  const account = proxy<JsonRecord>(getDefaults(accountDefinition) as JsonRecord)
  const device = proxy<JsonRecord>(getLocalDefaults(options.device))
  const session = proxy<JsonRecord>(getLocalDefaults(options.session))
  const recordMeta = new Map<string, StoredRecord['meta']>()
  const storedRecords = new Map<string, StoredRecord>()
  const recordCollections = new Map<string, string>()
  const collections: Record<string, SyncedCollection> = {}
  const subscriptions: Array<() => void> = []
  const channel = createBroadcastChannel(namespace, options.broadcast !== false)
  let accountMeta: StoredAccount['meta'] = {
    schemaVersion,
    lastServerSeq: null,
    sync: cleanMeta(null, 'system'),
  }
  let closed = false
  let hydrating = true
  let trackingPaused = false
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryAttempt = 0
  let writeQueue = Promise.resolve()

  const internals: ClientInternals = {
    storage,
    status,
    accountMeta,
    accountData: snapshotJsonRecord(account),
    recordMeta,
    storedRecords,
    recordCollections,
    pendingOps: [],
    lastSyncRequest: null,
    lastSyncResponse: null,
    flush: async () => flush(),
    sync: async () => sync(),
    mutateCollection: (collection, mutation) => mutateCollection(collection, mutation),
  }

  for (const key of collectionKeys) {
    const records = proxy<Record<string, JsonRecord>>({})
    collections[key] = makeCollection(key, records, internals)
  }

  const ready = hydrate().catch((error: unknown) => {
    setStatusError(status, {
      reason: 'server_error',
      message: error instanceof Error ? error.message : 'Failed to hydrate local state',
    })
    throw error
  })

  subscriptions.push(
    subscribe(device, () => {
      if (!hydrating) {
        persistWebState(localStorage, deviceKey, snapshotJsonRecord(device), status)
      }
    }, true),
  )
  subscriptions.push(
    subscribe(session, () => {
      if (!hydrating) {
        persistWebState(sessionStorage, sessionKey, snapshotJsonRecord(session), status)
      }
    }, true),
  )
  subscriptions.push(
    subscribe(account, (ops) => {
      if (!hydrating && !trackingPaused) {
        void markAccountDirty(ops)
      }
    }, true),
  )
  for (const [collection, collectionState] of Object.entries(collections)) {
    subscriptions.push(
      subscribe(collectionState.records, (ops) => {
        if (!hydrating && !trackingPaused) {
          void markRecordMutations(collection, ops)
        }
      }, true),
    )
  }

  if (channel) {
    channel.onmessage = (event) => {
      const message = event.data as BroadcastMessage
      if (message.namespace !== namespace || closed) {
        return
      }
      if (message.type === 'clear') {
        void resetProxiesToDefaults()
      } else if (message.type === 'collectionChanged' && message.collection) {
        void hydrateCollection(message.collection)
      }
    }
  }

  async function hydrate() {
    hydrating = true
    const localDevice = readWebState(options.device, localStorage, deviceKey, status)
    const localSession = readWebState(options.session, sessionStorage, sessionKey, status)
    replaceObject(device, localDevice)
    replaceObject(session, localSession)

    const storedAccount = await storage.readAccount()
    let state = await readLocalDataSnapshot(storedAccount)
    const currentVersion = storedAccount?.meta.schemaVersion ?? 1

    if (currentVersion < schemaVersion) {
      state = await migrateLocalData(state, currentVersion, schemaVersion, options.migrations)
      await writeLocalDataSnapshot(state)
    }

    hydrateAccount(state.account, storedAccount)

    for (const key of collectionKeys) {
      hydrateCollectionFromRecords(key, state.collections[key] ?? [])
    }

    await storage.writeAccount({
      data: snapshotJsonRecord(account),
      meta: accountMeta,
    })
    persistWebState(localStorage, deviceKey, snapshotJsonRecord(device), status)
    persistWebState(sessionStorage, sessionKey, snapshotJsonRecord(session), status)
    status.hydrated = true
    hydrating = false
  }

  async function readLocalDataSnapshot(
    storedAccount: StoredAccount | null,
  ): Promise<LocalDataSnapshot> {
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

  async function writeLocalDataSnapshot(state: LocalDataSnapshot) {
    await storage.writeAccount({
      data: state.account,
      meta: {
        ...accountMeta,
        schemaVersion,
      },
    })

    for (const key of collectionKeys) {
      await storage.clearCollection(key)
      for (const record of state.collections[key] ?? []) {
        await storage.writeRecord(key, record)
      }
    }

    replaceObject(device, parseLocalOrDefaults(options.device, state.device, status))
    replaceObject(session, parseLocalOrDefaults(options.session, state.session, status))
  }

  function hydrateAccount(stateAccount: JsonRecord, storedAccount: StoredAccount | null) {
    const parsed = parseRecordOrDefaults(accountDefinition, stateAccount, status)
    replaceObject(account, parsed)
    accountMeta = {
      schemaVersion,
      lastServerSeq: storedAccount?.meta.lastServerSeq ?? accountMeta.lastServerSeq,
      sync: storedAccount?.meta.sync ?? accountMeta.sync ?? cleanMeta(null, 'system'),
    }
    internals.accountMeta = accountMeta
    internals.accountData = parsed
  }

  async function hydrateCollection(collection: string) {
    const definition = options.schema[collection]
    const collectionState = collections[collection]
    if (!definition || definition.kind !== 'collection' || !collectionState) {
      return
    }
    hydrateCollectionFromRecords(collection, await storage.listRecords(collection))
  }

  function hydrateCollectionFromRecords(collection: string, records: StoredRecord[]) {
    const definition = options.schema[collection]
    const collectionState = collections[collection]
    if (!definition || definition.kind !== 'collection' || !collectionState) {
      return
    }

    const nextRecords: Record<string, JsonRecord> = {}
    for (const record of records) {
      try {
        const parsed = parseRecord(definition, record.data) as JsonRecord
        recordMeta.set(metaKey(collection, record.id), record.meta)
        storedRecords.set(metaKey(collection, record.id), {
          ...record,
          data: parsed,
        })
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
    replaceObject(collectionState.records, nextRecords)
  }

  async function resetProxiesToDefaults() {
    const wasHydrating = hydrating
    hydrating = true
    try {
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
    } finally {
      hydrating = wasHydrating
    }
  }

  async function flush(): Promise<void> {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }
    if (!status.hydrated) {
      await ready
    }
    await writeQueue
    refreshPendingOps(internals)
  }

  async function sync(): Promise<void> {
    await flush()
    if (closed || status.syncing) {
      return
    }

    const fetchSync = options.fetch ?? globalThis.fetch
    if (!fetchSync) {
      setStatusError(status, {
        reason: 'network',
        message: 'No fetch implementation is available for valtio-sync',
      })
      scheduleRetry()
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

    try {
      const response = await fetchSync(options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
      })

      if (!response.ok) {
        const message = await response.text().catch(() => response.statusText)
        if (response.status === 401 || response.status === 403) {
          setStatusError(status, {
            reason: 'auth',
            message: message || response.statusText,
          })
          return
        }

        setStatusError(status, {
          reason: 'network',
          message: message || response.statusText,
        })
        scheduleRetry()
        return
      }

      const syncResponse = parseSyncResponse(await response.json())
      internals.lastSyncResponse = syncResponse
      status.lastError = null
      await applySyncResponse(syncResponse, request.ops)
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
      setStatusError(status, {
        reason: 'network',
        message: error instanceof Error ? error.message : 'Sync request failed',
      })
      scheduleRetry()
    } finally {
      status.syncing = false
      refreshPendingOps(internals)
      status.dirty = internals.pendingOps.length > 0
    }
  }

  async function applySyncResponse(response: SyncResponse, sentOps: SyncOp[]) {
    const sentByMutation = new Map(sentOps.map((op) => [op.mutationId, op]))

    for (const accepted of response.accepted) {
      const op = sentByMutation.get(accepted.mutationId)
      if (!op) {
        continue
      }
      await applyAcceptedOp(op, accepted.serverVersion, accepted.record)
    }

    for (const rejected of response.rejected) {
      const op = sentByMutation.get(rejected.mutationId)
      if (!op) {
        continue
      }
      await applyRejectedOp(op, {
        reason: rejected.reason,
        message: rejected.message,
      })
    }

    for (const [collection, changes] of Object.entries(response.changes)) {
      for (const change of changes.upserted) {
        await applyRemoteUpsert(collection, change.id, change.record, change.serverVersion)
      }
      for (const change of changes.deleted) {
        await applyRemoteDelete(collection, change.id, change.serverVersion)
      }
    }
  }

  async function applyAcceptedOp(
    op: SyncOp,
    serverVersion: number,
    canonicalRecord: JsonRecord | undefined,
  ) {
    if (op.collection === ACCOUNT_COLLECTION) {
      const nextAccount = canonicalRecord
        ? (parseRecord(accountDefinition, canonicalRecord) as JsonRecord)
        : snapshotJsonRecord(account)
      accountMeta = {
        ...accountMeta,
        sync: {
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

    const currentRecord = collectionState.records[op.id]
    const data = canonicalRecord
      ? (parseRecord(definition, canonicalRecord) as JsonRecord)
      : (currentRecord ?? storedRecords.get(metaKey(op.collection, op.id))?.data)

    if (!data) {
      return
    }

    const record: StoredRecord = {
      id: op.id,
      data,
      meta: {
        ...cleanMeta(serverVersion, currentDeviceId(device)),
        lastSyncedAt: Date.now(),
      },
    }
    runWithoutTracking(() => {
      collectionState.records[op.id] = data
    })
    persistStoredRecord(op.collection, record)
  }

  async function applyRejectedOp(op: SyncOp, error: SyncError) {
    if (op.collection === ACCOUNT_COLLECTION) {
      accountMeta = {
        ...accountMeta,
        sync: {
          ...(accountMeta.sync ?? cleanMeta(null, currentDeviceId(device))),
          dirty: false,
          lastError: error,
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

    const rejectedRecord: StoredRecord = {
      ...existing,
      meta: {
        ...existing.meta,
        dirty: false,
        lastError: error,
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

    const parsed = parseRecord(definition, record) as JsonRecord
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

  async function applyRemoteDelete(
    collection: string,
    id: string,
    serverVersion: number,
  ) {
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

  function mutateCollection(collection: string, mutation: CollectionMutation) {
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
      const meta = dirtyMeta(cleanMeta(null, currentDeviceId(device)), touched)

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
        meta: dirtyMeta(
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

    if (existing && existing.meta.serverVersion == null && existing.meta.dirty) {
      storedRecords.delete(key)
      recordMeta.delete(key)
      enqueueStorageWrite(async () => {
        await storage.deleteRecord(collection, mutation.id)
        channel?.postMessage({
          namespace,
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
        ...dirtyMeta(existing?.meta ?? cleanMeta(null, currentDeviceId(device)), []),
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
        sync: dirtyMeta(accountMeta.sync ?? cleanMeta(null, currentDeviceId(device)), touched),
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
          meta: dirtyMeta(existing?.meta ?? cleanMeta(null, currentDeviceId(device)), touched),
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
        namespace,
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
    if (!status.dirty || retryTimer) {
      return
    }

    const baseDelay = Math.min(30_000, 1_000 * 2 ** retryAttempt)
    const jitter = 0.75 + Math.random() * 0.5
    retryAttempt += 1
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      if (status.dirty && !closed) {
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

  function runWithoutTracking<T>(fn: () => T): T {
    trackingPaused = true
    try {
      return fn()
    } finally {
      trackingPaused = false
    }
  }

  const clearLocalData = async (): Promise<void> => {
    await writeQueue
    await storage.clearAll()
    await resetProxiesToDefaults()
    await Promise.resolve()
    localStorage.removeItem(deviceKey)
    sessionStorage.removeItem(sessionKey)
    channel?.postMessage({ namespace, type: 'clear' } satisfies BroadcastMessage)
  }

  const clearCollection = async (collection: SyncedCollection): Promise<void> => {
    await writeQueue
    const collectionName = recordCollections.get(collection.name) ?? collection.name
    await storage.clearCollection(collectionName)
    replaceObject(collection.records, {})
    for (const key of recordMeta.keys()) {
      if (key.startsWith(`${collectionName}:`)) {
        recordMeta.delete(key)
        storedRecords.delete(key)
      }
    }
    refreshPendingOps(internals)
    channel?.postMessage({
      namespace,
      type: 'collectionChanged',
      collection: collectionName,
    } satisfies BroadcastMessage)
  }

  const client: ValtioSyncClient<TSchema> & {
    readonly device: LocalState<TDevice>
    readonly session: LocalState<TSession>
  } = {
    account: account as AccountState<TSchema>,
    collections: collections as CollectionMap<TSchema>,
    device: device as LocalState<TDevice>,
    session: session as LocalState<TSession>,
    status,
    ready,
    flush,
    sync,
    clearLocalData,
    clearCollection,
    async reset() {
      await clearLocalData()
    },
    close() {
      closed = true
      if (flushTimer) {
        clearTimeout(flushTimer)
      }
      if (retryTimer) {
        clearTimeout(retryTimer)
      }
      for (const unsubscribe of subscriptions) {
        unsubscribe()
      }
      channel?.close()
      storage.close?.()
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
    flush: internals.flush,
    sync: internals.sync,
  }
  internals.recordCollections.set(collection.name, name)
  return collection
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
    ops.push({
      mutationId: accountSync.mutationId ?? createMutationId(),
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
    const mutationId = record.meta.mutationId ?? createMutationId()

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

function cleanMeta(
  serverVersion: number | null,
  updatedByDevice: string,
): StoredRecord['meta'] {
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
): StoredRecord['meta'] {
  const nextTouched = unique([...(previous.touched ?? []), ...touched])
  return {
    ...previous,
    dirty: true,
    deleted: false,
    baseServerVersion: previous.dirty
      ? previous.baseServerVersion
      : previous.serverVersion,
    updatedAtClient: Date.now(),
    mutationId: previous.mutationId ?? createMutationId(),
    touched: nextTouched,
    lastError: undefined,
  }
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
