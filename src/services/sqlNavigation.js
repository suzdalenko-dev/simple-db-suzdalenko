'use strict';

const { getDatabaseEngine } = require('../databaseEngines');

const IDENTIFIER_SOURCE =
  '(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|\\[(?:[^\\]]|\\]\\])*\\]|[A-Za-z_$#][A-Za-z0-9_$#]*)';
const QUALIFIED_IDENTIFIER_SOURCE =
  `${IDENTIFIER_SOURCE}(?:\\s*\\.\\s*${IDENTIFIER_SOURCE}){0,3}`;
const QUALIFIED_IDENTIFIER = new RegExp(QUALIFIED_IDENTIFIER_SOURCE, 'g');

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

const RELATION_GROUP_ORDER = Object.freeze([
  'views',
  'tables',
  'materializedViews',
  'synonyms',
]);

const CALL_GROUP_ORDER = Object.freeze(['packages', 'procedures', 'synonyms']);

const ALIAS_STOP_WORDS = new Set([
  'where',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'cross',
  'on',
  'group',
  'order',
  'having',
  'union',
  'intersect',
  'except',
  'limit',
  'offset',
  'fetch',
  'connect',
  'start',
  'model',
  'qualify',
  'window',
]);

class SqlNavigationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SqlNavigationError';
    this.code = code;
  }
}

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

function identifierParts(value) {
  const source = String(value || '');
  const parts = [];
  const matcher = new RegExp(IDENTIFIER_SOURCE, 'g');
  for (let match = matcher.exec(source); match; match = matcher.exec(source)) {
    parts.push(unquoteIdentifier(match[0]));
  }
  return parts;
}

function splitTopLevel(value) {
  const source = String(value || '');
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) {
        if (source[index + 1] === quote) {
          index += 1;
        } else {
          quote = '';
        }
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(' || character === '[') depth += 1;
    if ((character === ')' || character === ']') && depth > 0) depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = source.slice(start).trim();
  if (tail || parts.length) parts.push(tail);
  return parts.filter(Boolean);
}

function matchingParenthesis(source, openIndex) {
  let depth = 0;
  let quote = '';
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) {
        if (source[index + 1] === quote) {
          index += 1;
        } else {
          quote = '';
        }
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function typeFamily(typeName) {
  const value = String(typeName || '').toLowerCase();
  if (/\b(bool|boolean)\b/.test(value)) return 'boolean';
  if (/\b(date|time|timestamp|interval)\b/.test(value)) return 'datetime';
  if (/\b(bytea|blob|binary|raw|varbinary)\b/.test(value)) return 'binary';
  if (/\b(json|jsonb)\b/.test(value)) return 'json';
  if (/\b(int|integer|smallint|bigint|number|numeric|decimal|real|float|double|money)\b/.test(value)) {
    return 'number';
  }
  if (/\b(char|varchar|varchar2|nvarchar|nvarchar2|text|clob|uuid|xml)\b/.test(value)) {
    return 'string';
  }
  return '';
}

function expressionType(expression) {
  const value = String(expression || '')
    .trim()
    .replace(/^[A-Za-z_$#][A-Za-z0-9_$#]*\s*=>\s*/, '');
  const cast = /(?:::|\bAS\s+)([A-Za-z_][A-Za-z0-9_$#]*(?:\s*\([^)]*\))?)\s*\)?\s*$/i.exec(value);
  if (cast) return typeFamily(cast[1]);
  if (/^N?'(?:[^']|'')*'$/is.test(value)) return 'string';
  if (/^(?:[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?)$/i.test(value)) return 'number';
  if (/^(?:true|false)$/i.test(value)) return 'boolean';
  if (/^(?:date|time|timestamp)\s*'/i.test(value)) return 'datetime';
  if (/^null$/i.test(value)) return '';
  return '';
}

function callAt(source, endOffset) {
  let openIndex = endOffset;
  while (/\s/.test(source[openIndex] || '')) openIndex += 1;
  if (source[openIndex] !== '(') return null;
  const closeIndex = matchingParenthesis(source, openIndex);
  if (closeIndex < 0) return null;
  const argumentsList = splitTopLevel(source.slice(openIndex + 1, closeIndex));
  return {
    argumentCount: argumentsList.length,
    argumentTypes: argumentsList.map(expressionType),
    arguments: argumentsList,
    openIndex,
    closeIndex,
  };
}

function contextKind(source, start, call) {
  if (call) return 'call';
  const before = source.slice(Math.max(0, start - 100), start);
  if (/\b(?:from|join|update|into|table|view)\s*$/i.test(before)) return 'relation';
  return 'object';
}

function aliasesBefore(source, offset) {
  const aliases = new Map();
  const matcher = new RegExp(
    `\\b(?:FROM|JOIN)\\s+(${QUALIFIED_IDENTIFIER_SOURCE})(?:\\s+(?:AS\\s+)?(${IDENTIFIER_SOURCE}))?`,
    'gi',
  );
  const statementStart = source.lastIndexOf(';', Math.max(0, offset - 1)) + 1;
  const nextSeparator = source.indexOf(';', offset);
  const statementEnd = nextSeparator >= 0 ? nextSeparator : source.length;
  const scope = source.slice(statementStart, statementEnd);
  for (let match = matcher.exec(scope); match; match = matcher.exec(scope)) {
    if (!match[2]) continue;
    const alias = unquoteIdentifier(match[2]);
    if (ALIAS_STOP_WORDS.has(alias.toLowerCase())) continue;
    aliases.set(alias.toLowerCase(), identifierParts(match[1]));
  }
  return aliases;
}

function extractSqlReference(text, offset) {
  const source = String(text || '');
  const point = Math.max(0, Math.min(Number(offset) || 0, source.length));
  QUALIFIED_IDENTIFIER.lastIndex = 0;
  for (let match = QUALIFIED_IDENTIFIER.exec(source); match; match = QUALIFIED_IDENTIFIER.exec(source)) {
    const start = match.index;
    const end = start + match[0].length;
    if (point < start || point > end) continue;
    const parts = identifierParts(match[0]);
    if (!parts.length) return null;
    const call = callAt(source, end);
    const aliasTarget =
      parts.length === 2 ? aliasesBefore(source, start).get(parts[0].toLowerCase()) : null;
    return {
      text: match[0],
      parts,
      start,
      end,
      call,
      contextKind: contextKind(source, start, call),
      aliasTarget: aliasTarget?.length ? aliasTarget : null,
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

function addCandidate(candidates, candidate) {
  const key = [
    candidate.database,
    candidate.schema,
    candidate.name,
    candidate.memberName,
    candidate.columnName,
    (candidate.groups || []).join(','),
  ].join('|').toLowerCase();
  if (!candidates.some((item) => item.key === key)) {
    candidates.push({ ...candidate, key });
  }
}

function candidatesForParts(profile, session, reference, parts, options = {}) {
  const database = defaultDatabase(profile, session);
  const schema = defaultSchema(profile, session, database);
  const candidates = [];
  const groups = options.groups;
  const columnName = options.columnName || '';
  const add = (candidate) => addCandidate(candidates, { ...candidate, groups, columnName });

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
      });
    } else {
      const packageCandidate = {
        database,
        schema,
        name: parts[0],
        memberName: parts[1],
        groups: options.groups || ['packages', 'synonyms'],
        columnName,
      };
      const schemaCandidate = {
        database,
        schema: parts[0],
        name: parts[1],
        groups,
        columnName,
      };
      if (reference.contextKind === 'call') {
        addCandidate(candidates, packageCandidate);
        addCandidate(candidates, schemaCandidate);
      } else {
        addCandidate(candidates, schemaCandidate);
        addCandidate(candidates, packageCandidate);
      }
    }
    return candidates;
  }

  if (profile.engine === 'sqlserver') {
    if (parts.length >= 3) {
      add({
        database: parts[parts.length - 3],
        schema: parts[parts.length - 2],
        name: parts[parts.length - 1],
      });
    } else {
      add({ database, schema: parts[0], name: parts[1] });
    }
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

  if (profile.engine === 'sqlite') {
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

function navigationCandidates(profile, session, reference) {
  const parts = reference?.parts || [];
  if (!parts.length) return [];

  const engineGroups = getDatabaseEngine(profile.engine)?.objectGroups || [];
  const contextualGroups = reference.contextKind === 'call'
    ? CALL_GROUP_ORDER.filter((group) => engineGroups.includes(group))
    : reference.contextKind === 'relation'
      ? RELATION_GROUP_ORDER.filter((group) => engineGroups.includes(group))
      : undefined;

  if (reference.aliasTarget?.length && parts.length === 2) {
    const relationGroups = RELATION_GROUP_ORDER.filter((group) => engineGroups.includes(group));
    return candidatesForParts(profile, session, reference, reference.aliasTarget, {
      groups: relationGroups,
      columnName: parts[1],
    });
  }

  return candidatesForParts(profile, session, reference, parts, {
    groups: contextualGroups,
  });
}

function matchingObjects(objects, name) {
  const values = (objects || []).filter((object) => String(object.name) === name);
  if (values.length) return values;
  const folded = String(name).toLocaleLowerCase('en-US');
  return (objects || []).filter(
    (object) => String(object.name).toLocaleLowerCase('en-US') === folded,
  );
}

function signatureParts(signature) {
  return splitTopLevel(signature).map((argument) => {
    return argument
      .replace(/\b(?:IN|OUT|INOUT|VARIADIC)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  });
}

function routineCandidates(objects, call) {
  if (!call || objects.length <= 1) return objects;
  const compatible = objects.filter((object) => {
    const types = signatureParts(object.signature || '');
    const total = Number.isFinite(Number(object.argumentCount))
      ? Number(object.argumentCount)
      : types.length;
    const defaults = Math.max(0, Number(object.defaultArgumentCount || 0));
    const required = Math.max(0, total - defaults);
    return call.argumentCount >= required && call.argumentCount <= total;
  });
  if (compatible.length <= 1) return compatible;

  let bestScore = -1;
  const scored = compatible.map((object) => {
    const parameterTypes = signatureParts(object.signature || '').map(typeFamily);
    let score = 0;
    for (let index = 0; index < call.argumentTypes.length; index += 1) {
      const actual = call.argumentTypes[index];
      const expected = parameterTypes[index];
      if (actual && expected) score += actual === expected ? 2 : -2;
    }
    bestScore = Math.max(bestScore, score);
    return { object, score };
  });
  return scored.filter((item) => item.score === bestScore).map((item) => item.object);
}

function parameterBounds(header) {
  const openIndex = header.indexOf('(');
  if (openIndex < 0) return { required: 0, total: 0, types: [] };
  const closeIndex = matchingParenthesis(header, openIndex);
  if (closeIndex < 0) return { required: 0, total: 0, types: [] };
  const parameters = splitTopLevel(header.slice(openIndex + 1, closeIndex));
  const required = parameters.filter((parameter) => !/\bDEFAULT\b|:=/i.test(parameter)).length;
  const types = parameters.map((parameter) => {
    const cleaned = parameter
      .replace(/^\s*[^\s]+\s+/, '')
      .replace(/\b(?:IN|OUT|IN OUT|NOCOPY)\b/gi, ' ')
      .replace(/\bDEFAULT\b[\s\S]*$/i, '')
      .replace(/:=[\s\S]*$/, '')
      .trim();
    return typeFamily(cleaned);
  });
  return { required, total: parameters.length, types };
}

function memberOccurrences(source, memberName, start = 0, end = source.length) {
  const escaped = String(memberName).replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
  const matcher = new RegExp(`\\b(?:PROCEDURE|FUNCTION)\\s+(?:"${escaped}"|${escaped})\\b`, 'gi');
  const region = source.slice(start, end);
  const occurrences = [];
  for (let match = matcher.exec(region); match; match = matcher.exec(region)) {
    const absolute = start + match.index;
    const headerEnd = source.indexOf('\n', absolute);
    const semicolon = source.indexOf(';', absolute);
    const limitCandidates = [headerEnd, semicolon].filter((value) => value >= absolute);
    let limit = limitCandidates.length ? Math.min(...limitCandidates) : Math.min(source.length, absolute + 1000);
    const open = source.indexOf('(', absolute + match[0].length);
    if (open >= 0 && open < end && open < limit + 300) {
      const close = matchingParenthesis(source, open);
      if (close >= 0) limit = Math.max(limit, close + 1);
    }
    occurrences.push({
      offset: absolute + match[0].toLowerCase().lastIndexOf(memberName.toLowerCase()),
      declarationOffset: absolute,
      bounds: parameterBounds(source.slice(absolute, Math.min(end, limit + 1))),
    });
  }
  return occurrences;
}

function scoreOccurrence(occurrence, call) {
  if (!call) return 0;
  if (
    call.argumentCount < occurrence.bounds.required ||
    call.argumentCount > occurrence.bounds.total
  ) {
    return Number.NEGATIVE_INFINITY;
  }
  let score = 1;
  for (let index = 0; index < call.argumentTypes.length; index += 1) {
    const actual = call.argumentTypes[index];
    const expected = occurrence.bounds.types[index];
    if (actual && expected) score += actual === expected ? 2 : -2;
  }
  return score;
}

function bestOccurrences(occurrences, call) {
  if (!call || occurrences.length <= 1) return occurrences;
  const scored = occurrences.map((occurrence) => ({
    occurrence,
    score: scoreOccurrence(occurrence, call),
  }));
  const best = Math.max(...scored.map((item) => item.score));
  if (!Number.isFinite(best)) return occurrences;
  return scored.filter((item) => item.score === best).map((item) => item.occurrence);
}

function packageMemberOffsets(definition, memberName, mode, call) {
  const source = String(definition || '');
  const body = /\bCREATE\s+OR\s+REPLACE\s+PACKAGE\s+BODY\b/i.exec(source);
  const bodyStart = body?.index ?? source.length;
  const declarations = memberOccurrences(source, memberName, 0, bodyStart);
  const implementations = body
    ? memberOccurrences(source, memberName, bodyStart, source.length)
    : [];
  const selectedDeclarations = bestOccurrences(declarations, call);

  if (mode === 'declaration') {
    return selectedDeclarations.length
      ? selectedDeclarations.map((item) => item.offset)
      : bestOccurrences(implementations, call).map((item) => item.offset);
  }

  if (implementations.length && selectedDeclarations.length && declarations.length) {
    const declarationIndexes = selectedDeclarations.map((item) => declarations.indexOf(item));
    const aligned = declarationIndexes
      .map((index) => implementations[index])
      .filter(Boolean);
    if (aligned.length) return aligned.map((item) => item.offset);
  }
  const selectedImplementations = bestOccurrences(implementations, call);
  if (selectedImplementations.length) return selectedImplementations.map((item) => item.offset);
  return selectedDeclarations.map((item) => item.offset);
}

function symbolOffset(definition, symbol) {
  if (!symbol) return 0;
  const escaped = String(symbol).replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
  const match = new RegExp(escaped, 'i').exec(String(definition || ''));
  return match?.index ?? 0;
}

function permissionError(error) {
  const value = `${error?.code || ''} ${error?.number || ''} ${error?.message || ''}`;
  return /ORA-01031|ORA-00942|permission denied|not authorized|access denied|VIEW DEFINITION|SELECT command denied|execute command denied|ER_TABLEACCESS_DENIED_ERROR|SQLITE_AUTH|\b229\b/i.test(value);
}

function synonymCandidate(profile, session, candidate, object) {
  const target = String(object?.target || '');
  if (!target || object?.dbLink || target.includes('@')) return null;
  const parts = identifierParts(target);
  if (!parts.length) return null;
  if (profile.engine === 'sqlserver' && parts.length >= 4) return null;
  const reference = { parts, contextKind: 'object' };
  const values = candidatesForParts(profile, session, reference, parts, {});
  if (profile.engine === 'oracle' && parts.length >= 2) {
    values.unshift({
      database: candidate.database,
      schema: parts[parts.length - 2],
      name: parts[parts.length - 1],
      key: `oracle-synonym|${parts.join('|')}`.toLowerCase(),
    });
  }
  return values;
}

function targetKey(candidate, group, object) {
  return [candidate.database, candidate.schema, group, object.name, object.signature || '']
    .join('|')
    .toLowerCase();
}

async function resolveSqlTargets(
  connectionManager,
  profile,
  session,
  reference,
  mode = 'definition',
) {
  const engineGroups = getDatabaseEngine(profile.engine)?.objectGroups || [];
  const defaultGroups = NAVIGATION_GROUP_ORDER.filter((group) => engineGroups.includes(group));
  const targets = [];
  const seenTargets = new Set();
  const visitedSynonyms = new Set();
  let sawObjectWithoutSource = false;
  let sawPermissionError = false;

  const resolveCandidates = async (candidates, depth = 0, synonymChain = []) => {
    if (depth > 8) return;
    for (const candidate of candidates) {
      const groups = candidate.groups?.length ? candidate.groups : defaultGroups;
      for (const group of groups) {
        let objects;
        try {
          objects = await connectionManager.listObjectGroup(
            profile.id,
            candidate.database,
            candidate.schema,
            group,
          );
        } catch (error) {
          sawPermissionError ||= permissionError(error);
          continue;
        }

        let matches = matchingObjects(objects, candidate.name);
        if (group === 'synonyms') {
          const privateMatches = matches.filter(
            (object) =>
              !object.owner ||
              String(object.owner).toLowerCase() === String(candidate.schema).toLowerCase(),
          );
          if (privateMatches.length) matches = privateMatches;
        }
        if (group === 'procedures') {
          matches = routineCandidates(matches, reference.call);
        }
        for (const object of matches) {
          const uniqueKey = targetKey(candidate, group, object);
          if (seenTargets.has(uniqueKey)) continue;

          if (group === 'synonyms') {
            const synonymKey = `${candidate.database}|${candidate.schema}|${object.name}`.toLowerCase();
            if (visitedSynonyms.has(synonymKey)) continue;
            visitedSynonyms.add(synonymKey);
            const followed = synonymCandidate(profile, session, candidate, object);
            if (followed?.length) {
              await resolveCandidates(followed, depth + 1, [
                ...synonymChain,
                [object.owner || candidate.schema, object.name].filter(Boolean).join('.'),
              ]);
              continue;
            }
          }

          const objectType = OBJECT_TYPE_BY_GROUP[group];
          if (!objectType) continue;

          if (candidate.columnName && ['tables', 'views', 'materializedViews'].includes(group)) {
            try {
              const columns = await connectionManager.listColumns(
                profile.id,
                candidate.database,
                candidate.schema,
                candidate.name,
              );
              if (columns?.length && !matchingObjects(columns, candidate.columnName).length) {
                continue;
              }
            } catch (error) {
              sawPermissionError ||= permissionError(error);
            }
          }

          let definition;
          try {
            definition = await connectionManager.getObjectDefinition(
              profile.id,
              candidate.database,
              object.owner || candidate.schema,
              candidate.name,
              objectType,
              { ...object, navigationMode: mode },
            );
          } catch (error) {
            sawPermissionError ||= permissionError(error);
            continue;
          }
          if (!definition) {
            sawObjectWithoutSource = true;
            continue;
          }

          const source = String(definition);
          const offsets =
            objectType === 'package' && candidate.memberName
              ? packageMemberOffsets(source, candidate.memberName, mode, reference.call)
              : [symbolOffset(source, candidate.columnName || candidate.memberName || candidate.name)];
          if (objectType === 'package' && candidate.memberName && !offsets.length) {
            continue;
          }
          seenTargets.add(uniqueKey);
          const positions = offsets.length ? offsets : [0];
          const navigationObjectType =
            objectType === 'procedure' && String(object.type || '').toUpperCase() === 'FUNCTION'
              ? 'function'
              : objectType;
          for (const offset of positions) {
            targets.push({
              database: candidate.database,
              schema: object.owner || candidate.schema,
              name: candidate.name,
              memberName: candidate.memberName || '',
              columnName: candidate.columnName || '',
              objectType: navigationObjectType,
              metadata: object,
              definition: source,
              definitionOffset: offset,
              mode,
              synonymChain,
            });
          }
        }
        if (targets.length && reference.contextKind !== 'object') break;
      }
    }
  };

  await resolveCandidates(navigationCandidates(profile, session, reference));

  if (!targets.length && (sawPermissionError || sawObjectWithoutSource)) {
    const reason = sawPermissionError
      ? 'The database account cannot read the required catalog/source metadata.'
      : 'The object exists, but its source/DDL is not visible to this database account.';
    throw new SqlNavigationError(
      'SIMPLE_DB_NAVIGATION_SOURCE_UNAVAILABLE',
      `${reason} Check metadata/source permissions for ${reference.text}.`,
    );
  }
  return targets;
}

async function resolveSqlDefinition(connectionManager, profile, session, reference) {
  const targets = await resolveSqlTargets(
    connectionManager,
    profile,
    session,
    reference,
    'definition',
  );
  return targets[0] || null;
}

module.exports = {
  SqlNavigationError,
  extractSqlReference,
  identifierParts,
  navigationCandidates,
  packageMemberOffsets,
  resolveSqlDefinition,
  resolveSqlTargets,
  routineCandidates,
  splitTopLevel,
  unquoteIdentifier,
};
