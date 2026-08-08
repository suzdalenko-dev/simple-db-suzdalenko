'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SqliteAdapter } = require('../adapters/sqliteAdapter');
const { extractSqlReference, resolveSqlTargets } = require('../services/sqlNavigation');

function collectingSink() {
  const sets = [];
  return {
    sets,
    start: async (index, columns) => {
      sets[index] = { columns, rows: [], metadata: null };
    },
    rows: async (index, rows) => sets[index].rows.push(...rows),
    end: async (index, metadata) => {
      sets[index].metadata = metadata;
    },
  };
}

describe('SqliteAdapter integration', () => {
  let temporary;
  let adapter;

  beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'simple-db-sqlite-'));
    adapter = new SqliteAdapter(
      {
        id: 'sqlite-test',
        engine: 'sqlite',
        filePath: path.join(temporary, 'database.sqlite'),
        readOnly: false,
        queryTimeoutMs: 0,
      },
      '',
    );
    await adapter.connect();
  });

  afterEach(async () => {
    await adapter?.disconnect().catch(() => {});
    await fs.rm(temporary, { recursive: true, force: true });
  });

  async function execute(sql, maxRows = 0) {
    const sink = collectingSink();
    const result = await adapter.execute('session', sql, {
      executionId: `execution-${Date.now()}-${Math.random()}`,
      maxRows,
      pageSize: 2,
      sink,
    });
    return { result, sink };
  }

  it('creates, modifies, and queries data with no default row limit', async () => {
    await execute('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);');
    await execute("INSERT INTO items(name) VALUES ('a'), ('b'), ('c'), ('d'), ('e');");
    const { result, sink } = await execute('SELECT id, name FROM items ORDER BY id;');

    expect(result.rowCount).toBe(5);
    expect(result.truncated).toBe(false);
    expect(sink.sets[0].rows).toHaveLength(5);
    expect(sink.sets[0].rows[4][1]).toBe('e');
  });

  it('limits rows only when maxRows is greater than zero', async () => {
    await execute('CREATE TABLE numbers (value INTEGER);');
    await execute('INSERT INTO numbers VALUES (1),(2),(3),(4);');
    const { result, sink } = await execute('SELECT value FROM numbers ORDER BY value;', 2);
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(true);
    expect(sink.sets[0].rows).toEqual([[1], [2]]);
  });

  it('keeps 64-bit SQLite integers as BigInt until normalization', async () => {
    await execute('CREATE TABLE big_numbers (value INTEGER);');
    await execute('INSERT INTO big_numbers VALUES (9223372036854775807);');
    const { sink } = await execute('SELECT value FROM big_numbers;');
    expect(sink.sets[0].rows[0][0]).toBe(9223372036854775807n);
  });

  it('ROLLBACKs and COMMITs explicit transactions', async () => {
    await execute('CREATE TABLE tx (value TEXT);');
    await adapter.begin('session');
    await execute("INSERT INTO tx VALUES ('rollback');");
    await adapter.rollback('session');
    expect((await execute('SELECT COUNT(*) AS total FROM tx;')).sink.sets[0].rows[0][0]).toBe(0);

    await adapter.begin('session');
    await execute("INSERT INTO tx VALUES ('commit');");
    await adapter.commit('session');
    expect((await execute('SELECT COUNT(*) AS total FROM tx;')).sink.sets[0].rows[0][0]).toBe(1);
  });

  it('synchronizes SQL BEGIN/ROLLBACK and isolates other editors', async () => {
    await execute('CREATE TABLE raw_tx (value TEXT);');
    await execute('BEGIN;');
    expect(adapter.hasTransaction('session')).toBe(true);
    const otherSink = collectingSink();
    await expect(
      adapter.execute('other-session', 'SELECT 1;', {
        executionId: 'other-execution',
        maxRows: 0,
        pageSize: 2,
        sink: otherSink,
      }),
    ).rejects.toThrow(/another editor/i);
    await execute("INSERT INTO raw_tx VALUES ('do not save');");
    await execute('ROLLBACK;');
    expect(adapter.hasTransaction('session')).toBe(false);
    expect((await execute('SELECT COUNT(*) FROM raw_tx;')).sink.sets[0].rows[0][0]).toBe(0);
  });

  it('keeps foreign_keys enabled after persisting the file', async () => {
    await execute('CREATE TABLE parent (id INTEGER PRIMARY KEY);');
    await execute('CREATE TABLE child (parent_id INTEGER REFERENCES parent(id));');
    await expect(execute('INSERT INTO child(parent_id) VALUES (999);')).rejects.toThrow(
      /FOREIGN KEY/i,
    );
  });

  it('refuses to overwrite a file modified externally', async () => {
    await execute('CREATE TABLE conflict (id INTEGER);');
    const filename = path.join(temporary, 'database.sqlite');
    const stat = await fs.stat(filename);
    const changed = new Date(stat.mtimeMs + 5000);
    await fs.utimes(filename, changed, changed);
    await expect(execute('INSERT INTO conflict VALUES (1);')).rejects.toThrow(
      /modified by another application/i,
    );
  });

  it('requires reconnecting before reads when the file changed externally', async () => {
    await execute('CREATE TABLE stale_guard (id INTEGER);');
    const filename = path.join(temporary, 'database.sqlite');
    const stat = await fs.stat(filename);
    const changed = new Date(stat.mtimeMs + 5000);
    await fs.utimes(filename, changed, changed);
    await expect(execute('SELECT * FROM stale_guard;')).rejects.toThrow(
      /modified by another application/i,
    );
  });

  it('rejects an active WAL to avoid loading an incomplete snapshot', async () => {
    await execute('CREATE TABLE wal_guard (id INTEGER);');
    const filename = path.join(temporary, 'database.sqlite');
    await adapter.disconnect();
    await fs.writeFile(`${filename}-wal`, Buffer.alloc(64, 1));

    adapter = new SqliteAdapter(
      {
        id: 'sqlite-test-wal',
        engine: 'sqlite',
        filePath: filename,
        readOnly: false,
        queryTimeoutMs: 0,
      },
      '',
    );
    await expect(adapter.connect()).rejects.toThrow(/active WAL/i);
  });

  it('explores tables, columns, indexes, triggers, and their definitions', async () => {
    await execute('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);');
    await execute('CREATE INDEX idx_items_name ON items(name);');
    await execute(`CREATE TRIGGER trg_items AFTER INSERT ON items
BEGIN
  UPDATE items SET name = name WHERE id = NEW.id;
END;`);

    expect((await adapter.listTables('main', 'main')).map((row) => row.name)).toContain('items');
    expect((await adapter.listColumns('main', 'main', 'items')).map((row) => row.name)).toEqual(['id', 'name']);
    expect((await adapter.listIndexes('main', 'main')).map((row) => row.name)).toContain('idx_items_name');
    expect((await adapter.listTriggers('main', 'main')).map((row) => row.name)).toContain('trg_items');
    expect(await adapter.getObjectDefinition('main', 'main', 'items', 'table')).toMatch(/^CREATE TABLE/i);
    expect(await adapter.getObjectDefinition('main', 'main', 'trg_items', 'trigger')).toMatch(/^CREATE TRIGGER/i);
  });

  it('resolves Go to Definition targets through the real SQLite catalog', async () => {
    await execute('CREATE TABLE clientes (id INTEGER PRIMARY KEY, nombre TEXT NOT NULL);');
    const manager = {
      listObjectGroup: async (_profileId, database, schema, group) => {
        const methods = {
          tables: 'listTables',
          views: 'listViews',
          indexes: 'listIndexes',
          triggers: 'listTriggers',
        };
        const method = methods[group];
        return method ? adapter[method](database, schema) : [];
      },
      listColumns: async (_profileId, database, schema, name) =>
        adapter.listColumns(database, schema, name),
      getObjectDefinition: async (
        _profileId,
        database,
        schema,
        name,
        type,
        metadata,
      ) => adapter.getObjectDefinition(database, schema, name, type, metadata),
    };
    const sql = 'SELECT c.nombre FROM clientes c;';
    const reference = extractSqlReference(sql, sql.indexOf('nombre') + 2);
    const targets = await resolveSqlTargets(
      manager,
      { id: 'sqlite-test', engine: 'sqlite', filePath: adapter.profile.filePath },
      { database: 'main', schema: 'main' },
      reference,
    );

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      schema: 'main',
      name: 'clientes',
      columnName: 'nombre',
      objectType: 'table',
    });
    expect(targets[0].definition).toMatch(/^CREATE TABLE clientes/i);
  });
});
