'use strict';

const oracledb = require('oracledb');
const { BaseAdapter } = require('./baseAdapter');
const { normalizeDatabaseError } = require('../core/errors');
const { looksLikeRowQuery } = require('../sql/safety');

// NUMBER como string evita perder precisión al cruzar el límite seguro de
// enteros de JavaScript; ResultStore conserva después el valor textual exacto.
const stringFetchTypes = [
  oracledb.DB_TYPE_NUMBER,
  oracledb.DB_TYPE_CLOB,
  oracledb.DB_TYPE_NCLOB,
].filter(Boolean);
if (stringFetchTypes.length > 0) {
  oracledb.fetchAsString = stringFetchTypes;
}
if (oracledb.DB_TYPE_BLOB) {
  oracledb.fetchAsBuffer = [oracledb.DB_TYPE_BLOB];
}

class OracleAdapter extends BaseAdapter {
  constructor(profile, password) {
    super(profile, password);
    this.pool = null;
    this.sessionUser = '';
  }

  _connectString() {
    if (this.profile.connectString) {
      return this.profile.connectString;
    }
    const service = this.profile.serviceName || this.profile.database;
    return `${this.profile.host}:${this.profile.port || 1521}/${service}`;
  }

  _poolConfig() {
    const timeoutSeconds = Math.max(
      0,
      Math.ceil(Number(this.profile.connectTimeoutMs || 15000) / 1000),
    );
    return {
      user: this.profile.user,
      password: this.password,
      connectString: this._connectString(),
      connectTimeout: timeoutSeconds,
      poolMin: 0,
      poolMax: 5,
      poolIncrement: 1,
      poolTimeout: 60,
      queueTimeout: this.profile.connectTimeoutMs || 15000,
    };
  }

  _prepareConnection(connection) {
    connection.callTimeout = Math.max(0, Number(this.profile.queryTimeoutMs || 0));
    return connection;
  }

  async connect() {
    try {
      this.pool = await oracledb.createPool(this._poolConfig());
      const connection = this._prepareConnection(await this.pool.getConnection());
      try {
        this.serverVersion = connection.oracleServerVersionString || 'Oracle';
        const identity = await connection.execute(
          `SELECT SYS_CONTEXT('USERENV', 'SESSION_USER') AS "user" FROM dual`,
          [],
          { outFormat: oracledb.OUT_FORMAT_OBJECT },
        );
        this.sessionUser = String(identity.rows?.[0]?.user || this.profile.user || '');
      } finally {
        await connection.close();
      }
      this.connected = true;
      return this.serverVersion;
    } catch (error) {
      if (this.pool) {
        await this.pool.close(0).catch(() => {});
        this.pool = null;
      }
      throw normalizeDatabaseError(error, 'oracle');
    }
  }

  async disconnect() {
    await this.cancelAll();
    await this.rollbackAll();
    if (this.pool) {
      await this.pool.close(2);
      this.pool = null;
    }
    this.connected = false;
  }

  async _setCurrentSchema(connection, schema) {
    const target = schema || this.sessionUser;
    if (!target) return;
    await connection.execute(
      `ALTER SESSION SET CURRENT_SCHEMA = ${this.quoteIdentifier(target)}`,
    );
  }

  async begin(sessionId, context = {}) {
    if (this.transactions.has(sessionId)) {
      throw new Error('Esta sesión ya tiene una transacción Oracle activa.');
    }
    let connection;
    try {
      connection = this._prepareConnection(await this.pool.getConnection());
      await this._setCurrentSchema(connection, context.schema);
      this.transactions.set(sessionId, connection);
    } catch (error) {
      await connection?.close().catch(() => {});
      throw normalizeDatabaseError(error, 'oracle');
    }
  }

  async commit(sessionId) {
    const connection = this.transactions.get(sessionId);
    if (!connection) {
      throw new Error('No hay una transacción activa en esta sesión.');
    }
    try {
      await connection.commit();
    } finally {
      this.transactions.delete(sessionId);
      await connection.close();
    }
  }

  async rollback(sessionId) {
    const connection = this.transactions.get(sessionId);
    if (!connection) {
      return;
    }
    try {
      await connection.rollback();
    } finally {
      this.transactions.delete(sessionId);
      await connection.close();
    }
  }

  async _executeRows(connection, sql, options) {
    let resultSet;
    try {
      const result = await connection.execute(sql, [], {
        outFormat: oracledb.OUT_FORMAT_ARRAY,
        resultSet: true,
        fetchArraySize: options.pageSize,
        autoCommit: false,
      });
      resultSet = result.resultSet;
      const columns = (result.metaData || []).map((field, index) => ({
        name: field.name || `Column ${index + 1}`,
        type: field.dbTypeName || String(field.dbType || ''),
        nullable: field.nullable,
      }));
      await options.sink.start(0, columns);

      let rowCount = 0;
      let truncated = false;
      const hasLimit = Number(options.maxRows) > 0;
      while (!hasLimit || rowCount < options.maxRows) {
        const room = hasLimit ? options.maxRows - rowCount : options.pageSize;
        const requested = Math.max(1, Math.min(options.pageSize, room));
        const rows = await resultSet.getRows(requested);
        if (rows.length === 0) {
          break;
        }
        await options.sink.rows(0, rows);
        rowCount += rows.length;
        if (rows.length < requested) {
          break;
        }
      }

      if (hasLimit && rowCount >= options.maxRows) {
        truncated = (await resultSet.getRows(1)).length > 0;
      }
      await options.sink.end(0, { rowCount, truncated });
      return { rowCount, rowsAffected: 0, resultSetCount: 1, truncated };
    } finally {
      if (resultSet) {
        await resultSet.close().catch(() => {});
      }
    }
  }

  async _executeRegular(connection, sql, autoCommit) {
    const result = await connection.execute(sql, [], {
      outFormat: oracledb.OUT_FORMAT_ARRAY,
      autoCommit,
    });
    return {
      command: 'SQL/PLSQL',
      rowCount: 0,
      rowsAffected: Number(result.rowsAffected || 0),
      resultSetCount: 0,
      truncated: false,
    };
  }

  async execute(sessionId, sql, options) {
    const transactionConnection = this.transactions.get(sessionId);
    const connection =
      transactionConnection || this._prepareConnection(await this.pool.getConnection());

    try {
      if (!transactionConnection) {
        await this._setCurrentSchema(connection, options.schema);
      }
      this.activeExecutions.set(options.executionId, { connection });
      if (looksLikeRowQuery(sql, 'oracle')) {
        return await this._executeRows(connection, sql, options);
      }
      return await this._executeRegular(connection, sql, !transactionConnection);
    } catch (error) {
      throw normalizeDatabaseError(error, 'oracle');
    } finally {
      this.activeExecutions.delete(options.executionId);
      if (!transactionConnection) {
        await connection.close().catch(() => {});
      }
    }
  }

  async cancel(executionId) {
    const connection = this.activeExecutions.get(executionId)?.connection;
    if (!connection) {
      return false;
    }
    try {
      await connection.break();
      return true;
    } catch (_error) {
      return false;
    }
  }

  async _query(sql, binds = {}) {
    const connection = this._prepareConnection(await this.pool.getConnection());
    try {
      const result = await connection.execute(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      return result.rows || [];
    } finally {
      await connection.close();
    }
  }

  async listDatabases() {
    const rows = await this._query(
      `SELECT SYS_CONTEXT('USERENV', 'DB_NAME') AS "name" FROM dual`,
    );
    return rows.length ? rows : [{ name: this.profile.serviceName || this.profile.database }];
  }

  async listSchemas() {
    return this._query(
      `SELECT username AS "name" FROM all_users ORDER BY username`,
    );
  }

  async listTables(_database, schema) {
    return this._query(
      `SELECT table_name AS "name"
         FROM all_tables
        WHERE owner = :owner
        ORDER BY table_name`,
      { owner: schema },
    );
  }

  async listViews(_database, schema) {
    return this._query(
      `SELECT view_name AS "name"
         FROM all_views
        WHERE owner = :owner
        ORDER BY view_name`,
      { owner: schema },
    );
  }

  async listColumns(_database, schema, objectName) {
    return this._query(
      `SELECT column_name AS "name",
              data_type AS "type",
              CASE nullable WHEN 'Y' THEN 1 ELSE 0 END AS "nullable",
              column_id AS "position"
         FROM all_tab_columns
        WHERE owner = :owner AND table_name = :object_name
        ORDER BY column_id`,
      { owner: schema, object_name: objectName },
    );
  }

  async listProcedures(_database, schema) {
    return this._query(
      `SELECT object_name AS "name", object_type AS "type"
         FROM all_objects
        WHERE owner = :owner
          AND object_type IN ('PROCEDURE', 'FUNCTION')
        ORDER BY object_name`,
      { owner: schema },
    );
  }

  async listMaterializedViews(_database, schema) {
    return this._query(
      `SELECT mview_name AS "name"
         FROM all_mviews
        WHERE owner = :owner
        ORDER BY mview_name`,
      { owner: schema },
    );
  }

  async listIndexes(_database, schema) {
    return this._query(
      `SELECT index_name AS "name", table_name AS "tableName", uniqueness AS "type"
         FROM all_indexes
        WHERE owner = :owner
        ORDER BY table_name, index_name`,
      { owner: schema },
    );
  }

  async listTriggers(_database, schema) {
    return this._query(
      `SELECT trigger_name AS "name", table_name AS "tableName", status AS "type"
         FROM all_triggers
        WHERE owner = :owner
        ORDER BY trigger_name`,
      { owner: schema },
    );
  }

  async listSequences(_database, schema) {
    return this._query(
      `SELECT sequence_name AS "name"
         FROM all_sequences
        WHERE sequence_owner = :owner
        ORDER BY sequence_name`,
      { owner: schema },
    );
  }

  async listPackages(_database, schema) {
    return this._query(
      `SELECT object_name AS "name", status AS "type"
         FROM all_objects
        WHERE owner = :owner AND object_type = 'PACKAGE'
        ORDER BY object_name`,
      { owner: schema },
    );
  }

  async listTypes(_database, schema) {
    return this._query(
      `SELECT type_name AS "name", typecode AS "type"
         FROM all_types
        WHERE owner = :owner
        ORDER BY type_name`,
      { owner: schema },
    );
  }

  async listSynonyms(_database, schema) {
    return this._query(
      `SELECT synonym_name AS "name",
              table_owner || '.' || table_name AS "target"
         FROM all_synonyms
        WHERE owner = :owner
        ORDER BY synonym_name`,
      { owner: schema },
    );
  }

  async _sourceDefinition(schema, objectName, sourceTypes) {
    const rows = await this._query(
      `SELECT type AS "type", text AS "text", line AS "line"
         FROM all_source
        WHERE owner = :owner
          AND name = :object_name
          AND type IN (${sourceTypes.map((_type, index) => `:type${index}`).join(', ')})
        ORDER BY DECODE(type, 'PACKAGE', 1, 'PACKAGE BODY', 2, 'TYPE', 1, 'TYPE BODY', 2, 1), line`,
      Object.fromEntries([
        ['owner', schema],
        ['object_name', objectName],
        ...sourceTypes.map((type, index) => [`type${index}`, type]),
      ]),
    );
    if (!rows.length) return null;

    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.type)) groups.set(row.type, []);
      groups.get(row.type).push(row.text);
    }
    return [...groups.values()]
      .map((lines) => `CREATE OR REPLACE ${lines.join('').trim()}\n/`)
      .join('\n\n');
  }

  async getObjectDefinition(_database, schema, objectName, objectType) {
    if (objectType === 'procedure') {
      return this._sourceDefinition(schema, objectName, ['PROCEDURE', 'FUNCTION']);
    }
    if (objectType === 'package') {
      return this._sourceDefinition(schema, objectName, ['PACKAGE', 'PACKAGE BODY']);
    }
    if (objectType === 'trigger') {
      return this._sourceDefinition(schema, objectName, ['TRIGGER']);
    }
    if (objectType === 'type') {
      return this._sourceDefinition(schema, objectName, ['TYPE', 'TYPE BODY']);
    }

    const metadataTypes = {
      table: 'TABLE',
      view: 'VIEW',
      materializedView: 'MATERIALIZED_VIEW',
      index: 'INDEX',
      sequence: 'SEQUENCE',
      synonym: 'SYNONYM',
    };
    const metadataType = metadataTypes[objectType];
    if (!metadataType) return null;
    try {
      const rows = await this._query(
        `SELECT DBMS_METADATA.GET_DDL(:metadata_type, :object_name, :owner) AS "definition"
           FROM dual`,
        {
          metadata_type: metadataType,
          object_name: objectName,
          owner: schema,
        },
      );
      return rows[0]?.definition ? String(rows[0].definition) : null;
    } catch (_error) {
      if (objectType === 'view') {
        const rows = await this._query(
          `SELECT text AS "definition" FROM all_views
            WHERE owner = :owner AND view_name = :object_name`,
          { owner: schema, object_name: objectName },
        );
        const definition = rows[0]?.definition;
        return definition
          ? `CREATE OR REPLACE VIEW ${this.quoteTable(null, schema, objectName)} AS\n${definition}`
          : null;
      }
      return null;
    }
  }
}

module.exports = {
  OracleAdapter,
};
