'use strict';

const { getDatabaseEngine } = require('../databaseEngines');

const IDENTIFIER = '(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|\\[(?:[^\\]]|\\]\\])*\\]|[A-Za-z_$#][A-Za-z0-9_$#]*)';
const QUALIFIED_IDENTIFIER = new RegExp(
  `${IDENTIFIER}(?:\\s*\\.\\s*${IDENTIFIER}){0,3}`,
  'g',
);

const OBJECT_TYPE_BY_GROUP = Object.freeze({
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

const NAVIGATION_GROUP_ORDER = Object.freeze([
  'packages',
  'procedures',
  'views',
  'tables',
  'materializedViews',
  'types',
  'triggers',
  'sequences',
  'synonyms',
  'indexes',
  'events',
]);

function unquoteIdentifier(identifier) {
  const value = String(identifier || '').trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll('""', '"');
  }
  if (value.startsWith('`') && value.endsWith('`')) {
    return value.slice(1, -1).replaceAll('``', '`');
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).replaceAll(']]', ']');
  }
  return value;
}

function extractSqlReference(text, offset) {
  const source = String(text || '');
  const point = Math.max(0, Math.min(Number(offset) || 0, source.length));
  QUALIFIED_IDENTIFIER.lastIndex = 0;
  for (let match = QUALIFIED_IDENTIFIER.exec(source); match; match = QUALIFIED_IDENTIFIER.exec(source)) {
    const start = match.index;
    const end = start + match[0].length;
    if (point < start || point > end) continue;
    const parts = match[0].split('.').map(unquoteIdentifier).filter(Boolean);
    if (!parts.length) return null;
    return {
      text: match[0],
      parts,
      start,
      end,
    };
  }
  return null;
}

function defaultDatabase(profile, session) {
  return (
    session?.database ||
    profile.database ||
    profile.serviceName ||
    (profile.engine === 'sqlite' ? 'main' : '')
  );
}

function defaultSchema(profile, session, database) {
  if (session?.schema) return session.schema;
  if (profile.engine === 'postgresql') return 'public';
  if (profile.engine === 'sqlserver') return 'dbo';
  if (profile.engine === 'oracle') return String(profile.user || '').toUpperCase();
  if (profile.engine === 'mysql') return database || profile.database || '';
  if (profile.engine === 'sqlite') return database || 'main';
  return '';
}

function navigationCandidates(profile, session, reference) {
  const parts = reference?.parts || [];
  if (!parts.length) return [];

  const database = defaultDatabase(profile, session);
  const schema = defaultSchema(profile, session, database);
  const candidates = [];
  const add = (candidate) => {
    const key = [
      candidate.database,
      candidate.schema,
      candidate.name,
      (candidate.groups || []).join(','),
    ].join('|').toLowerCase();
    if (!candidates.some((item) => item.key === key)) {
      candidates.push({ ...candidate, key });
    }
  };

  if (parts.length === 1) {
    add({ database, schema, name: parts[0] });
    return candidates;
  }

  if (profile.engine === 'oracle') {
    if (parts.length >= 3) {
      add({
        database,
        schema: parts[parts.length - 3],
        name: parts[parts.length - 2],
        memberName: parts[parts.length - 1],
        groups: ['packages'],
      });
    } else {
      add({ database, schema: parts[0], name: parts[1] });
      add({
        database,
        schema,
        name: parts[0],
        memberName: parts[1],
        groups: ['packages'],
      });
    }
    return candidates;
  }

  if (profile.engine === 'sqlserver' && parts.length >= 3) {
    add({
      database: parts[parts.length - 3],
      schema: parts[parts.length - 2],
      name: parts[parts.length - 1],
    });
    return candidates;
  }

  if (profile.engine === 'mysql') {
    add({
      database: parts[parts.length - 2],
      schema: parts[parts.length - 2],
      name: parts[parts.length - 1],
    });
    return candidates;
  }

  add({
    database,
    schema: parts[parts.length - 2],
    name: parts[parts.length - 1],
  });
  return candidates;
}

function matchingObject(objects, name) {
  const exact = (objects || []).find((object) => String(object.name) === name);
  if (exact) return exact;
  const folded = String(name).toLocaleLowerCase('en-US');
  return (objects || []).find(
    (object) => String(object.name).toLocaleLowerCase('en-US') === folded,
  );
}

async function resolveSqlDefinition(connectionManager, profile, session, reference) {
  const engineGroups = getDatabaseEngine(profile.engine)?.objectGroups || [];
  const defaultGroups = NAVIGATION_GROUP_ORDER.filter((group) =>
    engineGroups.includes(group),
  );

  for (const candidate of navigationCandidates(profile, session, reference)) {
    const groups = candidate.groups || defaultGroups;
    for (const group of groups) {
      let objects;
      try {
        objects = await connectionManager.listObjectGroup(
          profile.id,
          candidate.database,
          candidate.schema,
          group,
        );
      } catch (_error) {
        continue;
      }
      const object = matchingObject(objects, candidate.name);
      if (!object) continue;

      const objectType = OBJECT_TYPE_BY_GROUP[group];
      if (!objectType) continue;
      const definition = await connectionManager.getObjectDefinition(
        profile.id,
        candidate.database,
        candidate.schema,
        candidate.name,
        objectType,
        object,
      );
      if (!definition) continue;
      return {
        database: candidate.database,
        schema: candidate.schema,
        name: candidate.name,
        memberName: candidate.memberName || '',
        objectType,
        metadata: object,
        definition: String(definition),
      };
    }
  }
  return null;
}

module.exports = {
  extractSqlReference,
  navigationCandidates,
  resolveSqlDefinition,
  unquoteIdentifier,
};
