'use strict';

const DATABASE_ENGINES = Object.freeze([
  Object.freeze({
    id: 'sqlite',
    displayName: 'SQLite',
    defaultPort: null,
    color: '#4c9ed9',
    objectGroups: ['tables', 'views', 'indexes', 'triggers'],
  }),
  Object.freeze({
    id: 'postgresql',
    displayName: 'PostgreSQL',
    defaultPort: 5432,
    color: '#336791',
    objectGroups: [
      'tables',
      'views',
      'materializedViews',
      'procedures',
      'indexes',
      'triggers',
      'sequences',
      'types',
    ],
  }),
  Object.freeze({
    id: 'mysql',
    displayName: 'MySQL',
    defaultPort: 3306,
    color: '#00758f',
    objectGroups: ['tables', 'views', 'procedures', 'indexes', 'triggers', 'events'],
  }),
  Object.freeze({
    id: 'sqlserver',
    displayName: 'SQL Server',
    defaultPort: 1433,
    color: '#cc2927',
    objectGroups: [
      'tables',
      'views',
      'procedures',
      'indexes',
      'triggers',
      'sequences',
      'types',
      'synonyms',
    ],
  }),
  Object.freeze({
    id: 'oracle',
    displayName: 'Oracle',
    defaultPort: 1521,
    color: '#f80000',
    objectGroups: [
      'tables',
      'views',
      'materializedViews',
      'procedures',
      'packages',
      'indexes',
      'triggers',
      'sequences',
      'types',
      'synonyms',
    ],
  }),
]);

const DATABASE_ENGINE_IDS = Object.freeze(
  DATABASE_ENGINES.map((engine) => engine.id),
);

function getDatabaseEngine(engineId) {
  return DATABASE_ENGINES.find((engine) => engine.id === engineId);
}

function isDatabaseEngineId(engineId) {
  return DATABASE_ENGINE_IDS.includes(engineId);
}

module.exports = {
  DATABASE_ENGINES,
  DATABASE_ENGINE_IDS,
  getDatabaseEngine,
  isDatabaseEngineId,
};
