'use strict';

const mysql = require('mysql2');
const { BaseAdapter } = require('./baseAdapter');
const { normalizeDatabaseError } = require('../core/errors');

function mysqlFieldType(field) {
  const typeId = field?.columnType ?? field?.type;
  return mysql.Types?.[typeId] || String(typeId ?? '');
}

function callbackPromise(register) {
  return new Promise((resolve, reject) => {
    register((error, ...values) => {
      if (error) {
        reject(error);
      } else {
        resolve(values.length <= 1 ? values[0] : values);
      }
    });
  });
}

function wrapMysqlDefinition(definition) {
  if (!definition) return null;
  const sql = String(definition).trim().replace(/;\s*$/, '');
  return `DELIMITER $$\n${sql}$$\nDELIMITER ;`;
}

class MySqlAdapter extends BaseAdapter {
  constructor(profile, password) {
    super(profile, password);
    this.pool = null;
  }

  _config() {
    return {
      host: this.profile.host,
      port: this.profile.port || 3306,
      user: this.profile.user,
      password: this.password,
      database: this.profile.database || undefined,
      connectTimeout: this.profile.connectTimeoutMs || 15000,
      waitForConnections: true,
      connectionLimit: 5,
      maxIdle: 5,
      idleTimeout: 30000,
      enableKeepAlive: true,
      multipleStatements: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: false,
      ssl: this.profile.ssl
        ? { rejectUnauthorized: !this.profile.trustServerCertificate }
        : undefined,
    };
  }

  _getConnection() {
    return callbackPromise((done) => this.pool.getConnection(done));
  }

  _query(target, statement, values = []) {
    return callbackPromise((done) => target.query(statement, values, done));
  }

  _selectDatabase(connection, database) {
    const target = database || this.profile.database;
    if (!target) return Promise.resolve();
    return callbackPromise((done) =>
      connection.changeUser(
        {
          user: this.profile.user,
          password: this.password,
          database: target,
        },
        done,
      ),
    );
  }

  async connect() {
    try {
      this.pool = mysql.createPool(this._config());
      const [rows] = await this._query(this.pool, 'SELECT VERSION() AS version');
      this.serverVersion = rows[0]?.version || 'MySQL';
      this.connected = true;
      return this.serverVersion;
    } catch (error) {
      if (this.pool) {
        await callbackPromise((done) => this.pool.end(done)).catch(() => {});
        this.pool = null;
      }
      throw normalizeDatabaseError(error, 'mysql');
    }
  }

  async disconnect() {
    await this.cancelAll();
    await this.rollbackAll();
    if (this.pool) {
      await callbackPromise((done) => this.pool.end(done));
      this.pool = null;
    }
    this.connected = false;
  }

  async begin(sessionId, context = {}) {
    if (this.transactions.has(sessionId)) {
      throw new Error('This session already has an active MySQL transaction.');
    }
    const connection = await this._getConnection();
    try {
      await this._selectDatabase(connection, context.database);
      if (context.beginSql) {
        await this._query(connection, context.beginSql);
      } else {
        await callbackPromise((done) => connection.beginTransaction(done));
      }
      this.transactions.set(sessionId, connection);
    } catch (error) {
      connection.release();
      throw normalizeDatabaseError(error, 'mysql');
    }
  }

  async commit(sessionId) {
    const connection = this.transactions.get(sessionId);
    if (!connection) {
      throw new Error('There is no active transaction in this session.');
    }
    try {
      await callbackPromise((done) => connection.commit(done));
    } finally {
      this.transactions.delete(sessionId);
      connection.release();
    }
  }

  async rollback(sessionId) {
    const connection = this.transactions.get(sessionId);
    if (!connection) {
      return;
    }
    try {
      await callbackPromise((done) => connection.rollback(done));
    } finally {
      this.transactions.delete(sessionId);
      connection.release();
    }
  }

  async execute(sessionId, sql, options) {
    const transactionConnection = this.transactions.get(sessionId);
    const connection = transactionConnection || (await this._getConnection());
    if (!transactionConnection) {
      try {
        await this._selectDatabase(connection, options.database);
      } catch (error) {
        connection.release();
        throw normalizeDatabaseError(error, 'mysql');
      }
    }
    const timeout = Math.max(0, Number(this.profile.queryTimeoutMs || 0));
    const query = connection.query({
      sql,
      timeout: timeout || undefined,
      rowsAsArray: true,
    });
    this.activeExecutions.set(options.executionId, {
      threadId: connection.threadId,
    });

    let databaseResultIndex = -1;
    let rowSetCount = 0;
    let rowsAffected = 0;
    let queue = Promise.resolve();
    const setByDatabaseIndex = new Map();
    const buffers = new Map();
    const seenRows = new Map();

    const flush = (setIndex, useBackpressure) => {
      const buffer = buffers.get(setIndex) || [];
      if (!buffer.length) {
        return;
      }
      buffers.set(setIndex, []);
      if (useBackpressure) {
        connection.pause();
      }
      queue = queue
        .then(() => options.sink.rows(setIndex, buffer))
        .finally(() => {
          if (useBackpressure) {
            connection.resume();
          }
        });
    };

    query.on('fields', (fields) => {
      databaseResultIndex += 1;
      if (!Array.isArray(fields)) {
        return;
      }
      const setIndex = rowSetCount;
      rowSetCount += 1;
      setByDatabaseIndex.set(databaseResultIndex, setIndex);
      buffers.set(setIndex, []);
      seenRows.set(setIndex, 0);
      const columns = fields.map((field, index) => ({
        name: field.name || `Column ${index + 1}`,
        type: mysqlFieldType(field),
      }));
      queue = queue.then(() => options.sink.start(setIndex, columns));
    });

    query.on('result', (row, resultIndex) => {
      if (!Array.isArray(row)) {
        rowsAffected += Number(row?.affectedRows || row?.changedRows || 0);
        return;
      }

      const databaseIndex = Number.isInteger(resultIndex)
        ? resultIndex
        : databaseResultIndex;
      const setIndex = setByDatabaseIndex.get(databaseIndex);
      if (setIndex === undefined) {
        return;
      }

      const seen = (seenRows.get(setIndex) || 0) + 1;
      seenRows.set(setIndex, seen);
      if (options.maxRows > 0 && seen > options.maxRows) {
        return;
      }
      const buffer = buffers.get(setIndex);
      buffer.push(row);
      if (buffer.length >= options.pageSize) {
        flush(setIndex, true);
      }
    });

    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        query.once('error', (error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
        query.once('end', () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });
      });

      for (let setIndex = 0; setIndex < rowSetCount; setIndex += 1) {
        flush(setIndex, false);
      }
      await queue;

      let rowCount = 0;
      let truncated = false;
      for (let setIndex = 0; setIndex < rowSetCount; setIndex += 1) {
        const seen = seenRows.get(setIndex) || 0;
        const visibleRows = options.maxRows > 0 ? Math.min(seen, options.maxRows) : seen;
        const setTruncated = options.maxRows > 0 && seen > options.maxRows;
        rowCount += visibleRows;
        truncated ||= setTruncated;
        await options.sink.end(setIndex, {
          rowCount: visibleRows,
          truncated: setTruncated,
        });
      }

      return {
        command: 'MySQL',
        rowCount,
        rowsAffected,
        resultSetCount: rowSetCount,
        truncated,
      };
    } catch (error) {
      throw normalizeDatabaseError(error, 'mysql');
    } finally {
      this.activeExecutions.delete(options.executionId);
      if (!transactionConnection) {
        connection.release();
      }
    }
  }

  async cancel(executionId) {
    const threadId = Number(this.activeExecutions.get(executionId)?.threadId);
    if (!Number.isSafeInteger(threadId) || threadId <= 0 || !this.pool) {
      return false;
    }
    const controlConnection = mysql.createConnection(this._config());
    try {
      await callbackPromise((done) => controlConnection.connect(done));
      await this._query(controlConnection, `KILL QUERY ${threadId}`);
      return true;
    } catch (_error) {
      return false;
    } finally {
      await callbackPromise((done) => controlConnection.end(done)).catch(() => {
        controlConnection.destroy();
      });
    }
  }

  async listDatabases() {
    const [rows] = await this._query(
      this.pool,
      `SELECT schema_name AS name
         FROM information_schema.schemata
        WHERE schema_name NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
        ORDER BY schema_name`,
    );
    return rows;
  }

  async listSchemas(database) {
    return [{ name: database }];
  }

  async listTables(database) {
    const [rows] = await this._query(
      this.pool,
      `SELECT table_name AS name
         FROM information_schema.tables
        WHERE table_schema = ? AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
      [database],
    );
    return rows;
  }

  async listViews(database) {
    const [rows] = await this._query(
      this.pool,
      `SELECT table_name AS name
         FROM information_schema.views
        WHERE table_schema = ?
        ORDER BY table_name`,
      [database],
    );
    return rows;
  }

  async listColumns(database, _schema, objectName) {
    const [rows] = await this._query(
      this.pool,
      `SELECT column_name AS name,
              column_type AS type,
              is_nullable = 'YES' AS nullable,
              ordinal_position AS position
         FROM information_schema.columns
        WHERE table_schema = ? AND table_name = ?
        ORDER BY ordinal_position`,
      [database, objectName],
    );
    return rows;
  }

  async listProcedures(database) {
    const [rows] = await this._query(
      this.pool,
      `SELECT routine_name AS name, routine_type AS type
         FROM information_schema.routines
        WHERE routine_schema = ?
        ORDER BY routine_name`,
      [database],
    );
    return rows;
  }

  async listIndexes(database) {
    const [rows] = await this._query(
      this.pool,
      `SELECT DISTINCT index_name AS name, table_name AS tableName
         FROM information_schema.statistics
        WHERE table_schema = ?
        ORDER BY table_name, index_name`,
      [database],
    );
    return rows;
  }

  async listTriggers(database) {
    const [rows] = await this._query(
      this.pool,
      `SELECT trigger_name AS name, event_object_table AS tableName
         FROM information_schema.triggers
        WHERE trigger_schema = ?
        ORDER BY trigger_name`,
      [database],
    );
    return rows;
  }

  async listEvents(database) {
    const [rows] = await this._query(
      this.pool,
      `SELECT event_name AS name
         FROM information_schema.events
        WHERE event_schema = ?
        ORDER BY event_name`,
      [database],
    );
    return rows;
  }

  _createDefinitionFromRow(row) {
    if (!row) return null;
    const key = Object.keys(row).find((name) => /^Create\s/i.test(name));
    return key ? String(row[key]) : null;
  }

  async getObjectDefinition(database, _schema, objectName, objectType, metadata = {}) {
    const qualified = `${this.quoteIdentifier(database)}.${this.quoteIdentifier(objectName)}`;
    if (objectType === 'table') {
      const [rows] = await this._query(this.pool, `SHOW CREATE TABLE ${qualified}`);
      return this._createDefinitionFromRow(rows[0]);
    }
    if (objectType === 'view') {
      const [rows] = await this._query(this.pool, `SHOW CREATE VIEW ${qualified}`);
      return this._createDefinitionFromRow(rows[0]);
    }
    if (objectType === 'procedure') {
      const [routines] = await this._query(
        this.pool,
        `SELECT routine_type AS type FROM information_schema.routines
          WHERE routine_schema = ? AND routine_name = ? LIMIT 1`,
        [database, objectName],
      );
      const type = String(routines[0]?.type || metadata.type || 'PROCEDURE').toUpperCase();
      const keyword = type === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE';
      const [rows] = await this._query(this.pool, `SHOW CREATE ${keyword} ${qualified}`);
      return wrapMysqlDefinition(this._createDefinitionFromRow(rows[0]));
    }
    if (objectType === 'trigger') {
      const [rows] = await this._query(this.pool, `SHOW CREATE TRIGGER ${qualified}`);
      return wrapMysqlDefinition(this._createDefinitionFromRow(rows[0]));
    }
    if (objectType === 'event') {
      const [rows] = await this._query(this.pool, `SHOW CREATE EVENT ${qualified}`);
      return wrapMysqlDefinition(this._createDefinitionFromRow(rows[0]));
    }
    if (objectType === 'index' && metadata.tableName) {
      const table = `${this.quoteIdentifier(database)}.${this.quoteIdentifier(metadata.tableName)}`;
      const [rows] = await this._query(this.pool, `SHOW INDEX FROM ${table}`);
      const indexRows = rows
        .filter((row) => String(row.Key_name) === String(objectName))
        .sort((left, right) => Number(left.Seq_in_index) - Number(right.Seq_in_index));
      if (!indexRows.length) return null;
      const first = indexRows[0];
      const columns = indexRows.map((row) => {
        let value = row.Column_name
          ? this.quoteIdentifier(row.Column_name)
          : `(${row.Expression || '/* expression */'})`;
        if (row.Sub_part) value += `(${row.Sub_part})`;
        if (row.Collation === 'D') value += ' DESC';
        return value;
      });
      if (String(objectName).toUpperCase() === 'PRIMARY') {
        return `ALTER TABLE ${table} ADD PRIMARY KEY (${columns.join(', ')});`;
      }
      const kind = String(first.Index_type || '').toUpperCase();
      const prefix = ['FULLTEXT', 'SPATIAL'].includes(kind)
        ? ` ${kind}`
        : first.Non_unique === 0
          ? ' UNIQUE'
          : '';
      return `CREATE${prefix} INDEX ${this.quoteIdentifier(objectName)} ON ${table} (${columns.join(', ')});`;
    }
    return null;
  }

  quoteIdentifier(identifier) {
    return `\`${String(identifier).replaceAll('`', '``')}\``;
  }

  quoteTable(database, _schema, table) {
    return [database, table]
      .filter(Boolean)
      .map((part) => this.quoteIdentifier(part))
      .join('.');
  }
}

module.exports = {
  MySqlAdapter,
  wrapMysqlDefinition,
};
