import { IDBFactory } from 'fake-indexeddb'
import type { StoredAccount, StoredRecord, SyncStorage } from '../src/storage.js'
import { createIndexedDbSyncStorage, createMemorySyncStorage } from '../src/storage.js'

function storedRecord(id: string, title = id): StoredRecord {
  return {
    id,
    data: { id, title },
    meta: {
      dirty: false,
      deleted: false,
      serverVersion: 1,
      baseServerVersion: 1,
      updatedAtClient: 1,
      updatedByDevice: 'device_1',
      lastSyncedAt: 1,
      touched: [],
    },
  }
}

function storedAccount(theme = 'light'): StoredAccount {
  return {
    data: { theme },
    meta: {
      schemaVersion: 1,
      lastServerSeq: 1,
    },
  }
}

const storageFactories: Array<{
  name: string
  create(): SyncStorage
}> = [
  {
    name: 'memory',
    create: () => createMemorySyncStorage(),
  },
  {
    name: 'IndexedDB',
    create: () =>
      createIndexedDbSyncStorage({
        namespace: `contract-${crypto.randomUUID()}`,
        collections: ['todos', 'projects'],
        indexedDB: new IDBFactory(),
      }),
  },
]

describe.each(storageFactories)('$name storage contract', ({ create }) => {
  test('reads, writes, deletes, and clears isolated copies', async () => {
    const storage = create()
    const account = storedAccount()
    const todo = storedRecord('todo_1')
    const project = storedRecord('project_1')

    await storage.writeAccount(account)
    await storage.writeRecord('todos', todo)
    await storage.writeRecord('projects', project)

    const readAccount = await storage.readAccount()
    const readTodo = await storage.readRecord('todos', 'todo_1')
    expect(readAccount).toEqual(account)
    expect(readTodo).toEqual(todo)
    expect(await storage.listRecords('projects')).toEqual([project])

    readAccount!.data.theme = 'mutated copy'
    readTodo!.data.title = 'mutated copy'
    expect(await storage.readAccount()).toEqual(account)
    expect(await storage.readRecord('todos', 'todo_1')).toEqual(todo)

    await storage.deleteRecord('todos', 'todo_1')
    expect(await storage.readRecord('todos', 'todo_1')).toBeNull()

    await storage.clearCollection('projects')
    expect(await storage.listRecords('projects')).toEqual([])
    expect(await storage.readAccount()).toEqual(account)

    await storage.writeRecord('todos', todo)
    await storage.clearAll()
    expect(await storage.readAccount()).toBeNull()
    expect(await storage.listRecords('todos')).toEqual([])
    storage.close?.()
  })

  test('compare-and-delete removes only unchanged observations', async () => {
    const storage = create()
    const unchanged = storedRecord('unchanged')
    const changed = storedRecord('changed')
    await storage.writeRecord('todos', unchanged)
    await storage.writeRecord('todos', changed)

    await storage.writeRecord('todos', {
      ...changed,
      data: {
        ...changed.data,
        title: 'changed elsewhere',
      },
    })

    await expect(
      storage.deleteRecordsIfUnchanged('todos', [unchanged, changed]),
    ).resolves.toEqual(['unchanged'])
    expect(await storage.readRecord('todos', 'unchanged')).toBeNull()
    expect(await storage.readRecord('todos', 'changed')).toMatchObject({
      data: { title: 'changed elsewhere' },
    })
    storage.close?.()
  })
})

test('IndexedDB storage upgrades collection stores without losing existing data', async () => {
  const indexedDB = new IDBFactory()
  const namespace = `upgrade-${crypto.randomUUID()}`
  const first = createIndexedDbSyncStorage({
    namespace,
    collections: ['todos'],
    indexedDB,
  })
  await first.writeRecord('todos', storedRecord('todo_1'))
  first.close?.()

  const upgraded = createIndexedDbSyncStorage({
    namespace,
    collections: ['todos', 'projects'],
    indexedDB,
  })
  await upgraded.writeRecord('projects', storedRecord('project_1'))

  expect(await upgraded.readRecord('todos', 'todo_1')).toMatchObject({ id: 'todo_1' })
  expect(await upgraded.readRecord('projects', 'project_1')).toMatchObject({ id: 'project_1' })
  upgraded.close?.()
})

test('separate IndexedDB adapters can share a namespace and reopen after close', async () => {
  const indexedDB = new IDBFactory()
  const namespace = `shared-${crypto.randomUUID()}`
  const first = createIndexedDbSyncStorage({
    namespace,
    collections: ['todos'],
    indexedDB,
  })
  const second = createIndexedDbSyncStorage({
    namespace,
    collections: ['todos'],
    indexedDB,
  })

  await Promise.all([first.readAccount(), second.readAccount()])
  await first.writeRecord('todos', storedRecord('first'))
  await second.writeRecord('todos', storedRecord('second'))

  expect((await first.listRecords('todos')).map((record) => record.id).sort()).toEqual([
    'first',
    'second',
  ])
  first.close?.()
  expect(await first.readRecord('todos', 'second')).toMatchObject({ id: 'second' })
  first.close?.()
  second.close?.()
})
