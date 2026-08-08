'use strict';

const { Client, Pool } = require('pg');
const Cursor = require('pg-cursor');
const { BaseAdapter, emitRowsInChunks } = require('./baseAdapter');
const { normalizeDatabaseError } = require('../core/errors');
const { looksLikeRowQuery } = require('../sql/safety');

function readCursor(cursor, rowCount) {
  return new Promise((resolve, reject) => {
    cursor.read(rowCount, (error, rows, result) => {
      if (error) reject(error);
      else resolve({ rows, result });
    });
  });
}

class PostgreSqlAdapter extends BaseAdapter {
  constructor(profile, password) {
    super(profile, password);
    this.pool = null;
  }

  _connectionConfig(database = this.profile.database || 'postgres') {
    const timeout = Math.max(0, Number(this.profile.queryTimeoutMs || 0));
    return {
      host: this.profile.host,
      port: this.profile.port || 5432,
      user: this.profile.user,
      password: this.password,
      database,
      connectionTimeoutMillis: this.profile.connectTimeoutMs || 15000,
      application_name: 'simple-db-vscode',
      statement_timeout: timeout || undefined,
      query_timeout: timeout || undefined,
      ssl: this.profile.ssl
        ? { rejectUnauthorized: !this.profile.trustServerCertificate }
        : false,
    };
  }

  async connect() {
    try {
      this.pool = new Pool({
        ...this._connectionConfig(),
        max: 5,
        idleTimeoutMillis: 30000,
      });
      const result = await this.pool.query('SHOW server_version');
      this.serverVersion = result.rows[0]?.server_version || 'PostgreSQL';
      this.connected = true;
      return this.serverVersion;
    } catch (error) {
      if (this.pool) {
        await this.pool.end().catch(() => {});
        this.pool = null;
      }
      throw normalizeDatabaseError(error, 'postgresql');
    }
  }

  async disconnect() {
    await this.cancelAll();
    await this.rollbackAll();
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    this.connected = false;
  }

  async _acquireClient(database) {
    const target = database || this.profile.database || 'postgres';
    const primary = this.profile.database || 'postgres';
    if (target === primary) {
      const client = await this.pool.connect();
      return { client, database: target, release: () => client.release() };
    }
    const client = new Client(this._connectionConfig(target));
    await client.connect();
    return { client, database: target, release: () => client.end() };
  }

  async _setSearchPath(client, schema, local = false) {
    if (!schema) return;
    await client.query(
      `${local ? 'SET LOCAL' : 'SET'} search_path TO ${this.quoteIdentifier(schema)}`,
    );
  }

  async begin(sessionId, context = {}) {
    if (this.transactions.has(sessionId)) {
      throw new Error('This session already has an active PostgreSQL transaction.');
    }
    const acquired = await this._acquireClient(context.database);
    try {
      await acquired.client.query(context.beginSql || 'BEGIN');
      await this._setSearchPath(acquired.client, context.schema, true);
      this.transactions.set(sessionId, acquired);
    } catch (error) {
      await acquired.client.query('ROLLBACK').catch(() => {});
      await acquired.release();
      throw normalizeDatabaseError(error, 'postgresql');
    }
  }

  async commit(sessionId) {
    const transaction = this.transactions.get(sessionId);
    if (!transaction) {
      throw new Error('There is no active transaction in this session.');
    }
    try {
      await transaction.client.query('COMMIT');
    } finally {
      this.transactions.delete(sessionId);
      await transaction.release();
    }
  }

  async rollback(sessionId) {
    const transaction = this.transactions.get(sessionId);
    if (!transaction) {
      return;
    }
    try {
      await transaction.client.query('ROLLBACK');
    } finally {
      this.transactions.delete(sessionId);
      await transaction.release();
    }
  }

  async _executeCursor(client, sql, options) {
    const cursor = client.query(new Cursor(sql, [], { rowMode: 'array' }));
    const setIndex = 0;
    let started = false;
    let rowCount = 0;
    let truncated = false;
    const hasLimit = Number(options.maxRows) > 0;

    try {
      while (true) {
        const room = hasLimit
          ? Math.max(0, options.maxRows - rowCount)
          : options.pageSize;
        const requested = hasLimit
          ? Math.max(1, Math.min(options.pageSize, room + 1))
          : options.pageSize;
        const read = await readCursor(cursor, requested);
        const rows = read.rows;
        const fields = read.result?.fields || [];

        if (!started) {
          await options.sink.start(
            setIndex,
            fields.map((field, index) => ({
              name: field.name || `Column ${index + 1}`,
              type: String(field.dataTypeID || ''),
            })),
          );
          started = true;
        }

        if (rows.length === 0) {
          break;
        }

        const accepted = hasLimit ? rows.slice(0, room) : rows;
        if (accepted.length > 0) {
          await options.sink.rows(setIndex, accepted);
          rowCount += accepted.length;
        }
        if (hasLimit && rows.length > accepted.length) {
          truncated = true;
          break;
        }
        if (hasLimit && rowCount >= options.maxRows) {
          const extra = await readCursor(cursor, 1);
          truncated = extra.rows.length > 0;
          break;
        }
      }
    } finally {
      await cursor.close().catch(() => {});
    }

    await options.sink.end(setIndex, { rowCount, truncated });
    return { rowCount, rowsAffected: 0, resultSetCount: 1, truncated };
  }

  async _executeRegular(client, sql, options) {
    const result = await client.query({ text: sql, rowMode: 'array' });
    let resultSetCount = 0;
    let rowCount = 0;
    let truncated = false;

    if (result.fields?.length) {
      resultSetCount = 1;
      const columns = result.fields.map((field, index) => ({
        name: field.name || `Column ${index + 1}`,
        type: String(field.dataTypeID || ''),
      }));
      await options.sink.start(0, columns);
      const emitted = await emitRowsInChunks(
        options.sink,
        0,
        result.rows || [],
        options.pageSize,
        options.maxRows,
      );
      rowCount = emitted.rowCount;
      truncated = emitted.truncated;
      await options.sink.end(0, { rowCount, truncated });
    }

    return {
      command: result.command || 'SQL',
      rowCount,
      rowsAffected: Number(result.rowCount || 0),
      resultSetCount,
      truncated,
    };
  }

  async execute(sessionId, sql, options) {
    const transaction = this.transactions.get(sessionId);
    const acquired = transaction || (await this._acquireClient(options.database));
    const client = acquired.client;
    this.activeExecutions.set(options.executionId, {
      client,
      processId: client.processID,
    });

    try {
      if (!transaction) {
        await this._setSearchPath(client, options.schema, false);
      }
      if (looksLikeRowQuery(sql, 'postgresql')) {
        return await this._executeCursor(client, sql, options);
      }
      return await this._executeRegular(client, sql, options);
    } catch (error) {
      throw normalizeDatabaseError(error, 'postgresql');
    } finally {
      this.activeExecutions.delete(options.executionId);
      if (!transaction) {
        if (options.schema && acquired.database === (this.profile.database || 'postgres')) {
          await client.query('RESET search_path').catch(() => {});
        }
        await acquired.release();
      }
    }
  }

  async cancel(executionId) {
    const active = this.activeExecutions.get(executionId);
    if (!active?.processId || !this.pool) {
      return false;
    }
    const cancelClient = new Client(this._connectionConfig());
    try {
      await cancelClient.connect();
      const result = await cancelClient.query('SELECT pg_cancel_backend($1) AS cancelled', [
        active.processId,
      ]);
      return result.rows[0]?.cancelled === true;
    } catch (_error) {
      return false;
    } finally {
      await cancelClient.end().catch(() => {});
    }
  }

  async _metadataQuery(database, text, values = []) {
    const target = database || this.profile.database || 'postgres';
    if (target === (this.profile.database || 'postgres')) {
      return this.pool.query(text, values);
    }

    const client = new Client(this._connectionConfig(target));
    await client.connect();
    try {
      return await client.query(text, values);
    } finally {
      await client.end();
    }
  }

  async listDatabases() {
    const result = await this.pool.query(
      `SELECT datname AS name
         FROM pg_database
        WHERE datallowconn AND NOT datistemplate
          AND has_database_privilege(datname, 'CONNECT')
        ORDER BY datname`,
    );
    return result.rows;
  }

  async listSchemas(database) {
    const result = await this._metadataQuery(
      database,
      `SELECT schema_name AS name
         FROM information_schema.schemata
        WHERE schema_name <> 'information_schema'
          AND schema_name NOT LIKE 'pg_%'
        ORDER BY schema_name`,
    );
    return result.rows;
  }

  async listTables(database, schema) {
    const result = await this._metadataQuery(
      database,
      `SELECT table_name AS name
         FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
      [schema],
    );
    return result.rows;
  }

  async listViews(database, schema) {
    const result = await this._metadataQuery(
      database,
      `SELECT table_name AS name
         FROM information_schema.views
        WHERE table_schema = $1
        ORDER BY table_name`,
      [schema],
    );
    return result.rows;
  }

  async listColumns(database, schema, objectName) {
    const result = await this._metadataQuery(
      database,
      `SELECT a.attname AS name,
              pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
              NOT a.attnotnull AS nullable,
              a.attnum AS position
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [schema, objectName],
    );
    return result.rows;
  }

  async listProcedures(database, schema) {
    const result = await this._metadataQuery(
      database,
      `SELECT p.proname AS name,
              CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS type,
              pg_get_function_identity_arguments(p.oid) AS signature,
              p.pronargs AS "argumentCount",
              p.pronargdefaults AS "defaultArgumentCount"
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
        ORDER BY p.proname`,
      [schema],
    );
    return result.rows;
  }

  async listMaterializedViews(database, schema) {
    const result = await this._metadataQuery(
      database,
      `SELECT matviewname AS name
         FROM pg_matviews
        WHERE schemaname = $1
        ORDER BY matviewname`,
      [schema],
    );
    return result.rows;
  }

  async listIndexes(database, schema) {
    const result = await this._metadataQuery(
      database,
      `SELECT idx.relname AS name,
              tbl.relname AS "tableName",
              con.conname AS "constraintName",
              con.contype AS "constraintType"
         FROM pg_class idx
         JOIN pg_namespace ns ON ns.oid = idx.relnamespace
         JOIN pg_index ix ON ix.indexrelid = idx.oid
         JOIN pg_class tbl ON tbl.oid = ix.indrelid
         LEFT JOIN pg_constraint con ON con.conindid = idx.oid
        WHERE ns.nspname = $1 AND idx.relkind IN ('i', 'I')
        ORDER BY tbl.relname, idx.relname`,
      [schema],
    );
    return result.rows;
  }

  async listTriggers(database, schema) {
    const result = await this._metadataQuery(
      database,
      `SELECT DISTINCT trigger_name AS name, event_object_table AS "tableName"
         FROM information_schema.triggers
        WHERE trigger_schema = $1
        ORDER BY trigger_name`,
      [schema],
    );
    return result.rows;
  }

  async listSequences(database, schema) {
    const result = await this._metadataQuery(
      database,
      `SELECT sequence_name AS name
         FROM information_schema.sequences
        WHERE sequence_schema = $1
        ORDER BY sequence_name`,
      [schema],
    );
    return result.rows;
  }

  async listTypes(database, schema) {
    const result = await this._metadataQuery(
      database,
      `SELECT t.typname AS name,
              CASE t.typtype WHEN 'e' THEN 'ENUM' WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END AS type
         FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = $1
          AND (
            t.typtype IN ('e', 'd')
            OR (t.typtype = 'c' AND EXISTS (
              SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c'
            ))
          )
        ORDER BY t.typname`,
      [schema],
    );
    return result.rows;
  }

  async _tableDefinition(database, schema, objectName) {
    const columns = await this._metadataQuery(
      database,
      `SELECT a.attname AS name,
              pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
              pg_get_expr(ad.adbin, ad.adrelid) AS default_value,
              a.attnotnull,
              a.attidentity,
              a.attgenerated
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
        WHERE n.nspname = $1 AND c.relname = $2
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [schema, objectName],
    );
    if (!columns.rows.length) {
      return null;
    }
    const constraints = await this._metadataQuery(
      database,
      `SELECT con.conname AS name, pg_get_constraintdef(con.oid, true) AS definition
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2
        ORDER BY con.conname`,
      [schema, objectName],
    );

    const lines = columns.rows.map((column) => {
      let definition = `${this.quoteIdentifier(column.name)} ${column.type}`;
      if (column.attidentity === 'a') {
        definition += ' GENERATED ALWAYS AS IDENTITY';
      } else if (column.attidentity === 'd') {
        definition += ' GENERATED BY DEFAULT AS IDENTITY';
      } else if (column.attgenerated === 's' && column.default_value) {
        definition += ` GENERATED ALWAYS AS (${column.default_value}) STORED`;
      } else if (column.default_value) {
        definition += ` DEFAULT ${column.default_value}`;
      }
      if (column.attnotnull) {
        definition += ' NOT NULL';
      }
      return definition;
    });
    for (const constraint of constraints.rows) {
      lines.push(
        `CONSTRAINT ${this.quoteIdentifier(constraint.name)} ${constraint.definition}`,
      );
    }
    const qualified = this.quoteTable(database, schema, objectName);
    return `CREATE TABLE ${qualified} (\n  ${lines.join(',\n  ')}\n);`;
  }

  async _typeDefinition(database, schema, objectName) {
    const info = await this._metadataQuery(
      database,
      `SELECT t.oid, t.typtype,
              pg_catalog.format_type(t.typbasetype, t.typtypmod) AS base_type,
              t.typnotnull, t.typdefault
         FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = $1 AND t.typname = $2
        LIMIT 1`,
      [schema, objectName],
    );
    const type = info.rows[0];
    if (!type) return null;
    const qualified = this.quoteTable(database, schema, objectName);

    if (type.typtype === 'e') {
      const labels = await this._metadataQuery(
        database,
        `SELECT e.enumlabel
           FROM pg_enum e
          WHERE e.enumtypid = $1
          ORDER BY e.enumsortorder`,
        [type.oid],
      );
      const values = labels.rows
        .map((row) => `'${String(row.enumlabel).replaceAll("'", "''")}'`)
        .join(', ');
      return `CREATE TYPE ${qualified} AS ENUM (${values});`;
    }

    if (type.typtype === 'd') {
      const constraints = await this._metadataQuery(
        database,
        `SELECT pg_get_constraintdef(c.oid, true) AS definition
           FROM pg_constraint c
          WHERE c.contypid = $1
          ORDER BY c.conname`,
        [type.oid],
      );
      const lines = [`CREATE DOMAIN ${qualified} AS ${type.base_type}`];
      if (type.typdefault !== null && type.typdefault !== undefined) {
        lines.push(`DEFAULT ${type.typdefault}`);
      }
      if (type.typnotnull) lines.push('NOT NULL');
      lines.push(...constraints.rows.map((row) => row.definition).filter(Boolean));
      return `${lines.join('\n  ')};`;
    }

    if (type.typtype === 'c') {
      const attributes = await this._metadataQuery(
        database,
        `SELECT a.attname,
                pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type
           FROM pg_attribute a
           JOIN pg_type t ON t.typrelid = a.attrelid
          WHERE t.oid = $1 AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`,
        [type.oid],
      );
      const definitions = attributes.rows.map(
        (attribute) => `${this.quoteIdentifier(attribute.attname)} ${attribute.data_type}`,
      );
      return `CREATE TYPE ${qualified} AS (\n  ${definitions.join(',\n  ')}\n);`;
    }
    return null;
  }

  async getObjectDefinition(database, schema, objectName, objectType, metadata = {}) {
    if (objectType === 'table') {
      return this._tableDefinition(database, schema, objectName);
    }

    if (objectType === 'view' || objectType === 'materializedView') {
      const result = await this._metadataQuery(
        database,
        `SELECT pg_get_viewdef(c.oid, true) AS definition, c.relispopulated
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2
          LIMIT 1`,
        [schema, objectName],
      );
      const definition = result.rows[0]?.definition;
      if (!definition) return null;
      const keyword =
        objectType === 'materializedView'
          ? 'CREATE MATERIALIZED VIEW'
          : 'CREATE OR REPLACE VIEW';
      const noData =
        objectType === 'materializedView' && result.rows[0]?.relispopulated === false
          ? '\nWITH NO DATA'
          : '';
      return `${keyword} ${this.quoteTable(database, schema, objectName)} AS\n${definition}${noData};`;
    }

    if (objectType === 'procedure') {
      const hasSignature = metadata.signature !== undefined && metadata.signature !== null;
      const result = await this._metadataQuery(
        database,
        `SELECT pg_get_functiondef(p.oid) AS definition
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $1 AND p.proname = $2
            ${hasSignature ? 'AND pg_get_function_identity_arguments(p.oid) = $3' : ''}
          ORDER BY p.oid`,
        hasSignature ? [schema, objectName, metadata.signature] : [schema, objectName],
      );
      return result.rows.map((row) => row.definition).filter(Boolean).join('\n\n');
    }

    if (objectType === 'index') {
      const result = await this._metadataQuery(
        database,
        `SELECT indexdef AS definition FROM pg_indexes
          WHERE schemaname = $1 AND indexname = $2 LIMIT 1`,
        [schema, objectName],
      );
      return result.rows[0]?.definition || null;
    }

    if (objectType === 'trigger') {
      const result = await this._metadataQuery(
        database,
        `SELECT pg_get_triggerdef(t.oid, true) AS definition
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND t.tgname = $2 AND NOT t.tgisinternal
          LIMIT 1`,
        [schema, objectName],
      );
      return result.rows[0]?.definition || null;
    }

    if (objectType === 'sequence') {
      const result = await this._metadataQuery(
        database,
        `SELECT start_value, minimum_value, maximum_value, increment, cycle_option
           FROM information_schema.sequences
          WHERE sequence_schema = $1 AND sequence_name = $2
          LIMIT 1`,
        [schema, objectName],
      );
      const sequence = result.rows[0];
      if (!sequence) return null;
      return `CREATE SEQUENCE ${this.quoteTable(database, schema, objectName)}\n  START WITH ${sequence.start_value}\n  INCREMENT BY ${sequence.increment}\n  MINVALUE ${sequence.minimum_value}\n  MAXVALUE ${sequence.maximum_value}${sequence.cycle_option === 'YES' ? '\n  CYCLE' : '\n  NO CYCLE'};`;
    }

    if (objectType === 'type') {
      return this._typeDefinition(database, schema, objectName);
    }

    return null;
  }
}

module.exports = {
  PostgreSqlAdapter,
};
