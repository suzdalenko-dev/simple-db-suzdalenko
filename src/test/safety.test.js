'use strict';

const { classifySqlSafety, looksLikeRowQuery } = require('../sql/safety');

describe('SQL safety', () => {
  it('detects real DROP/TRUNCATE statements but ignores text in strings/comments', () => {
    expect(classifySqlSafety('DROP TABLE demo;', 'postgresql').destructive).toBe(true);
    expect(classifySqlSafety('TRUNCATE TABLE demo;', 'mysql').destructive).toBe(true);
    expect(classifySqlSafety("SELECT 'DROP TABLE demo'", 'postgresql').destructive).toBe(false);
    expect(classifySqlSafety('-- DROP TABLE demo\nSELECT 1', 'postgresql').destructive).toBe(false);
    expect(classifySqlSafety('# DROP TABLE demo\nSELECT 1', 'mysql').destructive).toBe(false);
    expect(classifySqlSafety("SELECT q'[DROP TABLE demo]' FROM dual", 'oracle').destructive).toBe(false);
  });

  it('flags UPDATE/DELETE without WHERE', () => {
    expect(classifySqlSafety('UPDATE demo SET active = 0;', 'sqlite').unsafeDml).toBe(true);
    expect(classifySqlSafety('DELETE FROM demo;', 'oracle').unsafeDml).toBe(true);
    expect(classifySqlSafety('UPDATE demo SET active = 0 WHERE id = 1;', 'sqlite').unsafeDml).toBe(false);
  });

  it('recognizes queries that return rows', () => {
    for (const sql of ['SELECT 1', 'WITH x AS (SELECT 1) SELECT * FROM x', 'SHOW TABLES', 'PRAGMA table_info(x)']) {
      expect(looksLikeRowQuery(sql, 'postgresql')).toBe(true);
    }
    expect(looksLikeRowQuery('CREATE TABLE x(id INT)', 'postgresql')).toBe(false);
  });
});
