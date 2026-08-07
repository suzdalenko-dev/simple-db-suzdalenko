'use strict';

const { createCodeMask } = require('./sqlSplitter');

function normalizeControlSql(sql, engineId) {
  return createCodeMask(sql, {
    dollarQuotes: engineId === 'postgresql',
    hashComments: engineId === 'mysql',
    oracleQuotes: engineId === 'oracle',
  })
    .replace(/;\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectTransactionControl(sql, engineId) {
  // The SQLite worker also synchronizes BEGIN IMMEDIATE/EXCLUSIVE and SAVEPOINT.
  if (engineId === 'sqlite') return null;
  const code = normalizeControlSql(sql, engineId);

  if (engineId !== 'oracle') {
    const beginPatterns = {
      // PostgreSQL supports modes such as ISOLATION LEVEL / READ ONLY, while
      // MySQL adds READ ONLY/WRITE or WITH CONSISTENT SNAPSHOT. Reserve the
      // physical connection first, then let the adapter execute the original SQL.
      postgresql: /^(?:BEGIN(?:\s+(?:WORK|TRANSACTION))?(?:\s+.+)?|START\s+TRANSACTION(?:\s+.+)?)$/i,
      mysql: /^(?:BEGIN(?:\s+WORK)?|START\s+TRANSACTION(?:\s+.+)?)$/i,
      sqlserver: /^BEGIN\s+TRAN(?:SACTION)?(?:\s+[A-Za-z_][A-Za-z0-9_@$#]*)?$/i,
    };
    if (beginPatterns[engineId]?.test(code)) return 'begin';
  }

  if (/^COMMIT(?:\s+(?:WORK|TRAN(?:SACTION)?)(?:\s+[A-Za-z_][A-Za-z0-9_@$#]*)?)?$/i.test(code)) {
    return 'commit';
  }
  if (/^ROLLBACK(?:\s+(?:WORK|TRAN(?:SACTION)?)(?:\s+[A-Za-z_][A-Za-z0-9_@$#]*)?)?$/i.test(code)) {
    return 'rollback';
  }
  return null;
}

module.exports = {
  detectTransactionControl,
  normalizeControlSql,
};
