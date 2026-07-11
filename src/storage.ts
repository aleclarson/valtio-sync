import type { JsonRecord, SyncError } from './protocol.js'

/** Persisted collection record plus sync metadata. */
export type StoredRecord<TData extends JsonRecord = JsonRecord> = {
  id: string
  data: TData
  meta: {
    dirty: boolean
    deleted: boolean
    serverVersion: number | null
    baseServerVersion: number | null
    updatedAtClient: number
    updatedByDevice: string
    lastSyncedAt: number | null
    lastError?: SyncError
    mutationId?: string
    touched?: string[]
  }
}

/** Persisted singleton account data plus schema and sync metadata. */
export type StoredAccount<TData extends JsonRecord = JsonRecord> = {
  data: TData
  meta: {
    schemaVersion: number
    lastServerSeq: number | null
    sync?: StoredRecord['meta']
  }
}

/** Async storage adapter used by the client for account and collection state. */
export type SyncStorage = {
  readAccount(): Promise<StoredAccount | null>
  writeAccount(account: StoredAccount): Promise<void>
  listRecords(collection: string): Promise<StoredRecord[]>
  readRecord(collection: string, id: string): Promise<StoredRecord | null>
  writeRecord(collection: string, record: StoredRecord): Promise<void>
  deleteRecord(collection: string, id: string): Promise<void>
  /** Atomically delete records that still match the caller's observations. */
  deleteRecordsIfUnchanged(
    collection: string,
    records: readonly StoredRecord[],
  ): Promise<string[]>
  clearCollection(collection: string): Promise<void>
  clearAll(): Promise<void>
  close?(): void
}

/** Minimal Web Storage interface used for device and session local state. */
export type WebStorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Create an in-memory Web Storage replacement for tests and non-browser runtimes. */
export function createMemoryWebStorage(): WebStorageLike {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
}

/** Create an in-memory sync storage adapter, optionally seeded with existing data. */
export function createMemorySyncStorage(initial?: {
  account?: StoredAccount
  collections?: Record<string, StoredRecord[]>
}): SyncStorage {
  let account = clone(initial?.account ?? null)
  const collections = new Map<string, Map<string, StoredRecord>>()

  for (const [collection, records] of Object.entries(initial?.collections ?? {})) {
    collections.set(
      collection,
      new Map(records.map((record) => [record.id, clone(record)])),
    )
  }

  const getCollection = (collection: string) => {
    let records = collections.get(collection)
    if (!records) {
      records = new Map()
      collections.set(collection, records)
    }
    return records
  }

  return {
    async readAccount() {
      return clone(account)
    },
    async writeAccount(nextAccount) {
      account = clone(nextAccount)
    },
    async listRecords(collection) {
      return [...getCollection(collection).values()].map((record) => clone(record))
    },
    async readRecord(collection, id) {
      return clone(getCollection(collection).get(id) ?? null)
    },
    async writeRecord(collection, record) {
      getCollection(collection).set(record.id, clone(record))
    },
    async deleteRecord(collection, id) {
      getCollection(collection).delete(id)
    },
    async deleteRecordsIfUnchanged(collection, expectedRecords) {
      const records = getCollection(collection)
      const deleted: string[] = []
      for (const expected of expectedRecords) {
        const current = records.get(expected.id)
        if (current && recordsEqual(current, expected)) {
          records.delete(expected.id)
          deleted.push(expected.id)
        }
      }
      return deleted
    },
    async clearCollection(collection) {
      getCollection(collection).clear()
    },
    async clearAll() {
      account = null
      collections.clear()
    },
  }
}

export function createIndexedDbSyncStorage(options: {
  namespace: string
  collections: string[]
  indexedDB?: IDBFactory
}): SyncStorage {
  const indexedDB = options.indexedDB ?? globalThis.indexedDB

  if (!indexedDB) {
    return createMemorySyncStorage()
  }

  const dbName = `valtio-sync:${options.namespace}`
  const stores = ['account', ...options.collections.map((name) => collectionStore(name))]
  let dbPromise: Promise<IDBDatabase> | undefined

  const open = async () => {
    if (!dbPromise) {
      dbPromise = openDatabase(indexedDB, dbName, stores)
    }
    return dbPromise
  }

  return {
    async readAccount() {
      const db = await open()
      return readFromStore<StoredAccount>(db, 'account', 'singleton')
    },
    async writeAccount(account) {
      const db = await open()
      await writeToStore(db, 'account', 'singleton', account)
    },
    async listRecords(collection) {
      const db = await open()
      return listStore<StoredRecord>(db, collectionStore(collection))
    },
    async readRecord(collection, id) {
      const db = await open()
      return readFromStore<StoredRecord>(db, collectionStore(collection), id)
    },
    async writeRecord(collection, record) {
      const db = await open()
      await writeToStore(db, collectionStore(collection), record.id, record)
    },
    async deleteRecord(collection, id) {
      const db = await open()
      await deleteFromStore(db, collectionStore(collection), id)
    },
    async deleteRecordsIfUnchanged(collection, records) {
      const db = await open()
      return deleteFromStoreIfUnchanged(db, collectionStore(collection), records)
    },
    async clearCollection(collection) {
      const db = await open()
      await clearStore(db, collectionStore(collection))
    },
    async clearAll() {
      const db = await open()
      await Promise.all(stores.map((store) => clearStore(db, store)))
    },
    close() {
      if (dbPromise) {
        dbPromise.then((db) => db.close(), () => {})
        dbPromise = undefined
      }
    },
  }
}

function collectionStore(collection: string) {
  return `collection:${collection}`
}

async function openDatabase(
  indexedDB: IDBFactory,
  dbName: string,
  stores: string[],
): Promise<IDBDatabase> {
  let db = await requestToPromise(indexedDB.open(dbName))
  const missingStores = stores.filter((store) => !db.objectStoreNames.contains(store))

  if (missingStores.length === 0) {
    return db
  }

  const nextVersion = db.version + 1
  db.close()
  db = await requestToPromise(indexedDB.open(dbName, nextVersion), (event) => {
    const upgradeDb = (event.target as IDBOpenDBRequest).result
    for (const store of stores) {
      if (!upgradeDb.objectStoreNames.contains(store)) {
        upgradeDb.createObjectStore(store)
      }
    }
  })

  return db
}

function requestToPromise<T>(
  request: IDBRequest<T>,
  upgrade?: (event: IDBVersionChangeEvent) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)

    if (upgrade && 'onupgradeneeded' in request) {
      ;(request as unknown as IDBOpenDBRequest).onupgradeneeded = upgrade
    }
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
    transaction.onerror = () => reject(transaction.error)
  })
}

async function readFromStore<T>(
  db: IDBDatabase,
  store: string,
  key: string,
): Promise<T | null> {
  const transaction = db.transaction(store, 'readonly')
  const value = await requestToPromise<T | undefined>(
    transaction.objectStore(store).get(key),
  )
  await transactionDone(transaction)
  return clone(value ?? null)
}

async function writeToStore(
  db: IDBDatabase,
  store: string,
  key: string,
  value: unknown,
): Promise<void> {
  const transaction = db.transaction(store, 'readwrite')
  transaction.objectStore(store).put(clone(value), key)
  await transactionDone(transaction)
}

async function deleteFromStore(
  db: IDBDatabase,
  store: string,
  key: string,
): Promise<void> {
  const transaction = db.transaction(store, 'readwrite')
  transaction.objectStore(store).delete(key)
  await transactionDone(transaction)
}

async function deleteFromStoreIfUnchanged(
  db: IDBDatabase,
  store: string,
  expectedRecords: readonly StoredRecord[],
): Promise<string[]> {
  const transaction = db.transaction(store, 'readwrite')
  const objectStore = transaction.objectStore(store)
  const currentRecords = await Promise.all(
    expectedRecords.map((record) =>
      requestToPromise<StoredRecord | undefined>(objectStore.get(record.id)),
    ),
  )
  const deleted: string[] = []
  for (const [index, expected] of expectedRecords.entries()) {
    const current = currentRecords[index]
    if (current && recordsEqual(current, expected)) {
      objectStore.delete(expected.id)
      deleted.push(expected.id)
    }
  }
  await transactionDone(transaction)
  return deleted
}

async function clearStore(db: IDBDatabase, store: string): Promise<void> {
  const transaction = db.transaction(store, 'readwrite')
  transaction.objectStore(store).clear()
  await transactionDone(transaction)
}

async function listStore<T>(db: IDBDatabase, store: string): Promise<T[]> {
  const transaction = db.transaction(store, 'readonly')
  const values = await requestToPromise<T[]>(transaction.objectStore(store).getAll())
  await transactionDone(transaction)
  return values.map((value) => clone(value))
}

function clone<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function recordsEqual(left: StoredRecord, right: StoredRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
