'use strict';

const { detectTransactionControl } = require('../sql/transactionControl');

describe('transactionControl', () => {
  it('detects common explicit transaction controls in PostgreSQL and MySQL', () => {
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

  it('detects SQL Server BEGIN TRANSACTION but not BEGIN TRY', () => {
    expect(detectTransactionControl('BEGIN TRANSACTION;', 'sqlserver')).toBe('begin');
    expect(detectTransactionControl('BEGIN TRAN tx_name;', 'sqlserver')).toBe('begin');
    expect(detectTransactionControl('BEGIN TRY', 'sqlserver')).toBeNull();
  });

  it('does not confuse Oracle blocks or SQLite transactions managed by its worker', () => {
    expect(detectTransactionControl('BEGIN NULL; END;', 'oracle')).toBeNull();
    expect(detectTransactionControl('BEGIN IMMEDIATE;', 'sqlite')).toBeNull();
    expect(detectTransactionControl('ROLLBACK TO SAVEPOINT x;', 'postgresql')).toBeNull();
  });
});
