'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAdapter } = require('../adapters/factory');
const { getDatabaseEngine } = require('../databaseEngines');
const { resolveSqlTargets } = require('../services/sqlNavigation');

const GROUP_METHODS = Object.freeze({
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
});

const OBJECT_TYPES = Object.freeze({
  tables: 'table',
  views: 'view',
  materializedViews: 'materializedView',
  procedures: 'procedure',
  packages: 'package',
  indexes: 'index',
  triggers: 'trigger',
  sequences: 'sequence',
  types: 'type',
  synonyms: 'synonym',
  events: 'event',
});

function parseProfile(engine) {
  const key = 'SIMPLE_DB_LIVE_' + engine.toUpperCase() + '_PROFILE';
  const value = process.env[key];
  if (!value) {
    throw new Error(
      'Missing ' +
        key +
        '. Provide a JSON connection profile before running live navigation tests.',
    );
  }
  const profile = JSON.parse(value);
  return {
    ...profile,
    id: profile.id || 'live-' + engine,
    engine,
  };
}

function defaultDatabase(profile, databases) {
  return (
    profile.database ||
    profile.serviceName ||
    databases[0]?.name ||
    (profile.engine === 'sqlite' ? 'main' : '')
  );
}

function defaultSchema(profile, database, schemas) {
  if (profile.navigationTestSchema) return profile.navigationTestSchema;
  if (profile.engine === 'oracle') return String(profile.user || '').toUpperCase();
  if (profile.engine === 'postgresql') return 'public';
  if (profile.engine === 'sqlserver') return 'dbo';
  if (profile.engine === 'mysql' || profile.engine === 'sqlite') return database;
  return schemas[0]?.name || '';
}

function managerForAdapter(profile, adapter) {
  return {
    listObjectGroup: async (_profileId, database, schema, group) => {
      const method = GROUP_METHODS[group];
      return method && typeof adapter[method] === 'function'
        ? adapter[method](database, schema)
        : [];
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
}

async function inspectAdapter(profile, adapter) {
  await adapter.connect();
  const databases = await adapter.listDatabases();
  const database = defaultDatabase(profile, databases);
  const schemas = await adapter.listSchemas(database);
  const schema = defaultSchema(profile, database, schemas);
  const engine = getDatabaseEngine(profile.engine);
  const manager = managerForAdapter(profile, adapter);
  let definitions = 0;

  console.log(
    profile.engine + ': connected; database=' + database + '; schema=' + schema,
  );
  for (const group of engine.objectGroups) {
    const method = GROUP_METHODS[group];
    const objects = await adapter[method](database, schema);
    if (!objects.length) {
      console.log('  ' + group + ': no objects in test schema');
      continue;
    }
    const object = objects[0];
    const definition = await adapter.getObjectDefinition(
      database,
      object.owner || schema,
      object.name,
      OBJECT_TYPES[group],
      object,
    );
    if (!definition) {
      throw new Error(
        profile.engine +
          ': ' +
          group +
          ' object ' +
          object.name +
          ' exists but its source/DDL is not visible.',
      );
    }
    definitions += 1;
    console.log('  ' + group + ': source OK for ' + object.name);
  }

  const tables = await adapter.listTables(database, schema);
  if (tables.length) {
    const table = tables[0];
    const targets = await resolveSqlTargets(
      manager,
      profile,
      { profileId: profile.id, database, schema },
      {
        text: table.name,
        parts: [table.name],
        contextKind: 'relation',
        call: null,
      },
      'definition',
    );
    if (!targets.length) {
      throw new Error(profile.engine + ': resolver could not navigate to ' + table.name);
    }
    console.log('  resolver: table navigation OK for ' + table.name);
  }
  if (definitions === 0 && tables.length === 0) {
    throw new Error(
      profile.engine + ': the selected test schema contains no navigable objects.',
    );
  }
}

async function verifyNetworkEngine(engine) {
  const profile = parseProfile(engine);
  const password =
    process.env['SIMPLE_DB_LIVE_' + engine.toUpperCase() + '_PASSWORD'] || '';
  const adapter = createAdapter(profile, password);
  try {
    await inspectAdapter(profile, adapter);
  } finally {
    await adapter.disconnect().catch(() => {});
  }
}

async function verifySqlite() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'simple-db-live-sqlite-'));
  const profile = {
    id: 'live-sqlite',
    engine: 'sqlite',
    filePath: path.join(temporary, 'navigation.sqlite'),
    readOnly: false,
    queryTimeoutMs: 0,
  };
  const adapter = createAdapter(profile, '');
  const sink = {
    start: async () => {},
    rows: async () => {},
    end: async () => {},
  };
  try {
    await adapter.connect();
    await adapter.execute(
      'live-navigation',
      'CREATE TABLE navigation_test (id INTEGER PRIMARY KEY, name TEXT);',
      {
        executionId: 'live-navigation-create',
        maxRows: 0,
        pageSize: 100,
        sink,
      },
    );
    await adapter.disconnect();
    await inspectAdapter(profile, adapter);
  } finally {
    await adapter.disconnect().catch(() => {});
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const engines = String(
    process.env.SIMPLE_DB_LIVE_ENGINES ||
      'sqlite,postgresql,mysql,sqlserver,oracle',
  )
    .split(',')
    .map((engine) => engine.trim().toLowerCase())
    .filter(Boolean);
  for (const engine of engines) {
    if (engine === 'sqlite') {
      await verifySqlite();
    } else {
      await verifyNetworkEngine(engine);
    }
  }
  console.log('Live navigation verification passed for: ' + engines.join(', ') + '.');
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
