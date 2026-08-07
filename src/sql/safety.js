'use strict';

const { createCodeMask } = require('./sqlSplitter');

function classifySqlSafety(sql, engineId) {
  const code = createCodeMask(sql, {
    dollarQuotes: engineId === 'postgresql',
    hashComments: engineId === 'mysql',
    oracleQuotes: engineId === 'oracle',
  });
  const normalized = code.replace(/\s+/g, ' ').trim();
  const destructive = /\b(?:DROP|TRUNCATE)\b/i.test(normalized);
  const updateWithoutWhere = /^UPDATE\b/i.test(normalized) && !/\bWHERE\b/i.test(normalized);
  const deleteWithoutWhere = /^DELETE\b/i.test(normalized) && !/\bWHERE\b/i.test(normalized);

  return {
    destructive,
    unsafeDml: updateWithoutWhere || deleteWithoutWhere,
    operation: normalized.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase() || 'SQL',
  };
}

function looksLikeRowQuery(sql, engineId) {
  const code = createCodeMask(sql, {
    dollarQuotes: engineId === 'postgresql',
    hashComments: engineId === 'mysql',
    oracleQuotes: engineId === 'oracle',
  })
    .replace(/^\s+/, '');
  return /^(?:SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN|VALUES|TABLE|PRAGMA)\b/i.test(code);
}

module.exports = {
  classifySqlSafety,
  looksLikeRowQuery,
};
