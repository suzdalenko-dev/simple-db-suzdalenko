'use strict';

const { randomUUID } = require('node:crypto');

const HISTORY_KEY = 'simpleDb.queryHistory.v1';
const MAX_SQL_CHARACTERS = 100000;

class HistoryStore {
  constructor(globalState, configurationProvider) {
    this.globalState = globalState;
    this.configurationProvider = configurationProvider;
    this.listeners = new Set();
  }

  _configuration() {
    return this.configurationProvider();
  }

  list() {
    const history = this.globalState.get(HISTORY_KEY, []);
    return Array.isArray(history) ? history.map((entry) => ({ ...entry })) : [];
  }

  get(entryId) {
    return this.list().find((entry) => entry.id === entryId);
  }

  onDidChange(listener) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  _emit() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  async add(entry) {
    const config = this._configuration();
    if (!config.enabled || config.maxEntries <= 0) {
      return null;
    }

    const sql = String(entry.sql || '');
    const stored = {
      id: randomUUID(),
      timestamp: entry.timestamp || new Date().toISOString(),
      engine: entry.engine,
      profileId: entry.profileId,
      connectionName: entry.connectionName,
      database: entry.database || '',
      schema: entry.schema || '',
      sql:
        sql.length > MAX_SQL_CHARACTERS
          ? `${sql.slice(0, MAX_SQL_CHARACTERS)}\n-- [Historial truncado]`
          : sql,
      durationMs: Number(entry.durationMs || 0),
      rows: Number(entry.rows || 0),
      affectedRows: Number(entry.affectedRows || 0),
      success: entry.success !== false,
      error: entry.error ? String(entry.error) : '',
    };

    const history = [stored, ...this.list()].slice(0, config.maxEntries);
    await this.globalState.update(HISTORY_KEY, history);
    this._emit();
    return stored;
  }

  async delete(entryId) {
    await this.globalState.update(
      HISTORY_KEY,
      this.list().filter((entry) => entry.id !== entryId),
    );
    this._emit();
  }

  async clear() {
    await this.globalState.update(HISTORY_KEY, []);
    this._emit();
  }
}

module.exports = {
  HISTORY_KEY,
  HistoryStore,
};
