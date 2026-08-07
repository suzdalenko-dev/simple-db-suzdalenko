'use strict';

const { detectTransactionControl } = require('../sql/transactionControl');

describe('transactionControl', () => {
  it('detecta controles explícitos habituales de PostgreSQL y MySQL', () => {
    expect(detectTransactionControl('BEGIN;', 'postgresql')).toBe('begin');
    expect(detectTransactionControl('START TRANSACTION;', 'mysql')).toBe('begin');
    expect(
      detectTransactionControl('BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY;', 'postgresql'),
    ).toBe('begin');
    expect(
      detectTransactionControl('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ WRITE;', 'mysql'),
    ).toBe('begin');
    expect(detectTransactionControl('COMMIT WORK;', 'postgresql')).toBe('commit');
    expect(detectTransactionControl('ROLLBACK;', 'mysql')).toBe('rollback');
  });

  it('detecta BEGIN TRANSACTION de SQL Server pero no BEGIN TRY', () => {
    expect(detectTransactionControl('BEGIN TRANSACTION;', 'sqlserver')).toBe('begin');
    expect(detectTransactionControl('BEGIN TRAN tx_name;', 'sqlserver')).toBe('begin');
    expect(detectTransactionControl('BEGIN TRY', 'sqlserver')).toBeNull();
  });

  it('no confunde bloques Oracle ni transacciones SQLite gestionadas por su worker', () => {
    expect(detectTransactionControl('BEGIN NULL; END;', 'oracle')).toBeNull();
    expect(detectTransactionControl('BEGIN IMMEDIATE;', 'sqlite')).toBeNull();
    expect(detectTransactionControl('ROLLBACK TO SAVEPOINT x;', 'postgresql')).toBeNull();
  });
});
