import {
  isJsonRecord,
  parseSyncRequest,
  parseSyncResponse,
} from '../src/protocol.js'

test('JSON records accept nested plain data and reject non-JSON runtime values', () => {
  expect(
    isJsonRecord({
      string: 'value',
      number: 1,
      boolean: true,
      null: null,
      array: [1, { nested: 'value' }],
      object: { nested: ['value'] },
    }),
  ).toBe(true)

  expect(isJsonRecord({ value: Number.NaN })).toBe(false)
  expect(isJsonRecord({ value: Number.POSITIVE_INFINITY })).toBe(false)
  expect(isJsonRecord({ value: undefined })).toBe(false)
  expect(isJsonRecord({ value: new Date('2026-01-01T00:00:00.000Z') })).toBe(false)
  expect(isJsonRecord(new (class RecordValue {})())).toBe(false)
})

test('sync request parsing validates every operation shape', () => {
  expect(
    parseSyncRequest({
      clientId: 'device_1',
      schemaVersion: 1,
      lastServerSeq: null,
      ops: [
        {
          mutationId: 'm1',
          collection: 'todos',
          type: 'create',
          id: 'todo_1',
          value: { id: 'todo_1', title: 'Create' },
          touched: ['id', 'title'],
        },
        {
          mutationId: 'm2',
          collection: 'todos',
          type: 'update',
          id: 'todo_1',
          patch: { title: 'Update' },
          touched: ['title'],
          baseServerVersion: 1,
        },
        {
          mutationId: 'm3',
          collection: 'todos',
          type: 'delete',
          id: 'todo_1',
          baseServerVersion: 2,
        },
      ],
    }).ops,
  ).toHaveLength(3)

  expect(() =>
    parseSyncRequest({
      clientId: '',
      schemaVersion: -1,
      lastServerSeq: null,
      ops: [],
    }),
  ).toThrow()
  expect(() =>
    parseSyncRequest({
      clientId: 'device_1',
      schemaVersion: 1,
      lastServerSeq: null,
      ops: [
        {
          mutationId: 'm1',
          collection: 'todos',
          type: 'update',
          id: 'todo_1',
          patch: { title: 'Update' },
          touched: ['title'],
        },
      ],
    }),
  ).toThrow()
})

test('sync response parsing validates acknowledgements, rejections, and changes', () => {
  expect(
    parseSyncResponse({
      serverSeq: 2,
      accepted: [
        {
          mutationId: 'm1',
          collection: 'todos',
          id: 'todo_1',
          serverVersion: 2,
        },
      ],
      rejected: [
        {
          mutationId: 'm2',
          collection: 'todos',
          id: 'todo_2',
          reason: 'conflict',
          serverVersion: 2,
          serverRecord: { id: 'todo_2' },
        },
      ],
      changes: {
        todos: {
          mode: 'changes',
          upserted: [
            {
              id: 'todo_3',
              serverVersion: 2,
              record: { id: 'todo_3' },
            },
          ],
          deleted: [{ id: 'todo_4', serverVersion: 2 }],
        },
      },
    }).serverSeq,
  ).toBe(2)

  expect(() =>
    parseSyncResponse({
      serverSeq: -1,
      accepted: [],
      rejected: [],
      changes: {},
    }),
  ).toThrow()
  expect(() =>
    parseSyncResponse({
      serverSeq: 1,
      accepted: [],
      rejected: [{ mutationId: 'm1', collection: 'todos', id: 'todo_1', reason: 'unknown' }],
      changes: {},
    }),
  ).toThrow()
  expect(() =>
    parseSyncResponse({
      serverSeq: 1,
      accepted: [],
      rejected: [],
      changes: {
        todos: {
          upserted: [{ id: 'todo_1', serverVersion: -1, record: { id: 'todo_1' } }],
          deleted: [],
        },
      },
    }),
  ).toThrow()
})
