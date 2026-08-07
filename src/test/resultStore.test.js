'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ResultStore } = require('../storage/resultStore');

describe('ResultStore', () => {
  let temporary;
  let store;

  beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'simple-db-result-'));
    store = new ResultStore(path.join(temporary, 'results'), {
      pageSize: 2,
      maxCellCharacters: 100,
    });
    await store.initialize();
  });

  afterEach(async () => {
    await store?.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  });

  it('pages results on disk without truncating the row count', async () => {
    await store.createExecution('exec-1', { connectionName: 'test' });
    await store.startSet('exec-1', 0, {
      columns: [{ name: 'id', type: 'INTEGER' }],
    });
    await store.appendRows('exec-1', 0, [[1], [2], [3], [4], [5]]);
    await store.finishSet('exec-1', 0);
    const metadata = await store.finalizeExecution('exec-1', { status: 'success' });

    expect(metadata.sets[0].rowCount).toBe(5);
    expect(metadata.sets[0].pages).toBe(3);
    expect(await store.getPage('exec-1', 0, 0)).toEqual([[1], [2]]);
    expect(await store.getPage('exec-1', 0, 2)).toEqual([[5]]);

    const allRows = [];
    for await (const row of store.iterateRows('exec-1', 0)) allRows.push(row);
    expect(allRows).toEqual([[1], [2], [3], [4], [5]]);
  });

  it('allows page size to be reconfigured for new executions', async () => {
    store.configure({ pageSize: 3, maxCellCharacters: 5 });
    await store.createExecution('exec-2', {});
    await store.startSet('exec-2', 0, { columns: [{ name: 'text' }] });
    await store.appendRows('exec-2', 0, [
      ['abcdefghij'],
      ['two'],
      ['three'],
      ['four'],
    ]);
    await store.finishSet('exec-2', 0);
    const metadata = await store.finalizeExecution('exec-2');
    expect(metadata.sets[0].pages).toBe(2);
    expect((await store.getPage('exec-2', 0, 0))[0][0]).toContain('omitidos');
  });
});
