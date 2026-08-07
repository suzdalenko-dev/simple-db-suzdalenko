'use strict';

const { randomUUID } = require('node:crypto');
const { isDatabaseEngineId } = require('../databaseEngines');

const PROFILES_KEY = 'simpleDb.connectionProfiles.v1';
const PASSWORD_PREFIX = 'simpleDb.password.';

function sanitizeProfile(profile) {
  const common = {
    id: String(profile.id),
    name: String(profile.name).trim(),
    engine: String(profile.engine),
    connectTimeoutMs: Number(profile.connectTimeoutMs || 15000),
    queryTimeoutMs: Number(profile.queryTimeoutMs ?? 300000),
    createdAt: profile.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (profile.engine === 'sqlite') {
    return {
      ...common,
      filePath: String(profile.filePath || ''),
      readOnly: Boolean(profile.readOnly),
    };
  }

  const network = {
    ...common,
    host: String(profile.host || ''),
    port: Number(profile.port || 0),
    user: String(profile.user || ''),
    database: String(profile.database || ''),
  };

  if (profile.engine === 'postgresql' || profile.engine === 'mysql') {
    return {
      ...network,
      ssl: Boolean(profile.ssl),
      trustServerCertificate: Boolean(profile.trustServerCertificate),
    };
  }

  if (profile.engine === 'sqlserver') {
    return {
      ...network,
      encrypt: profile.encrypt !== false,
      trustServerCertificate: Boolean(profile.trustServerCertificate),
      instanceName: String(profile.instanceName || ''),
    };
  }

  if (profile.engine === 'oracle') {
    return {
      ...network,
      serviceName: String(profile.serviceName || profile.database || ''),
      connectString: String(profile.connectString || ''),
    };
  }

  return network;
}

class ConnectionStore {
  constructor(globalState, secrets) {
    this.globalState = globalState;
    this.secrets = secrets;
  }

  list() {
    const profiles = this.globalState.get(PROFILES_KEY, []);
    if (!Array.isArray(profiles)) {
      return [];
    }

    return profiles
      .filter(
        (profile) =>
          profile &&
          typeof profile.id === 'string' &&
          typeof profile.name === 'string' &&
          isDatabaseEngineId(profile.engine),
      )
      .map((profile) => ({ ...profile }));
  }

  get(profileId) {
    return this.list().find((profile) => profile.id === profileId);
  }

  async getPassword(profileId) {
    return (await this.secrets.get(`${PASSWORD_PREFIX}${profileId}`)) || '';
  }

  async save(input, password, options = {}) {
    const existing = input.id ? this.get(input.id) : undefined;
    const id = existing?.id || input.id || randomUUID();
    const profile = sanitizeProfile({
      ...existing,
      ...input,
      id,
      createdAt: existing?.createdAt || input.createdAt,
    });

    if (!profile.name) {
      throw new Error('El nombre de la conexión es obligatorio.');
    }
    if (!isDatabaseEngineId(profile.engine)) {
      throw new Error(`Motor de base de datos no válido: ${profile.engine}`);
    }
    if (profile.engine === 'sqlite' && !profile.filePath) {
      throw new Error('La ruta del archivo SQLite es obligatoria.');
    }

    const profiles = this.list();
    const duplicate = profiles.find(
      (candidate) =>
        candidate.id !== id &&
        candidate.name.localeCompare(profile.name, undefined, {
          sensitivity: 'accent',
        }) === 0,
    );
    if (duplicate) {
      throw new Error(`Ya existe una conexión llamada "${profile.name}".`);
    }

    const index = profiles.findIndex((candidate) => candidate.id === id);
    if (index >= 0) {
      profiles[index] = profile;
    } else {
      profiles.push(profile);
    }
    await this.globalState.update(PROFILES_KEY, profiles);

    if (profile.engine === 'sqlite') {
      await this.secrets.delete(`${PASSWORD_PREFIX}${id}`);
    } else if (password !== undefined && password !== null && password !== '') {
      await this.secrets.store(`${PASSWORD_PREFIX}${id}`, String(password));
    } else if (!existing && !options.keepExistingPassword) {
      await this.secrets.store(`${PASSWORD_PREFIX}${id}`, '');
    }

    return { ...profile };
  }

  async delete(profileId) {
    const profiles = this.list().filter((profile) => profile.id !== profileId);
    await this.globalState.update(PROFILES_KEY, profiles);
    await this.secrets.delete(`${PASSWORD_PREFIX}${profileId}`);
  }
}

module.exports = {
  ConnectionStore,
  PROFILES_KEY,
  sanitizeProfile,
};
