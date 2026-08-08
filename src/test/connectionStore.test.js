'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
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
  it('stores the profile separately from the password', async () => {
    const state = memoryMemento();
    const secrets = memorySecrets();
    const store = new ConnectionStore(state, secrets);
    const profile = await store.save(
      {
        name: 'Production PG',
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

  it('keeps an existing secret when editing without a new password', async () => {
    const store = new ConnectionStore(memoryMemento(), memorySecrets());
    const profile = await store.save(
      { name: 'MySQL', engine: 'mysql', host: 'localhost', port: 3306, user: 'u' },
      'old-password',
    );
    await store.save({ ...profile, name: 'MySQL edited' }, undefined, {
      keepExistingPassword: true,
    });
    await expect(store.getPassword(profile.id)).resolves.toBe('old-password');
  });

  it('deletes profile and secret and prevents duplicate names', async () => {
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
    ).rejects.toThrow(/already exists/i);
    await store.delete(one.id);
    expect(store.get(one.id)).toBeUndefined();
    await expect(store.getPassword(one.id)).resolves.toBe('');
  });
});

describe('ConnectionStore JSON files', () => {
  let temporaryDirectory;

  afterEach(async () => {
    if (temporaryDirectory) {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = undefined;
    }
  });

  async function jsonStore(state, secrets) {
    temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'simple-db-connections-'),
    );
    const directoryPath = path.join(temporaryDirectory, 'connections');
    const store = new ConnectionStore(state, secrets, { directoryPath });
    return { store, directoryPath };
  }

  it('migrates an existing profile to a readable JSON file without its password', async () => {
    const state = memoryMemento();
    const secrets = memorySecrets();
    const legacyStore = new ConnectionStore(state, secrets);
    const legacyProfile = await legacyStore.save(
      {
        name: 'Production PG',
        engine: 'postgresql',
        host: 'db.internal',
        port: 5432,
        database: 'app',
        user: 'reader',
        ssl: true,
      },
      'super-secret',
    );
    const { store } = await jsonStore(state, secrets);

    const initialized = await store.initialize();
    const filePath = store.connectionFile(legacyProfile.id);
    const document = JSON.parse(await fs.readFile(filePath, 'utf8'));

    expect(initialized.migrated).toBe(1);
    expect(document).toMatchObject({
      id: legacyProfile.id,
      name: 'Production PG',
      engine: 'postgresql',
      host: 'db.internal',
      port: 5432,
      database: 'app',
      user: 'reader',
    });
    expect(document).not.toHaveProperty('password');
    await expect(store.getPassword(legacyProfile.id)).resolves.toBe('super-secret');
  });

  it('reloads a connection after its JSON file is edited and keeps the secret separate', async () => {
    const state = memoryMemento();
    const secrets = memorySecrets();
    const { store } = await jsonStore(state, secrets);
    await store.initialize();
    const profile = await store.save(
      {
        name: 'MySQL Local',
        engine: 'mysql',
        host: 'localhost',
        port: 3306,
        database: 'app',
        user: 'root',
      },
      'mysql-secret',
    );
    const filePath = store.connectionFile(profile.id);
    const document = JSON.parse(await fs.readFile(filePath, 'utf8'));
    document.host = 'mysql.internal';
    document.port = 3307;
    await fs.writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`);

    const reloaded = await store.reloadFile(filePath);

    expect(reloaded.host).toBe('mysql.internal');
    expect(reloaded.port).toBe(3307);
    await expect(store.getPassword(profile.id)).resolves.toBe('mysql-secret');
  });

  it('rejects passwords in JSON connection files', async () => {
    const state = memoryMemento();
    const secrets = memorySecrets();
    const { store } = await jsonStore(state, secrets);
    await store.initialize();
    const profile = await store.save(
      {
        name: 'Oracle',
        engine: 'oracle',
        host: 'oracle.internal',
        port: 1521,
        serviceName: 'ORCLPDB1',
        user: 'reader',
      },
      'secret',
    );
    const filePath = store.connectionFile(profile.id);
    const document = JSON.parse(await fs.readFile(filePath, 'utf8'));
    document.password = 'must-not-be-here';
    await fs.writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`);

    await expect(store.reloadFile(filePath)).rejects.toThrow(/do not store passwords/i);
  });

  it('removes the JSON file and secure password when deleting a connection', async () => {
    const state = memoryMemento();
    const secrets = memorySecrets();
    const { store } = await jsonStore(state, secrets);
    await store.initialize();
    const profile = await store.save(
      {
        name: 'SQL Server',
        engine: 'sqlserver',
        host: 'sql.internal',
        port: 1433,
        database: 'master',
        user: 'sa',
      },
      'secret',
    );
    const filePath = store.connectionFile(profile.id);

    await store.delete(profile.id);

    await expect(fs.access(filePath)).rejects.toThrow();
    expect(store.get(profile.id)).toBeUndefined();
    await expect(store.getPassword(profile.id)).resolves.toBe('');
  });
});
