'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { BaseAdapter } = require('./baseAdapter');
const { QueryCancelledError, normalizeDatabaseError } = require('../core/errors');

class SqliteAdapter extends BaseAdapter {
  constructor(profile, password) {
    super(profile, password);
    this.worker = null;
    this.pending = new Map();
    this.cancelledRequests = new Set();
    this.restarting = false;
  }

  _spawnWorker() {
    const worker = new Worker(path.join(__dirname, 'sqliteWorker.js'));
    this.worker = worker;

    worker.on('message', (message) => this._onWorkerMessage(worker, message));
    worker.on('error', (error) => this._rejectWorkerPending(worker, error));
    worker.on('exit', (code) => {
      if (this.worker === worker && !this.restarting) {
        this.worker = null;
        this.connected = false;
      }
      if (code !== 0) {
        this._rejectWorkerPending(worker, new Error(`SQLite worker exited with code ${code}.`));
      }
    });
    return worker;
  }

  _rejectWorkerPending(worker, error) {
    for (const [requestId, pending] of [...this.pending.entries()]) {
      if (pending.worker !== worker) {
        continue;
      }
      this.pending.delete(requestId);
      if (this.cancelledRequests.has(requestId)) {
        this.cancelledRequests.delete(requestId);
        pending.reject(new QueryCancelledError());
      } else {
        pending.reject(error);
      }
    }
  }

  async _onWorkerMessage(worker, message) {
    const pending = this.pending.get(message.requestId);
    if (!pending || pending.worker !== worker) {
      return;
    }

    if (message.type === 'stream') {
      try {
        if (message.event === 'start') {
          await pending.sink.start(message.setIndex, message.columns);
        } else if (message.event === 'rows') {
          await pending.sink.rows(message.setIndex, message.rows);
        } else if (message.event === 'end') {
          await pending.sink.end(message.setIndex, {
            rowCount: message.rowCount,
            truncated: message.truncated,
          });
        }
        worker.postMessage({
          type: 'ack',
          requestId: message.requestId,
          sequence: message.sequence,
        });
      } catch (error) {
        pending.streamError = error;
        worker.postMessage({
          type: 'ack',
          requestId: message.requestId,
          sequence: message.sequence,
        });
      }
      return;
    }

    this.pending.delete(message.requestId);
    if (message.type === 'error') {
      const error = new Error(message.error?.message || 'Error SQLite');
      error.code = message.error?.code;
      pending.reject(normalizeDatabaseError(error, 'sqlite'));
      return;
    }

    if (pending.streamError) {
      pending.reject(pending.streamError);
      return;
    }
    pending.resolve(message.result);
  }

  _request(type, payload = {}, options = {}) {
    if (!this.worker) {
      return Promise.reject(new Error('SQLite is not connected.'));
    }
    const requestId = options.requestId || randomUUID();
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, {
        resolve,
        reject,
        sink: options.sink,
        streamError: null,
        worker,
      });
      worker.postMessage({ type, requestId, payload });
    });
  }

  async _openCurrentWorker() {
    return this._request('open', {
      filePath: this.profile.filePath,
      readOnly: this.profile.readOnly,
    });
  }

  async connect() {
    try {
      this._spawnWorker();
      const result = await this._openCurrentWorker();
      this.serverVersion = result.version || 'SQLite';
      this.connected = true;
      return this.serverVersion;
    } catch (error) {
      if (this.worker) {
        await this.worker.terminate().catch(() => {});
        this.worker = null;
      }
      throw normalizeDatabaseError(error, 'sqlite');
    }
  }

  async disconnect() {
    if (this.worker) {
      const worker = this.worker;
      if (this.activeExecutions.size === 0) {
        await this._request('close').catch(() => {});
        this.worker = null;
        await worker.terminate().catch(() => {});
      } else {
        for (const [requestId, pending] of this.pending) {
          if (pending.worker === worker) this.cancelledRequests.add(requestId);
        }
        this.worker = null;
        await worker.terminate().catch(() => {});
        this._rejectWorkerPending(worker, new QueryCancelledError());
      }
    }
    this.transactions.clear();
    this.activeExecutions.clear();
    this.connected = false;
  }

  async begin(sessionId) {
    if (this.transactions.size > 0 && !this.transactions.has(sessionId)) {
      throw new Error(
        'Simple DB allows only one active SQLite transaction per file.',
      );
    }
    if (this.transactions.has(sessionId)) {
      throw new Error('This session already has an active SQLite transaction.');
    }
    await this._request('begin');
    this.transactions.set(sessionId, true);
  }

  async commit(sessionId) {
    if (!this.transactions.has(sessionId)) {
      throw new Error('There is no active transaction in this session.');
    }
    await this._request('commit');
    this.transactions.delete(sessionId);
  }

  async rollback(sessionId) {
    if (!this.transactions.has(sessionId)) {
      return;
    }
    await this._request('rollback');
    this.transactions.delete(sessionId);
  }

  async execute(sessionId, sql, options) {
    if (this.transactions.size > 0 && !this.transactions.has(sessionId)) {
      throw new Error(
        'SQLite has an active transaction in another editor. Finish that transaction before executing here.',
      );
    }
    const requestId = randomUUID();
    this.activeExecutions.set(options.executionId, { requestId });
    try {
      const result = await this._request(
        'execute',
        {
          sql,
          maxRows: options.maxRows,
          pageSize: options.pageSize,
        },
        { requestId, sink: options.sink },
      );
      if (result.inTransaction) {
        this.transactions.set(sessionId, true);
      } else {
        this.transactions.delete(sessionId);
      }
      return result;
    } catch (error) {
      if (error instanceof QueryCancelledError) {
        throw error;
      }
      throw normalizeDatabaseError(error, 'sqlite');
    } finally {
      this.activeExecutions.delete(options.executionId);
    }
  }

  async cancel(executionId) {
    const active = this.activeExecutions.get(executionId);
    if (!active || !this.worker) {
      return false;
    }

    const oldWorker = this.worker;
    this.cancelledRequests.add(active.requestId);
    this.restarting = true;
    try {
      await oldWorker.terminate();
      this._rejectWorkerPending(oldWorker, new QueryCancelledError());
      this.worker = null;
      this.transactions.clear();
      this._spawnWorker();
      await this._openCurrentWorker();
      this.connected = true;
      return true;
    } finally {
      this.restarting = false;
    }
  }

  async _queryAll(sql) {
    const result = await this._request('queryAll', { sql });
    return result.rows || [];
  }

  async listDatabases() {
    const databases = await this._queryAll('PRAGMA database_list');
    return databases.map((database) => ({
      name: database.name || 'main',
      file: database.file || this.profile.filePath,
    }));
  }

  async listSchemas(database) {
    return [{ name: database || 'main' }];
  }

  async listTables(_database, schema) {
    return this._queryAll(
      `SELECT name FROM ${this.quoteIdentifier(schema || 'main')}.sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );
  }

  async listViews(_database, schema) {
    return this._queryAll(
      `SELECT name FROM ${this.quoteIdentifier(schema || 'main')}.sqlite_master
        WHERE type = 'view' ORDER BY name`,
    );
  }

  async listColumns(_database, schema, objectName) {
    const rows = await this._queryAll(
      `PRAGMA ${this.quoteIdentifier(schema || 'main')}.table_info(${this.quoteIdentifier(objectName)})`,
    );
    return rows.map((column) => ({
      name: column.name,
      type: column.type || '',
      nullable: !column.notnull,
      position: Number(column.cid || 0) + 1,
    }));
  }

  async listProcedures() {
    return [];
  }

  async listIndexes(_database, schema) {
    return this._queryAll(
      `SELECT name, tbl_name AS tableName
         FROM ${this.quoteIdentifier(schema || 'main')}.sqlite_master
        WHERE type = 'index' AND sql IS NOT NULL
        ORDER BY tbl_name, name`,
    );
  }

  async listTriggers(_database, schema) {
    return this._queryAll(
      `SELECT name, tbl_name AS tableName
         FROM ${this.quoteIdentifier(schema || 'main')}.sqlite_master
        WHERE type = 'trigger'
        ORDER BY name`,
    );
  }

  _stringLiteral(value) {
    return `'${String(value).replaceAll("'", "''")}'`;
  }

  async getObjectDefinition(_database, schema, objectName, objectType) {
    const sqliteType = {
      table: 'table',
      view: 'view',
      index: 'index',
      trigger: 'trigger',
    }[objectType];
    if (!sqliteType) {
      return null;
    }
    const rows = await this._queryAll(
      `SELECT sql AS definition
         FROM ${this.quoteIdentifier(schema || 'main')}.sqlite_master
        WHERE type = ${this._stringLiteral(sqliteType)}
          AND name = ${this._stringLiteral(objectName)}
        LIMIT 1`,
    );
    const definition = rows[0]?.definition;
    return definition ? `${String(definition).trim().replace(/;$/, '')};` : null;
  }
}

module.exports = {
  SqliteAdapter,
};
