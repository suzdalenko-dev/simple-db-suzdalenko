'use strict';

const {
  EDITOR_CONNECTIONS_KEY,
  EditorConnectionStore,
} = require('../storage/editorConnectionStore');

function memoryMemento() {
  const values = new Map();
  return {
    get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
    update: async (key, value) => values.set(key, value),
    values,
  };
}

describe('EditorConnectionStore', () => {
  it('remembers a connection independently for each saved SQL file', async () => {
    const state = memoryMemento();
    const store = new EditorConnectionStore(state);
    await store.set('file:///work/report.sql', {
      profileId: 'oracle-production',
      database: 'ORCL',
      schema: 'FROXA',
    });
    await store.set('file:///work/local.sql', {
      profileId: 'sqlite-local',
      database: 'main',
      schema: 'main',
    });

    expect(store.get('file:///work/report.sql')).toEqual({
      profileId: 'oracle-production',
      database: 'ORCL',
      schema: 'FROXA',
    });
    expect(store.get('file:///work/local.sql').profileId).toBe('sqlite-local');
    expect(state.values.get(EDITOR_CONNECTIONS_KEY)).toHaveProperty(
      'file:///work/report.sql',
    );
  });

  it('removes every saved SQL-file binding when its connection is deleted', async () => {
    const store = new EditorConnectionStore(memoryMemento());
    await store.set('file:///one.sql', { profileId: 'deleted' });
    await store.set('file:///two.sql', { profileId: 'keep' });
    await store.set('file:///three.sql', { profileId: 'deleted' });

    await store.deleteProfile('deleted');

    expect(store.get('file:///one.sql')).toBeUndefined();
    expect(store.get('file:///three.sql')).toBeUndefined();
    expect(store.get('file:///two.sql').profileId).toBe('keep');
  });
});
