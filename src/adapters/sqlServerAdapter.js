'use strict';

const sqlServer = require('mssql');
const { BaseAdapter } = require('./baseAdapter');
const { normalizeDatabaseError } = require('../core/errors');

function sqlServerTypeName(field) {
  return String(
    field?.type?.declaration || field?.type?.name || field?.type || '',
  );
}

function sqlServerColumnType(column, quoteIdentifier) {
  if (column.is_user_defined) {
    return [column.type_schema, column.type_name]
      .filter(Boolean)
      .map((part) => quoteIdentifier(part))
      .join('.');
  }
  const type = String(column.type_name || '').toLowerCase();
  if (['varchar', 'char', 'varbinary', 'binary'].includes(type)) {
    return `${type}(${Number(column.max_length) === -1 ? 'MAX' : column.max_length})`;
  }
  if (['nvarchar', 'nchar'].includes(type)) {
    const length = Number(column.max_length) === -1 ? 'MAX' : Number(column.max_length) / 2;
    return `${type}(${length})`;
  }
  if (['decimal', 'numeric'].includes(type)) {
    return `${type}(${column.precision},${column.scale})`;
  }
  if (['datetime2', 'datetimeoffset', 'time'].includes(type)) {
    return `${type}(${column.scale})`;
  }
  return type || 'sql_variant';
}

class SqlServerAdapter extends BaseAdapter {
  constructor(profile, password) {
    super(profile, password);
    this.pool = null;
    this.databasePools = new Map();
  }

  _config(database = this.profile.database || 'master') {
    const instanceName = String(this.profile.instanceName || '').trim();
    const config = {
      server: this.profile.host,
      user: this.profile.user,
      password: this.password,
      database,
      connectionTimeout: this.profile.connectTimeoutMs || 15000,
      requestTimeout: Math.max(0, Number(this.profile.queryTimeoutMs || 0)),
      pool: {
        max: 5,
        min: 0,
        idleTimeoutMillis: 30000,
      },
      options: {
        encrypt: this.profile.encrypt !== false,
        trustServerCertificate: Boolean(this.profile.trustServerCertificate),
        enableArithAbort: true,
      },
    };

    if (instanceName) {
      config.options.instanceName = instanceName;
    } else {
      config.port = this.profile.port || 1433;
    }
    return config;
  }

  async connect() {
    try {
      this.pool = new sqlServer.ConnectionPool(this._config());
      await this.pool.connect();
      const result = await this.pool
        .request()
        .query("SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version");
      this.serverVersion = result.recordset?.[0]?.version || 'SQL Server';
      this.connected = true;
      return this.serverVersion;
    } catch (error) {
      if (this.pool) {
        await this.pool.close().catch(() => {});
        this.pool = null;
      }
      throw normalizeDatabaseError(error, 'sqlserver');
    }
  }

  async disconnect() {
    await this.cancelAll();
    await this.rollbackAll();
    const extraPools = [...this.databasePools.values()];
    this.databasePools.clear();
    await Promise.allSettled(
      extraPools.map(async (poolPromise) => {
        const pool = await poolPromise;
        await pool.close();
      }),
    );
    if (this.pool) {
      await this.pool.close();
      this.pool = null;
    }
    this.connected = false;
  }

  async _poolFor(database) {
    const target = database || this.profile.database || 'master';
    const primary = this.profile.database || 'master';
    if (target === primary) return this.pool;
    if (this.databasePools.has(target)) {
      return this.databasePools.get(target);
    }
    const poolPromise = (async () => {
      const pool = new sqlServer.ConnectionPool(this._config(target));
      await pool.connect();
      return pool;
    })();
    this.databasePools.set(target, poolPromise);
    try {
      return await poolPromise;
    } catch (error) {
      this.databasePools.delete(target);
      throw error;
    }
  }

  async begin(sessionId, context = {}) {
    if (this.transactions.has(sessionId)) {
      throw new Error('Esta sesión ya tiene una transacción SQL Server activa.');
    }
    try {
      const pool = await this._poolFor(context.database);
      const transaction = new sqlServer.Transaction(pool);
      await transaction.begin();
      this.transactions.set(sessionId, transaction);
    } catch (error) {
      throw normalizeDatabaseError(error, 'sqlserver');
    }
  }

  async commit(sessionId) {
    const transaction = this.transactions.get(sessionId);
    if (!transaction) {
      throw new Error('No hay una transacción activa en esta sesión.');
    }
    try {
      await transaction.commit();
    } finally {
      this.transactions.delete(sessionId);
    }
  }

  async rollback(sessionId) {
    const transaction = this.transactions.get(sessionId);
    if (!transaction) {
      return;
    }
    try {
      await transaction.rollback();
    } catch (error) {
      if (error?.code !== 'EABORT') {
        throw error;
      }
    } finally {
      this.transactions.delete(sessionId);
    }
  }

  async execute(sessionId, sql, options) {
    const transaction = this.transactions.get(sessionId);
    const request = transaction
      ? new sqlServer.Request(transaction)
      : (await this._poolFor(options.database)).request();
    request.stream = true;
    request.arrayRowMode = true;

    let currentSet = -1;
    let currentBuffer = [];
    let queue = Promise.resolve();
    const counts = [];
    const startedSets = [];

    const queueFlush = (setIndex, rows, useBackpressure) => {
      if (!rows.length || setIndex < 0) {
        return;
      }
      if (useBackpressure) {
        request.pause();
      }
      queue = queue
        .then(() => options.sink.rows(setIndex, rows))
        .finally(() => {
          if (useBackpressure) {
            request.resume();
          }
        });
    };

    request.on('recordset', (fields) => {
      if (currentBuffer.length) {
        queueFlush(currentSet, currentBuffer, false);
        currentBuffer = [];
      }
      currentSet += 1;
      counts[currentSet] = 0;
      startedSets.push(currentSet);
      const setIndex = currentSet;
      const columns = (fields || []).map((field, index) => ({
        name: field.name || `Column ${index + 1}`,
        type: sqlServerTypeName(field),
        nullable: field.nullable,
      }));
      queue = queue.then(() => options.sink.start(setIndex, columns));
    });

    request.on('row', (row) => {
      if (currentSet < 0) {
        return;
      }
      counts[currentSet] += 1;
      if (options.maxRows <= 0 || counts[currentSet] <= options.maxRows) {
        currentBuffer.push(row);
        if (currentBuffer.length >= options.pageSize) {
          const rows = currentBuffer;
          currentBuffer = [];
          queueFlush(currentSet, rows, true);
        }
      }
    });

    // El evento error necesita listener incluso usando la promesa de query().
    request.on('error', () => {});
    this.activeExecutions.set(options.executionId, { request });

    try {
      const result = await request.query(sql);
      if (currentBuffer.length) {
        queueFlush(currentSet, currentBuffer, false);
        currentBuffer = [];
      }
      await queue;

      let rowCount = 0;
      let truncated = false;
      for (const setIndex of startedSets) {
        const visibleRows =
          options.maxRows > 0
            ? Math.min(counts[setIndex], options.maxRows)
            : counts[setIndex];
        const setTruncated =
          options.maxRows > 0 && counts[setIndex] > options.maxRows;
        rowCount += visibleRows;
        truncated ||= setTruncated;
        await options.sink.end(setIndex, {
          rowCount: visibleRows,
          truncated: setTruncated,
        });
      }

      return {
        command: 'T-SQL',
        rowCount,
        rowsAffected: (result.rowsAffected || []).reduce(
          (total, value) => total + Number(value || 0),
          0,
        ),
        resultSetCount: startedSets.length,
        truncated,
      };
    } catch (error) {
      throw normalizeDatabaseError(error, 'sqlserver');
    } finally {
      this.activeExecutions.delete(options.executionId);
    }
  }

  async cancel(executionId) {
    const request = this.activeExecutions.get(executionId)?.request;
    if (!request) {
      return false;
    }
    try {
      return request.cancel();
    } catch (_error) {
      return false;
    }
  }

  quoteIdentifier(identifier) {
    return `[${String(identifier).replaceAll(']', ']]')}]`;
  }

  quoteTable(database, schema, table) {
    return [database, schema, table]
      .filter(Boolean)
      .map((part) => this.quoteIdentifier(part))
      .join('.');
  }

  _catalog(database) {
    return this.quoteIdentifier(database || this.profile.database || 'master');
  }

  async listDatabases() {
    const result = await this.pool
      .request()
      .query("SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' AND HAS_DBACCESS(name) = 1 ORDER BY name");
    return result.recordset;
  }

  async listSchemas(database) {
    const result = await this.pool.request().query(
      `SELECT name FROM ${this._catalog(database)}.sys.schemas
        WHERE name NOT IN ('sys', 'INFORMATION_SCHEMA')
        ORDER BY name`,
    );
    return result.recordset;
  }

  async listTables(database, schema) {
    const request = this.pool.request();
    request.input('schema', sqlServer.NVarChar, schema);
    const result = await request.query(
      `SELECT t.name
         FROM ${this._catalog(database)}.sys.tables t
         JOIN ${this._catalog(database)}.sys.schemas s ON s.schema_id = t.schema_id
        WHERE s.name = @schema
        ORDER BY t.name`,
    );
    return result.recordset;
  }

  async listViews(database, schema) {
    const request = this.pool.request();
    request.input('schema', sqlServer.NVarChar, schema);
    const result = await request.query(
      `SELECT v.name
         FROM ${this._catalog(database)}.sys.views v
         JOIN ${this._catalog(database)}.sys.schemas s ON s.schema_id = v.schema_id
        WHERE s.name = @schema
        ORDER BY v.name`,
    );
    return result.recordset;
  }

  async listColumns(database, schema, objectName) {
    const request = this.pool.request();
    request.input('schema', sqlServer.NVarChar, schema);
    request.input('object', sqlServer.NVarChar, objectName);
    const result = await request.query(
      `SELECT c.name,
              ty.name AS type,
              c.is_nullable AS nullable,
              c.column_id AS position
         FROM ${this._catalog(database)}.sys.columns c
         JOIN ${this._catalog(database)}.sys.objects o ON o.object_id = c.object_id
         JOIN ${this._catalog(database)}.sys.schemas s ON s.schema_id = o.schema_id
         JOIN ${this._catalog(database)}.sys.types ty ON ty.user_type_id = c.user_type_id
        WHERE s.name = @schema AND o.name = @object
        ORDER BY c.column_id`,
    );
    return result.recordset;
  }

  async listProcedures(database, schema) {
    const request = this.pool.request();
    request.input('schema', sqlServer.NVarChar, schema);
    const result = await request.query(
      `SELECT o.name,
              CASE WHEN o.type IN ('P', 'PC') THEN 'PROCEDURE' ELSE 'FUNCTION' END AS type
         FROM ${this._catalog(database)}.sys.objects o
         JOIN ${this._catalog(database)}.sys.schemas s ON s.schema_id = o.schema_id
        WHERE s.name = @schema AND o.type IN ('P', 'PC', 'FN', 'IF', 'TF')
        ORDER BY o.name`,
    );
    return result.recordset;
  }

  async listIndexes(database, schema) {
    const request = this.pool.request();
    request.input('schema', sqlServer.NVarChar, schema);
    const result = await request.query(
      `SELECT i.name, o.name AS tableName,
              i.is_primary_key AS isPrimaryKey,
              i.is_unique_constraint AS isUniqueConstraint
         FROM ${this._catalog(database)}.sys.indexes i
         JOIN ${this._catalog(database)}.sys.objects o ON o.object_id = i.object_id
         JOIN ${this._catalog(database)}.sys.schemas s ON s.schema_id = o.schema_id
        WHERE s.name = @schema AND i.name IS NOT NULL AND i.is_hypothetical = 0
        ORDER BY o.name, i.name`,
    );
    return result.recordset;
  }

  async listTriggers(database, schema) {
    const request = this.pool.request();
    request.input('schema', sqlServer.NVarChar, schema);
    const result = await request.query(
      `SELECT tr.name, o.name AS tableName
         FROM ${this._catalog(database)}.sys.triggers tr
         JOIN ${this._catalog(database)}.sys.objects o ON o.object_id = tr.parent_id
         JOIN ${this._catalog(database)}.sys.schemas s ON s.schema_id = o.schema_id
        WHERE s.name = @schema AND tr.parent_class = 1
        ORDER BY tr.name`,
    );
    return result.recordset;
  }

  async listSequences(database, schema) {
    const request = this.pool.request();
    request.input('schema', sqlServer.NVarChar, schema);
    const result = await request.query(
      `SELECT seq.name
         FROM ${this._catalog(database)}.sys.sequences seq
         JOIN ${this._catalog(database)}.sys.schemas s ON s.schema_id = seq.schema_id
        WHERE s.name = @schema
        ORDER BY seq.name`,
    );
    return result.recordset;
  }

  async listTypes(database, schema) {
    const request = this.pool.request();
    request.input('schema', sqlServer.NVarChar, schema);
    const result = await request.query(
      `SELECT ty.name,
              CASE WHEN ty.is_table_type = 1 THEN 'TABLE TYPE' ELSE 'TYPE' END AS type
         FROM ${this._catalog(database)}.sys.types ty
         JOIN ${this._catalog(database)}.sys.schemas s ON s.schema_id = ty.schema_id
        WHERE s.name = @schema AND ty.is_user_defined = 1
        ORDER BY ty.name`,
    );
    return result.recordset;
  }

  async listSynonyms(database, schema) {
    const request = this.pool.request();
    request.input('schema', sqlServer.NVarChar, schema);
    const result = await request.query(
      `SELECT sy.name, sy.base_object_name AS target
         FROM ${this._catalog(database)}.sys.synonyms sy
         JOIN ${this._catalog(database)}.sys.schemas s ON s.schema_id = sy.schema_id
        WHERE s.name = @schema
        ORDER BY sy.name`,
    );
    return result.recordset;
  }

  async _moduleDefinition(database, schema, objectName, trigger = false) {
    const request = this.pool.request();
    request.input('schema', sqlServer.NVarChar, schema);
    request.input('object', sqlServer.NVarChar, objectName);
    const query = trigger
      ? `SELECT m.definition
           FROM ${this._catalog(database)}.sys.triggers tr
           JOIN ${this._catalog(database)}.sys.objects parent ON parent.object_id = tr.parent_id
           JOIN ${this._catalog(database)}.sys.schemas s ON s.schema_id = parent.schema_id
           JOIN ${this._catalog(database)}.sys.sql_modules m ON m.object_id = tr.object_id
          WHERE s.name = @schema AND tr.name = @object`
      : `SELECT m.definition
           FROM ${this._catalog(database)}.sys.objects o
           JOIN ${this._catalog(database)}.sys.schemas s ON s.schema_id = o.schema_id
           JOIN ${this._catalog(database)}.sys.sql_modules m ON m.object_id = o.object_id
          WHERE s.name = @schema AND o.name = @object`;
    const result = await request.query(query);
    return result.recordset?.[0]?.definition || null;
  }

  async _tableDefinition(database, schema, objectName) {
    const catalog = this._catalog(database);
    const request = this.pool.request();
    request.input('schema', sqlServer.NVarChar, schema);
    request.input('object', sqlServer.NVarChar, objectName);
    const columnsResult = await request.query(
      `SELECT c.name,
              ty.name AS type_name,
              tys.name AS type_schema,
              ty.is_user_defined,
              c.max_length,
              c.precision,
              c.scale,
              c.is_nullable,
              c.collation_name,
              c.is_identity,
              ic.seed_value,
              ic.increment_value,
              cc.definition AS computed_definition,
              cc.is_persisted,
              dc.name AS default_name,
              dc.definition AS default_definition
         FROM ${catalog}.sys.columns c
         JOIN ${catalog}.sys.objects o ON o.object_id = c.object_id
         JOIN ${catalog}.sys.schemas s ON s.schema_id = o.schema_id
         JOIN ${catalog}.sys.types ty ON ty.user_type_id = c.user_type_id
         LEFT JOIN ${catalog}.sys.schemas tys ON tys.schema_id = ty.schema_id
         LEFT JOIN ${catalog}.sys.identity_columns ic
                ON ic.object_id = c.object_id AND ic.column_id = c.column_id
         LEFT JOIN ${catalog}.sys.computed_columns cc
                ON cc.object_id = c.object_id AND cc.column_id = c.column_id
         LEFT JOIN ${catalog}.sys.default_constraints dc
                ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
        WHERE s.name = @schema AND o.name = @object AND o.type = 'U'
        ORDER BY c.column_id`,
    );
    if (!columnsResult.recordset?.length) return null;

    const lines = columnsResult.recordset.map((column) => {
      const name = this.quoteIdentifier(column.name);
      if (column.computed_definition) {
        return `${name} AS ${column.computed_definition}${column.is_persisted ? ' PERSISTED' : ''}`;
      }
      let value = `${name} ${sqlServerColumnType(column, (part) => this.quoteIdentifier(part))}`;
      if (column.collation_name) value += ` COLLATE ${column.collation_name}`;
      if (column.is_identity) {
        value += ` IDENTITY(${column.seed_value ?? 1},${column.increment_value ?? 1})`;
      }
      if (column.default_definition) {
        value += ` CONSTRAINT ${this.quoteIdentifier(column.default_name)} DEFAULT ${column.default_definition}`;
      }
      value += column.is_nullable ? ' NULL' : ' NOT NULL';
      return value;
    });

    const keysRequest = this.pool.request();
    keysRequest.input('schema', sqlServer.NVarChar, schema);
    keysRequest.input('object', sqlServer.NVarChar, objectName);
    const keys = await keysRequest.query(
      `SELECT kc.name, kc.type, c.name AS column_name, ic.key_ordinal, ic.is_descending_key
         FROM ${catalog}.sys.key_constraints kc
         JOIN ${catalog}.sys.tables t ON t.object_id = kc.parent_object_id
         JOIN ${catalog}.sys.schemas s ON s.schema_id = t.schema_id
         JOIN ${catalog}.sys.index_columns ic
              ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id
         JOIN ${catalog}.sys.columns c
              ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE s.name = @schema AND t.name = @object AND ic.key_ordinal > 0
        ORDER BY kc.name, ic.key_ordinal`,
    );
    const keyGroups = new Map();
    for (const key of keys.recordset || []) {
      if (!keyGroups.has(key.name)) keyGroups.set(key.name, []);
      keyGroups.get(key.name).push(key);
    }
    for (const [name, keyColumns] of keyGroups) {
      const keyword = keyColumns[0].type === 'PK' ? 'PRIMARY KEY' : 'UNIQUE';
      const columns = keyColumns
        .map((column) => `${this.quoteIdentifier(column.column_name)}${column.is_descending_key ? ' DESC' : ''}`)
        .join(', ');
      lines.push(`CONSTRAINT ${this.quoteIdentifier(name)} ${keyword} (${columns})`);
    }

    const checksRequest = this.pool.request();
    checksRequest.input('schema', sqlServer.NVarChar, schema);
    checksRequest.input('object', sqlServer.NVarChar, objectName);
    const checks = await checksRequest.query(
      `SELECT cc.name, cc.definition
         FROM ${catalog}.sys.check_constraints cc
         JOIN ${catalog}.sys.tables t ON t.object_id = cc.parent_object_id
         JOIN ${catalog}.sys.schemas s ON s.schema_id = t.schema_id
        WHERE s.name = @schema AND t.name = @object
        ORDER BY cc.name`,
    );
    for (const check of checks.recordset || []) {
      lines.push(`CONSTRAINT ${this.quoteIdentifier(check.name)} CHECK ${check.definition}`);
    }

    const foreignRequest = this.pool.request();
    foreignRequest.input('schema', sqlServer.NVarChar, schema);
    foreignRequest.input('object', sqlServer.NVarChar, objectName);
    const foreignKeys = await foreignRequest.query(
      `SELECT fk.name,
              pc.name AS parent_column,
              rs.name AS referenced_schema,
              rt.name AS referenced_table,
              rc.name AS referenced_column,
              fkc.constraint_column_id,
              fk.delete_referential_action_desc AS delete_action,
              fk.update_referential_action_desc AS update_action
         FROM ${catalog}.sys.foreign_keys fk
         JOIN ${catalog}.sys.foreign_key_columns fkc
              ON fkc.constraint_object_id = fk.object_id
         JOIN ${catalog}.sys.tables pt ON pt.object_id = fk.parent_object_id
         JOIN ${catalog}.sys.schemas ps ON ps.schema_id = pt.schema_id
         JOIN ${catalog}.sys.columns pc
              ON pc.object_id = pt.object_id AND pc.column_id = fkc.parent_column_id
         JOIN ${catalog}.sys.tables rt ON rt.object_id = fk.referenced_object_id
         JOIN ${catalog}.sys.schemas rs ON rs.schema_id = rt.schema_id
         JOIN ${catalog}.sys.columns rc
              ON rc.object_id = rt.object_id AND rc.column_id = fkc.referenced_column_id
        WHERE ps.name = @schema AND pt.name = @object
        ORDER BY fk.name, fkc.constraint_column_id`,
    );
    const foreignGroups = new Map();
    for (const foreignKey of foreignKeys.recordset || []) {
      if (!foreignGroups.has(foreignKey.name)) foreignGroups.set(foreignKey.name, []);
      foreignGroups.get(foreignKey.name).push(foreignKey);
    }
    for (const [name, keyColumns] of foreignGroups) {
      const first = keyColumns[0];
      const source = keyColumns.map((row) => this.quoteIdentifier(row.parent_column)).join(', ');
      const target = keyColumns.map((row) => this.quoteIdentifier(row.referenced_column)).join(', ');
      let definition = `CONSTRAINT ${this.quoteIdentifier(name)} FOREIGN KEY (${source}) REFERENCES ${this.quoteTable(null, first.referenced_schema, first.referenced_table)} (${target})`;
      if (first.delete_action && first.delete_action !== 'NO_ACTION') {
        definition += ` ON DELETE ${String(first.delete_action).replaceAll('_', ' ')}`;
      }
      if (first.update_action && first.update_action !== 'NO_ACTION') {
        definition += ` ON UPDATE ${String(first.update_action).replaceAll('_', ' ')}`;
      }
      lines.push(definition);
    }

    return `CREATE TABLE ${this.quoteTable(null, schema, objectName)} (\n  ${lines.join(',\n  ')}\n);`;
  }

  async _indexDefinition(database, schema, objectName) {
    const request = this.pool.request();
    request.input('schema', sqlServer.NVarChar, schema);
    request.input('object', sqlServer.NVarChar, objectName);
    const result = await request.query(
      `SELECT i.name, i.is_unique, i.is_primary_key, i.is_unique_constraint,
              i.type_desc, i.filter_definition,
              t.name AS table_name, c.name AS column_name,
              ic.key_ordinal, ic.is_descending_key, ic.is_included_column, ic.index_column_id
         FROM ${this._catalog(database)}.sys.indexes i
         JOIN ${this._catalog(database)}.sys.tables t ON t.object_id = i.object_id
         JOIN ${this._catalog(database)}.sys.schemas s ON s.schema_id = t.schema_id
         JOIN ${this._catalog(database)}.sys.index_columns ic
              ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         JOIN ${this._catalog(database)}.sys.columns c
              ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE s.name = @schema AND i.name = @object
        ORDER BY ic.is_included_column, ic.key_ordinal, ic.index_column_id`,
    );
    const rows = result.recordset || [];
    if (!rows.length) return null;
    const first = rows[0];
    const keys = rows
      .filter((row) => !row.is_included_column)
      .map((row) => `${this.quoteIdentifier(row.column_name)}${row.is_descending_key ? ' DESC' : ''}`)
      .join(', ');
    const includes = rows
      .filter((row) => row.is_included_column)
      .map((row) => this.quoteIdentifier(row.column_name));
    const table = this.quoteTable(null, schema, first.table_name);
    if (first.is_primary_key || first.is_unique_constraint) {
      const keyword = first.is_primary_key ? 'PRIMARY KEY' : 'UNIQUE';
      return `ALTER TABLE ${table} ADD CONSTRAINT ${this.quoteIdentifier(first.name)} ${keyword} (${keys});`;
    }
    const indexKind = String(first.type_desc || '')
      .replaceAll('_', ' ')
      .replace(/\s*INDEX$/i, '')
      .trim();
    let definition = `CREATE${first.is_unique ? ' UNIQUE' : ''}${indexKind ? ` ${indexKind}` : ''} INDEX ${this.quoteIdentifier(first.name)} ON ${table} (${keys})`;
    if (includes.length) definition += ` INCLUDE (${includes.join(', ')})`;
    if (first.filter_definition) definition += ` WHERE ${first.filter_definition}`;
    return `${definition};`;
  }

  async _typeDefinition(database, schema, objectName) {
    const request = this.pool.request();
    request.input('schema', sqlServer.NVarChar, schema);
    request.input('object', sqlServer.NVarChar, objectName);
    const result = await request.query(
      `SELECT ty.name, ty.is_table_type, ty.is_nullable,
              base.name AS type_name, ty.max_length, ty.precision, ty.scale
         FROM ${this._catalog(database)}.sys.types ty
         JOIN ${this._catalog(database)}.sys.schemas s ON s.schema_id = ty.schema_id
         LEFT JOIN ${this._catalog(database)}.sys.types base
                ON base.user_type_id = ty.system_type_id
               AND base.user_type_id = base.system_type_id
        WHERE s.name = @schema AND ty.name = @object AND ty.is_user_defined = 1`,
    );
    const type = result.recordset?.[0];
    if (!type) return null;
    const qualified = this.quoteTable(null, schema, objectName);
    if (!type.is_table_type) {
      const base = sqlServerColumnType(type, (part) => this.quoteIdentifier(part));
      return `CREATE TYPE ${qualified} FROM ${base}${type.is_nullable ? ' NULL' : ' NOT NULL'};`;
    }

    const columnsRequest = this.pool.request();
    columnsRequest.input('schema', sqlServer.NVarChar, schema);
    columnsRequest.input('object', sqlServer.NVarChar, objectName);
    const columns = await columnsRequest.query(
      `SELECT c.name, base.name AS type_name, bs.name AS type_schema,
              base.is_user_defined, c.max_length, c.precision, c.scale, c.is_nullable
         FROM ${this._catalog(database)}.sys.table_types tt
         JOIN ${this._catalog(database)}.sys.schemas s ON s.schema_id = tt.schema_id
         JOIN ${this._catalog(database)}.sys.columns c ON c.object_id = tt.type_table_object_id
         JOIN ${this._catalog(database)}.sys.types base ON base.user_type_id = c.user_type_id
         LEFT JOIN ${this._catalog(database)}.sys.schemas bs ON bs.schema_id = base.schema_id
        WHERE s.name = @schema AND tt.name = @object
        ORDER BY c.column_id`,
    );
    const lines = (columns.recordset || []).map(
      (column) => `${this.quoteIdentifier(column.name)} ${sqlServerColumnType(column, (part) => this.quoteIdentifier(part))}${column.is_nullable ? ' NULL' : ' NOT NULL'}`,
    );
    return `CREATE TYPE ${qualified} AS TABLE (\n  ${lines.join(',\n  ')}\n);`;
  }

  async getObjectDefinition(database, schema, objectName, objectType) {
    if (objectType === 'table') {
      return this._tableDefinition(database, schema, objectName);
    }
    if (['view', 'procedure'].includes(objectType)) {
      return this._moduleDefinition(database, schema, objectName, false);
    }
    if (objectType === 'trigger') {
      return this._moduleDefinition(database, schema, objectName, true);
    }
    if (objectType === 'index') {
      return this._indexDefinition(database, schema, objectName);
    }
    if (objectType === 'type') {
      return this._typeDefinition(database, schema, objectName);
    }
    if (objectType === 'sequence') {
      const request = this.pool.request();
      request.input('schema', sqlServer.NVarChar, schema);
      request.input('object', sqlServer.NVarChar, objectName);
      const result = await request.query(
        `SELECT seq.start_value, seq.increment, seq.minimum_value, seq.maximum_value, seq.is_cycling
           FROM ${this._catalog(database)}.sys.sequences seq
           JOIN ${this._catalog(database)}.sys.schemas s ON s.schema_id = seq.schema_id
          WHERE s.name = @schema AND seq.name = @object`,
      );
      const sequence = result.recordset?.[0];
      if (!sequence) return null;
      return `CREATE SEQUENCE ${this.quoteTable(null, schema, objectName)}\n  START WITH ${sequence.start_value}\n  INCREMENT BY ${sequence.increment}\n  MINVALUE ${sequence.minimum_value}\n  MAXVALUE ${sequence.maximum_value}${sequence.is_cycling ? '\n  CYCLE' : '\n  NO CYCLE'};`;
    }
    if (objectType === 'synonym') {
      const request = this.pool.request();
      request.input('schema', sqlServer.NVarChar, schema);
      request.input('object', sqlServer.NVarChar, objectName);
      const result = await request.query(
        `SELECT sy.base_object_name
           FROM ${this._catalog(database)}.sys.synonyms sy
           JOIN ${this._catalog(database)}.sys.schemas s ON s.schema_id = sy.schema_id
          WHERE s.name = @schema AND sy.name = @object`,
      );
      const target = result.recordset?.[0]?.base_object_name;
      return target
        ? `CREATE SYNONYM ${this.quoteTable(null, schema, objectName)} FOR ${target};`
        : null;
    }
    return null;
  }
}

module.exports = {
  SqlServerAdapter,
};
