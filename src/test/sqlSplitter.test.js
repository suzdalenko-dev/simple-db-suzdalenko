'use strict';

const {
  createCodeMask,
  findStatementAtOffset,
  splitSqlDocument,
} = require('../sql/sqlSplitter');
const { wrapMysqlDefinition } = require('../adapters/mysqlAdapter');

describe('sqlSplitter', () => {
  it('ignores delimiters inside strings and comments', () => {
    const sql = "SELECT ';' AS value; -- ; hidden\nSELECT 2 /* ; */;";
    const statements = splitSqlDocument(sql, 'sqlite');
    expect(statements).toHaveLength(2);
    expect(statements[0].sql).toContain("';'");
    expect(statements[1].sql).toContain('SELECT 2');
  });

  it('keeps PostgreSQL dollar-quoted bodies as one statement', () => {
    const sql = `CREATE OR REPLACE FUNCTION public.demo() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1;
  RAISE NOTICE 'hello;';
END;
$$;
SELECT 42;`;
    const statements = splitSqlDocument(sql, 'postgresql');
    expect(statements).toHaveLength(2);
    expect(statements[0].sql).toContain('PERFORM 1;');
    expect(statements[1].sql).toBe('SELECT 42;');
  });

  it('handles SQL Server GO and GO n without sending them to the server', () => {
    const sql = 'SELECT 1;\nGO 2\nSELECT 2;\nGO\n';
    const statements = splitSqlDocument(sql, 'sqlserver');
    expect(statements.map((entry) => entry.sql)).toEqual([
      'SELECT 1;',
      'SELECT 1;',
      'SELECT 2;',
    ]);
  });

  it('handles MySQL DELIMITER and preserves the routine body', () => {
    const sql = `DELIMITER $$
CREATE PROCEDURE demo()
BEGIN
  SELECT 1;
  SELECT 2;
END$$
DELIMITER ;
SELECT 3;`;
    const statements = splitSqlDocument(sql, 'mysql');
    expect(statements).toHaveLength(2);
    expect(statements[0].sql).toContain('SELECT 1;');
    expect(statements[0].sql).not.toContain('DELIMITER');
    expect(statements[1].sql).toBe('SELECT 3;');
  });

  it('reopens MySQL SHOW CREATE routines as a single executable block', () => {
    const definition = wrapMysqlDefinition(
      'CREATE PROCEDURE `demo`() BEGIN SELECT 1; SELECT 2; END',
    );
    const statements = splitSqlDocument(definition, 'mysql');
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain('SELECT 1; SELECT 2;');
    expect(statements[0].sql).not.toContain('DELIMITER');
  });

  it('ignores delimiters inside MySQL # comments', () => {
    const statements = splitSqlDocument('# comment; hidden\nSELECT 1;', 'mysql');
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain('SELECT 1;');
  });

  it('keeps Oracle PL/SQL blocks through the terminating slash', () => {
    const sql = `CREATE OR REPLACE PROCEDURE demo AS
BEGIN
  NULL;
END;
/
SELECT 1 FROM dual;`;
    const statements = splitSqlDocument(sql, 'oracle');
    expect(statements).toHaveLength(2);
    expect(statements[0].sql).toContain('END;');
    expect(statements[0].sql).not.toMatch(/\n\s*\/$/);
    expect(statements[1].sql).toBe('SELECT 1 FROM dual;');
  });

  it('respects Oracle q-quoted literals when splitting regular SQL', () => {
    const sql = "INSERT INTO demo(value) VALUES (q'[one;two]'); SELECT 2 FROM dual;";
    const statements = splitSqlDocument(sql, 'oracle');
    expect(statements).toHaveLength(2);
    expect(statements[0].sql).toContain("q'[one;two]'");
  });

  it('keeps a SQLite CREATE TRIGGER with internal statements intact', () => {
    const sql = `CREATE TRIGGER audit_insert AFTER INSERT ON items
BEGIN
  INSERT INTO audit(message) VALUES ('one;two');
  UPDATE counters SET value = value + 1;
END;
SELECT * FROM items;`;
    const statements = splitSqlDocument(sql, 'sqlite');
    expect(statements).toHaveLength(2);
    expect(statements[0].sql).toContain('UPDATE counters');
    expect(statements[1].sql).toBe('SELECT * FROM items;');
  });

  it('finds the statement under the cursor', () => {
    const sql = 'SELECT 1;\n\nSELECT 22;\nSELECT 333;';
    const offset = sql.indexOf('22') + 1;
    expect(findStatementAtOffset(sql, 'postgresql', offset).sql).toBe('SELECT 22;');
  });

  it('masks literals and comments without changing offsets or line breaks', () => {
    const sql = "SELECT 'secret;'; -- comment\nSELECT 1;";
    const mask = createCodeMask(sql);
    expect(mask).toHaveLength(sql.length);
    expect(mask.split('\n')).toHaveLength(sql.split('\n').length);
    expect(mask).not.toContain('secret');
    expect(mask).not.toContain('comment');
  });
});
