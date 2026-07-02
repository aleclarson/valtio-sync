import { proxy, snapshot, subscribe } from 'valtio/vanilla'
import type {
  JsonRecord,
  JsonValue,
  SyncError,
  SyncOp,
  SyncRequest,
  SyncResponse,
} from './protocol.js'
import {
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
  recordMeta: Map<string, StoredRecord['meta']>
  recordCollections: Map<string, string>
  pendingOps: SyncOp[]
  lastSyncRequest: SyncRequest | null
  lastSyncResponse: SyncResponse | null
}

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
  const localStorage = options.localStorage ?? globalThis.localStorage ?? createMemoryWebStorage()
  const sessionStorage =
    options.sessionStorage ?? globalThis.sessionStorage ?? createMemoryWebStorage()
  const deviceKey = storageKey(namespace, 'device')
  const sessionKey = storageKey(namespace, 'session')
  const account = proxy<JsonRecord>(getDefaults(accountDefinition) as JsonRecord)
  const device = proxy<JsonRecord>(getLocalDefaults(options.device))
  const session = proxy<JsonRecord>(getLocalDefaults(options.session))
  const recordMeta = new Map<string, StoredRecord['meta']>()
  const recordCollections = new Map<string, string>()
  const collections: Record<string, SyncedCollection> = {}
  const subscriptions: Array<() => void> = []
  const channel = createBroadcastChannel(namespace, options.broadcast !== false)
  let accountMeta: StoredAccount['meta'] = {
    schemaVersion,
    lastServerSeq: null,
  }
  let closed = false
  let hydrating = true

  const internals: ClientInternals = {
    storage,
    status,
    accountMeta,
    recordMeta,
    recordCollections,
    pendingOps: [],
    lastSyncRequest: null,
    lastSyncResponse: null,
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
    }),
  )
  subscriptions.push(
    subscribe(session, () => {
      if (!hydrating) {
        persistWebState(sessionStorage, sessionKey, snapshotJsonRecord(session), status)
      }
    }),
  )

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
    }
    internals.accountMeta = accountMeta
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
      status.dirty = false
      status.lastError = null
      accountMeta = {
        schemaVersion,
        lastServerSeq: null,
      }
      internals.accountMeta = accountMeta
    } finally {
      hydrating = wasHydrating
    }
  }

  const clearLocalData = async (): Promise<void> => {
    await storage.clearAll()
    await resetProxiesToDefaults()
    await Promise.resolve()
    localStorage.removeItem(deviceKey)
    sessionStorage.removeItem(sessionKey)
    channel?.postMessage({ namespace, type: 'clear' } satisfies BroadcastMessage)
  }

  const clearCollection = async (collection: SyncedCollection): Promise<void> => {
    const collectionName = recordCollections.get(collection.name) ?? collection.name
    await storage.clearCollection(collectionName)
    replaceObject(collection.records, {})
    for (const key of recordMeta.keys()) {
      if (key.startsWith(`${collectionName}:`)) {
        recordMeta.delete(key)
      }
    }
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
    async flush() {},
    async sync() {},
    clearLocalData,
    clearCollection,
    async reset() {
      await clearLocalData()
    },
    close() {
      closed = true
      for (const unsubscribe of subscriptions) {
        unsubscribe()
      }
      channel?.close()
      storage.close?.()
    },
    debug: {
      getStatus: () => snapshot(status) as ValtioSyncStatus,
      getDirtyRecords: () => [],
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
    create() {
      throw new Error('Collection create is not implemented yet')
    },
    update() {
      throw new Error('Collection update is not implemented yet')
    },
    delete() {
      throw new Error('Collection delete is not implemented yet')
    },
    get(id) {
      return records[id]
    },
    list() {
      return Object.values(records)
    },
    async flush() {},
    async sync() {},
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

  return new BroadcastChannel(`valtio-sync:${namespace}`)
}
