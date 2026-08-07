'use strict';

const {
  createCodeMask,
  findStatementAtOffset,
  splitSqlDocument,
} = require('../sql/sqlSplitter');
const { wrapMysqlDefinition } = require('../adapters/mysqlAdapter');

describe('sqlSplitter', () => {
  it('ignora delimitadores dentro de strings y comentarios', () => {
    const sql = "SELECT ';' AS value; -- ; oculto\nSELECT 2 /* ; */;";
    const statements = splitSqlDocument(sql, 'sqlite');
    expect(statements).toHaveLength(2);
    expect(statements[0].sql).toContain("';'");
    expect(statements[1].sql).toContain('SELECT 2');
  });

  it('mantiene cuerpos dollar-quoted de PostgreSQL como una sentencia', () => {
    const sql = `CREATE OR REPLACE FUNCTION public.demo() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1;
  RAISE NOTICE 'hola;';
END;
$$;
SELECT 42;`;
    const statements = splitSqlDocument(sql, 'postgresql');
    expect(statements).toHaveLength(2);
    expect(statements[0].sql).toContain('PERFORM 1;');
    expect(statements[1].sql).toBe('SELECT 42;');
  });

  it('interpreta GO y GO n en SQL Server sin enviarlos al servidor', () => {
    const sql = 'SELECT 1;\nGO 2\nSELECT 2;\nGO\n';
    const statements = splitSqlDocument(sql, 'sqlserver');
    expect(statements.map((entry) => entry.sql)).toEqual([
      'SELECT 1;',
      'SELECT 1;',
      'SELECT 2;',
    ]);
  });

  it('interpreta DELIMITER de MySQL y conserva el cuerpo de la rutina', () => {
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

  it('reabre SHOW CREATE de rutinas MySQL como un bloque ejecutable único', () => {
    const definition = wrapMysqlDefinition(
      'CREATE PROCEDURE `demo`() BEGIN SELECT 1; SELECT 2; END',
    );
    const statements = splitSqlDocument(definition, 'mysql');
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain('SELECT 1; SELECT 2;');
    expect(statements[0].sql).not.toContain('DELIMITER');
  });

  it('ignora delimitadores dentro de comentarios # de MySQL', () => {
    const statements = splitSqlDocument('# comentario; oculto\nSELECT 1;', 'mysql');
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain('SELECT 1;');
  });

  it('mantiene bloques PL/SQL Oracle hasta la barra de terminación', () => {
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

  it('respeta literales q-quoted de Oracle al dividir SQL normal', () => {
    const sql = "INSERT INTO demo(value) VALUES (q'[uno;dos]'); SELECT 2 FROM dual;";
    const statements = splitSqlDocument(sql, 'oracle');
    expect(statements).toHaveLength(2);
    expect(statements[0].sql).toContain("q'[uno;dos]'");
  });

  it('mantiene un CREATE TRIGGER SQLite con sentencias internas', () => {
    const sql = `CREATE TRIGGER audit_insert AFTER INSERT ON items
BEGIN
  INSERT INTO audit(message) VALUES ('uno;dos');
  UPDATE counters SET value = value + 1;
END;
SELECT * FROM items;`;
    const statements = splitSqlDocument(sql, 'sqlite');
    expect(statements).toHaveLength(2);
    expect(statements[0].sql).toContain('UPDATE counters');
    expect(statements[1].sql).toBe('SELECT * FROM items;');
  });

  it('localiza la sentencia bajo el cursor', () => {
    const sql = 'SELECT 1;\n\nSELECT 22;\nSELECT 333;';
    const offset = sql.indexOf('22') + 1;
    expect(findStatementAtOffset(sql, 'postgresql', offset).sql).toBe('SELECT 22;');
  });

  it('enmascara literales y comentarios sin cambiar offsets ni saltos de línea', () => {
    const sql = "SELECT 'secreto;'; -- comentario\nSELECT 1;";
    const mask = createCodeMask(sql);
    expect(mask).toHaveLength(sql.length);
    expect(mask.split('\n')).toHaveLength(sql.split('\n').length);
    expect(mask).not.toContain('secreto');
    expect(mask).not.toContain('comentario');
  });
});
