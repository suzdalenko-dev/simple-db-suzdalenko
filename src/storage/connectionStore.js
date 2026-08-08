'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDatabaseEngineId } = require('../databaseEngines');

const PROFILES_KEY = 'simpleDb.connectionProfiles.v1';
const JSON_MIGRATION_KEY = 'simpleDb.connectionProfiles.jsonMigration.v1';
const PASSWORD_PREFIX = 'simpleDb.password.';

function sanitizeProfile(profile) {
  const common = {
    id: String(profile.id || ''),
    name: String(profile.name || '').trim(),
    engine: String(profile.engine || ''),
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

function validateProfile(profile) {
  if (!profile.id) {
    throw new Error('Connection id is required.');
  }
  if (!profile.name) {
    throw new Error('Connection name is required.');
  }
  if (!isDatabaseEngineId(profile.engine)) {
    throw new Error(`Invalid database engine: ${profile.engine}`);
  }
  if (profile.engine === 'sqlite' && !profile.filePath) {
    throw new Error('SQLite file path is required.');
  }
}

function profileDocument(profile) {
  const common = {
    id: profile.id,
    name: profile.name,
    engine: profile.engine,
  };

  let connection;
  if (profile.engine === 'sqlite') {
    connection = {
      filePath: profile.filePath,
      readOnly: Boolean(profile.readOnly),
    };
  } else if (profile.engine === 'oracle') {
    connection = {
      host: profile.host,
      port: profile.port || 1521,
      serviceName: profile.serviceName || profile.database || '',
      connectString: profile.connectString || '',
      user: profile.user,
    };
  } else if (profile.engine === 'sqlserver') {
    connection = {
      host: profile.host,
      port: profile.port || 1433,
      database: profile.database,
      user: profile.user,
      instanceName: profile.instanceName || '',
      encrypt: profile.encrypt !== false,
      trustServerCertificate: Boolean(profile.trustServerCertificate),
    };
  } else {
    connection = {
      host: profile.host,
      port: profile.port,
      database: profile.database,
      user: profile.user,
      ssl: Boolean(profile.ssl),
      trustServerCertificate: Boolean(profile.trustServerCertificate),
    };
  }

  return {
    ...common,
    ...connection,
    connectTimeoutMs: profile.connectTimeoutMs,
    queryTimeoutMs: profile.queryTimeoutMs,
  };
}

function fileSlug(name) {
  const slug = String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'connection';
}

class ConnectionStore {
  constructor(globalState, secrets, options = {}) {
    this.globalState = globalState;
    this.secrets = secrets;
    this.directoryPath = options.directoryPath || '';
    this.profiles = null;
    this.profileFiles = new Map();
  }

  _legacyProfiles() {
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

  async initialize() {
    if (!this.directoryPath) {
      this.profiles = this._legacyProfiles();
      return { migrated: 0, errors: [] };
    }

    await fs.mkdir(this.directoryPath, { recursive: true });
    let migrated = 0;
    if (!this.globalState.get(JSON_MIGRATION_KEY, false)) {
      const existingIds = new Set();
      for (const fileName of await this._jsonFileNames()) {
        try {
          const raw = JSON.parse(
            await fs.readFile(path.join(this.directoryPath, fileName), 'utf8'),
          );
          if (raw?.id) existingIds.add(String(raw.id));
        } catch {
          // Invalid files are reported by reload(); migration leaves them untouched.
        }
      }
      for (const legacyProfile of this._legacyProfiles()) {
        if (existingIds.has(legacyProfile.id)) continue;
        const profile = sanitizeProfile(legacyProfile);
        validateProfile(profile);
        const filePath = await this._availableFilePath(profile.name, profile.id);
        await this._writeProfileFile(filePath, profile);
        migrated += 1;
      }
      await this.globalState.update(JSON_MIGRATION_KEY, true);
    }

    const result = await this.reload();
    return { migrated, errors: result.errors };
  }

  async _jsonFileNames() {
    if (!this.directoryPath) return [];
    const entries = await fs.readdir(this.directoryPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  }

  async reload() {
    if (!this.directoryPath) {
      this.profiles = this._legacyProfiles();
      return { profiles: this.list(), errors: [] };
    }

    const profiles = [];
    const profileFiles = new Map();
    const errors = [];
    const names = new Set();

    for (const fileName of await this._jsonFileNames()) {
      const filePath = path.join(this.directoryPath, fileName);
      try {
        const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
        if (Object.hasOwn(raw, 'password')) {
          throw new Error(
            'Do not store passwords in connection JSON files. Use Simple DB: Set Password.',
          );
        }
        if (!raw?.id) {
          throw new Error('The connection JSON must contain an "id" field.');
        }
        const profile = sanitizeProfile(raw);
        validateProfile(profile);
        const normalizedName = profile.name.toLocaleLowerCase();
        if (profileFiles.has(profile.id)) {
          throw new Error(`Duplicate connection id "${profile.id}".`);
        }
        if (names.has(normalizedName)) {
          throw new Error(`Duplicate connection name "${profile.name}".`);
        }
        names.add(normalizedName);
        profiles.push(profile);
        profileFiles.set(profile.id, filePath);
      } catch (error) {
        errors.push({ filePath, message: error.message });
      }
    }

    this.profiles = profiles;
    this.profileFiles = profileFiles;
    await this._syncLegacyState();
    return { profiles: this.list(), errors };
  }

  list() {
    const profiles = this.profiles || this._legacyProfiles();
    return profiles.map((profile) => ({ ...profile }));
  }

  get(profileId) {
    return this.list().find((profile) => profile.id === profileId);
  }

  connectionFile(profileId) {
    return this.profileFiles.get(profileId) || '';
  }

  connectionDirectory() {
    return this.directoryPath;
  }

  isConnectionFile(filePath) {
    if (!this.directoryPath || !filePath) return false;
    return (
      path.dirname(path.resolve(filePath)) === path.resolve(this.directoryPath) &&
      path.extname(filePath).toLowerCase() === '.json'
    );
  }

  profileIdForFile(filePath) {
    const target = path.resolve(filePath);
    for (const [profileId, candidate] of this.profileFiles) {
      if (path.resolve(candidate) === target) return profileId;
    }
    return '';
  }

  async getPassword(profileId) {
    return (await this.secrets.get(`${PASSWORD_PREFIX}${profileId}`)) || '';
  }

  async setPassword(profileId, password) {
    if (!this.get(profileId)) {
      throw new Error('The connection no longer exists.');
    }
    await this.secrets.store(`${PASSWORD_PREFIX}${profileId}`, String(password ?? ''));
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
    validateProfile(profile);

    const profiles = this.list();
    const duplicate = profiles.find(
      (candidate) =>
        candidate.id !== id &&
        candidate.name.localeCompare(profile.name, undefined, {
          sensitivity: 'accent',
        }) === 0,
    );
    if (duplicate) {
      throw new Error(`A connection named "${profile.name}" already exists.`);
    }

    const index = profiles.findIndex((candidate) => candidate.id === id);
    if (index >= 0) profiles[index] = profile;
    else profiles.push(profile);
    this.profiles = profiles;

    if (this.directoryPath) {
      const filePath =
        this.profileFiles.get(id) || (await this._availableFilePath(profile.name, id));
      await this._writeProfileFile(filePath, profile);
      this.profileFiles.set(id, filePath);
    }
    await this._syncLegacyState();

    if (profile.engine === 'sqlite') {
      await this.secrets.delete(`${PASSWORD_PREFIX}${id}`);
    } else if (password !== undefined && password !== null && password !== '') {
      await this.secrets.store(`${PASSWORD_PREFIX}${id}`, String(password));
    } else if (!existing && !options.keepExistingPassword) {
      await this.secrets.store(`${PASSWORD_PREFIX}${id}`, '');
    }

    return { ...profile };
  }

  async reloadFile(filePath) {
    if (!this.isConnectionFile(filePath)) {
      throw new Error('The selected file is not a Simple DB connection JSON.');
    }
    const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (Object.hasOwn(raw, 'password')) {
      throw new Error(
        'Do not store passwords in connection JSON files. Use Simple DB: Set Password.',
      );
    }
    if (!raw?.id) {
      throw new Error('The connection JSON must contain an "id" field.');
    }
    const expectedId = this.profileIdForFile(filePath);
    if (expectedId && String(raw.id) !== expectedId) {
      throw new Error('The connection "id" field is internal and must not be changed.');
    }

    const profile = sanitizeProfile(raw);
    validateProfile(profile);
    const duplicate = this.list().find(
      (candidate) =>
        candidate.id !== profile.id &&
        candidate.name.localeCompare(profile.name, undefined, {
          sensitivity: 'accent',
        }) === 0,
    );
    if (duplicate) {
      throw new Error(`A connection named "${profile.name}" already exists.`);
    }

    const profiles = this.list();
    const index = profiles.findIndex((candidate) => candidate.id === profile.id);
    if (index >= 0) profiles[index] = profile;
    else profiles.push(profile);
    this.profiles = profiles;
    this.profileFiles.set(profile.id, filePath);
    await this._syncLegacyState();
    return { ...profile };
  }

  async delete(profileId) {
    this.profiles = this.list().filter((profile) => profile.id !== profileId);
    const filePath = this.profileFiles.get(profileId);
    if (filePath) {
      await fs.unlink(filePath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      this.profileFiles.delete(profileId);
    }
    await this._syncLegacyState();
    await this.secrets.delete(`${PASSWORD_PREFIX}${profileId}`);
  }

  async _availableFilePath(name, profileId) {
    const base = fileSlug(name);
    let candidate = path.join(this.directoryPath, `${base}.json`);
    try {
      await fs.access(candidate);
      candidate = path.join(this.directoryPath, `${base}-${profileId.slice(0, 8)}.json`);
    } catch {
      // The readable name is available.
    }
    return candidate;
  }

  async _writeProfileFile(filePath, profile) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const content = `${JSON.stringify(profileDocument(profile), null, 2)}\n`;
    await fs.writeFile(filePath, content, { encoding: 'utf8', mode: 0o600 });
  }

  async _syncLegacyState() {
    await this.globalState.update(PROFILES_KEY, this.list());
  }
}

module.exports = {
  ConnectionStore,
  JSON_MIGRATION_KEY,
  PROFILES_KEY,
  profileDocument,
  sanitizeProfile,
};
