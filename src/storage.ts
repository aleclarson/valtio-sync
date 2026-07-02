import type { JsonRecord, SyncError } from './protocol.js'

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
  }
}

export type StoredAccount<TData extends JsonRecord = JsonRecord> = {
  data: TData
  meta: {
    schemaVersion: number
    lastServerSeq: number | null
  }
}

export type SyncStorage = {
  readAccount(): Promise<StoredAccount | null>
  writeAccount(account: StoredAccount): Promise<void>
  listRecords(collection: string): Promise<StoredRecord[]>
  readRecord(collection: string, id: string): Promise<StoredRecord | null>
  writeRecord(collection: string, record: StoredRecord): Promise<void>
  deleteRecord(collection: string, id: string): Promise<void>
  clearCollection(collection: string): Promise<void>
  clearAll(): Promise<void>
  close?(): void
}

export type WebStorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

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
