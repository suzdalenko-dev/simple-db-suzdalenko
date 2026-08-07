'use strict';

const { ConnectionStore, PROFILES_KEY } = require('../storage/connectionStore');

function memoryMemento() {
  const values = new Map();
  return {
    get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
    update: async (key, value) => values.set(key, value),
    values,
  };
}

function memorySecrets() {
  const values = new Map();
  return {
    get: async (key) => values.get(key),
    store: async (key, value) => values.set(key, value),
    delete: async (key) => values.delete(key),
    values,
  };
}

describe('ConnectionStore', () => {
  it('guarda el perfil separado de la contraseña', async () => {
    const state = memoryMemento();
    const secrets = memorySecrets();
    const store = new ConnectionStore(state, secrets);
    const profile = await store.save(
      {
        name: 'Producción PG',
        engine: 'postgresql',
        host: 'db.internal',
        port: 5432,
        database: 'app',
        user: 'reader',
        ssl: true,
      },
      'super-secret',
    );

    await expect(store.getPassword(profile.id)).resolves.toBe('super-secret');
    expect(JSON.stringify(state.values.get(PROFILES_KEY))).not.toContain('super-secret');
    expect(store.get(profile.id)).not.toHaveProperty('password');
  });

  it('conserva un secreto existente al editar si no se proporciona contraseña', async () => {
    const store = new ConnectionStore(memoryMemento(), memorySecrets());
    const profile = await store.save(
      { name: 'MySQL', engine: 'mysql', host: 'localhost', port: 3306, user: 'u' },
      'old-password',
    );
    await store.save({ ...profile, name: 'MySQL editado' }, undefined, {
      keepExistingPassword: true,
    });
    await expect(store.getPassword(profile.id)).resolves.toBe('old-password');
  });

  it('elimina perfil y secreto y evita nombres duplicados', async () => {
    const state = memoryMemento();
    const secrets = memorySecrets();
    const store = new ConnectionStore(state, secrets);
    const one = await store.save(
      { name: 'Oracle', engine: 'oracle', host: 'host', database: 'svc', user: 'u' },
      'pw',
    );
    await expect(
      store.save(
        { name: 'Oracle', engine: 'sqlite', filePath: '/tmp/other.db' },
        '',
      ),
    ).rejects.toThrow(/Ya existe/);
    await store.delete(one.id);
    expect(store.get(one.id)).toBeUndefined();
    await expect(store.getPassword(one.id)).resolves.toBe('');
  });
});
