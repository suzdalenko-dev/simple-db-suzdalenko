'use strict';

const { EventEmitter } = require('node:events');
const { createAdapter } = require('../adapters/factory');

class ConnectionManager extends EventEmitter {
  constructor(connectionStore) {
    super();
    this.connectionStore = connectionStore;
    this.adapters = new Map();
    this.statuses = new Map();
    this.connecting = new Map();
  }

  status(profileId) {
    return (
      this.statuses.get(profileId) || {
        state: 'disconnected',
        serverVersion: '',
        error: '',
      }
    );
  }

  _setStatus(profileId, state, details = {}) {
    const previous = this.status(profileId);
    this.statuses.set(profileId, {
      state,
      serverVersion: Object.hasOwn(details, 'serverVersion')
        ? details.serverVersion
        : previous.serverVersion || '',
      error: Object.hasOwn(details, 'error') ? details.error : '',
    });
    this.emit('change', profileId);
  }

  isConnected(profileId) {
    return this.adapters.get(profileId)?.isConnected() === true;
  }

  async connect(profileId) {
    if (this.isConnected(profileId)) {
      return this.adapters.get(profileId);
    }
    if (this.connecting.has(profileId)) {
      return this.connecting.get(profileId);
    }

    const promise = this._connect(profileId);
    this.connecting.set(profileId, promise);
    try {
      return await promise;
    } finally {
      this.connecting.delete(profileId);
    }
  }

  async _connect(profileId) {
    const profile = this.connectionStore.get(profileId);
    if (!profile) {
      throw new Error('The connection no longer exists.');
    }
    this._setStatus(profileId, 'connecting');
    const password = await this.connectionStore.getPassword(profileId);
    const adapter = createAdapter(profile, password);
    try {
      const serverVersion = await adapter.connect();
      this.adapters.set(profileId, adapter);
      this._setStatus(profileId, 'connected', { serverVersion });
      return adapter;
    } catch (error) {
      this._setStatus(profileId, 'error', { error: error.message });
      throw error;
    }
  }

  async disconnect(profileId) {
    const adapter = this.adapters.get(profileId);
    if (adapter) {
      try {
        await adapter.disconnect();
      } finally {
        this.adapters.delete(profileId);
      }
    }
    this._setStatus(profileId, 'disconnected', { serverVersion: '' });
  }

  async disconnectAll() {
    await Promise.allSettled(
      [...this.adapters.keys()].map((profileId) => this.disconnect(profileId)),
    );
  }

  async testProfile(profile, password) {
    const adapter = createAdapter(profile, password || '');
    const started = Date.now();
    try {
      const serverVersion = await adapter.connect();
      return {
        serverVersion,
        elapsedMs: Date.now() - started,
      };
    } finally {
      await adapter.disconnect().catch(() => {});
    }
  }

  async testConnection(profileId) {
    const profile = this.connectionStore.get(profileId);
    if (!profile) {
      throw new Error('The connection no longer exists.');
    }
    const password = await this.connectionStore.getPassword(profileId);
    return this.testProfile(profile, password);
  }

  async ensureConnected(profileId) {
    return this.isConnected(profileId)
      ? this.adapters.get(profileId)
      : this.connect(profileId);
  }

  getAdapter(profileId) {
    const adapter = this.adapters.get(profileId);
    if (!adapter?.isConnected()) {
      throw new Error('The connection is not connected.');
    }
    return adapter;
  }

  async execute(profileId, sessionId, sql, options) {
    const adapter = await this.ensureConnected(profileId);
    return adapter.execute(sessionId, sql, options);
  }

  async begin(profileId, sessionId, context = {}) {
    const adapter = await this.ensureConnected(profileId);
    await adapter.begin(sessionId, context);
    this._setStatus(profileId, 'connected', {
      serverVersion: this.status(profileId).serverVersion,
    });
    this.emit('transaction', { profileId, sessionId, active: true });
  }

  async commit(profileId, sessionId) {
    const adapter = this.getAdapter(profileId);
    await adapter.commit(sessionId);
    this.emit('transaction', { profileId, sessionId, active: false });
    this.emit('change', profileId);
  }

  async rollback(profileId, sessionId) {
    const adapter = this.getAdapter(profileId);
    await adapter.rollback(sessionId);
    this.emit('transaction', { profileId, sessionId, active: false });
    this.emit('change', profileId);
  }

  hasTransaction(profileId, sessionId) {
    return this.adapters.get(profileId)?.hasTransaction(sessionId) === true;
  }

  transactionCount(profileId) {
    return this.adapters.get(profileId)?.transactionCount() || 0;
  }

  executionCount(profileId) {
    return this.adapters.get(profileId)?.executionCount() || 0;
  }

  async cancel(profileId, executionId) {
    const adapter = this.adapters.get(profileId);
    if (!adapter) {
      return false;
    }
    const cancelled = await adapter.cancel(executionId);
    this.emit('change', profileId);
    return cancelled;
  }

  notifyChanged(profileId) {
    this.emit('change', profileId);
  }

  async listDatabases(profileId) {
    return this.getAdapter(profileId).listDatabases();
  }

  async listSchemas(profileId, database) {
    return this.getAdapter(profileId).listSchemas(database);
  }

  async listTables(profileId, database, schema) {
    return this.getAdapter(profileId).listTables(database, schema);
  }

  async listViews(profileId, database, schema) {
    return this.getAdapter(profileId).listViews(database, schema);
  }

  async listColumns(profileId, database, schema, objectName) {
    return this.getAdapter(profileId).listColumns(database, schema, objectName);
  }

  async listProcedures(profileId, database, schema) {
    return this.getAdapter(profileId).listProcedures(database, schema);
  }

  async listObjectGroup(profileId, database, schema, groupType) {
    const adapter = this.getAdapter(profileId);
    const methods = {
      tables: 'listTables',
      views: 'listViews',
      materializedViews: 'listMaterializedViews',
      procedures: 'listProcedures',
      packages: 'listPackages',
      indexes: 'listIndexes',
      triggers: 'listTriggers',
      sequences: 'listSequences',
      types: 'listTypes',
      synonyms: 'listSynonyms',
      events: 'listEvents',
    };
    const method = methods[groupType];
    if (!method || typeof adapter[method] !== 'function') {
      return [];
    }
    return adapter[method](database, schema);
  }

  async getObjectDefinition(
    profileId,
    database,
    schema,
    objectName,
    objectType,
    metadata = {},
  ) {
    return this.getAdapter(profileId).getObjectDefinition(
      database,
      schema,
      objectName,
      objectType,
      metadata,
    );
  }

  quoteTable(profileId, database, schema, table) {
    return this.getAdapter(profileId).quoteTable(database, schema, table);
  }

  quoteIdentifier(profileId, identifier) {
    return this.getAdapter(profileId).quoteIdentifier(identifier);
  }
}

module.exports = {
  ConnectionManager,
};
