'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parentPort } = require('node:worker_threads');
const initSqlJs = require('sql.js');
const { createCodeMask } = require('../sql/sqlSplitter');

let SQL = null;
let database = null;
let filePath = '';
let readOnly = false;
let diskFingerprint = null;
let inTransaction = false;
let transactionDirty = false;
let savepointDepth = 0;
let savepointStartedTransaction = false;
let commandQueue = Promise.resolve();
let nextSequence = 1;
const acknowledgements = new Map();
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function normalizeSqliteInteger(value) {
  if (
    typeof value === 'bigint' &&
    value >= MIN_SAFE_BIGINT &&
    value <= MAX_SAFE_BIGINT
  ) {
    return Number(value);
  }
  return value;
}

function serializeError(error) {
  return {
    message: error?.message || String(error),
    code: error?.code || 'SQLITE_ERROR',
    stack: error?.stack || '',
  };
}

function databaseChangedBy(sql) {
  const code = createCodeMask(sql).replace(/\s+/g, ' ').trim();
  return (
    /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|REPLACE|VACUUM|REINDEX|ANALYZE)\b/i.test(
      code,
    ) || /^PRAGMA\s+[^;=]+=/i.test(code)
  );
}

function changesRows(sql) {
  const code = createCodeMask(sql).replace(/\s+/g, ' ').trim();
  return /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(code);
}

function transactionControl(sql) {
  const code = createCodeMask(sql).replace(/\s+/g, ' ').trim();
  if (/^BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?\b/i.test(code)) {
    return 'begin';
  }
  if (/^SAVEPOINT\b/i.test(code)) return 'savepoint';
  if (/^RELEASE(?:\s+SAVEPOINT)?\b/i.test(code)) return 'release';
  if (/^(?:COMMIT|END(?:\s+TRANSACTION)?)\b/i.test(code)) return 'commit';
  if (/^ROLLBACK\s+TO\b/i.test(code)) return 'rollbackTo';
  if (/^ROLLBACK\b/i.test(code)) return 'rollback';
  return null;
}

function applyTransactionControl(control, wasInTransaction) {
  if (control === 'begin') {
    inTransaction = true;
    transactionDirty = false;
    savepointDepth = 0;
    savepointStartedTransaction = false;
    return false;
  }
  if (control === 'savepoint') {
    if (!wasInTransaction) {
      inTransaction = true;
      savepointStartedTransaction = true;
    }
    savepointDepth += 1;
    return false;
  }
  if (control === 'release') {
    savepointDepth = Math.max(0, savepointDepth - 1);
    if (savepointDepth === 0 && savepointStartedTransaction) {
      inTransaction = false;
      savepointStartedTransaction = false;
      const shouldPersist = transactionDirty;
      transactionDirty = false;
      return shouldPersist;
    }
    return false;
  }
  if (control === 'commit') {
    inTransaction = false;
    savepointDepth = 0;
    savepointStartedTransaction = false;
    const shouldPersist = transactionDirty;
    transactionDirty = false;
    return shouldPersist;
  }
  if (control === 'rollback') {
    inTransaction = false;
    transactionDirty = false;
    savepointDepth = 0;
    savepointStartedTransaction = false;
  }
  return false;
}

function assertWritableSql(sql) {
  if (readOnly && databaseChangedBy(sql)) {
    const error = new Error('La conexión SQLite está configurada como solo lectura.');
    error.code = 'SQLITE_READONLY';
    throw error;
  }
}

function fileFingerprint(targetPath) {
  try {
    const stat = fs.statSync(targetPath, { bigint: true });
    return `${stat.size}:${stat.mtimeNs}`;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function readDiskFingerprint() {
  return [
    fileFingerprint(filePath),
    fileFingerprint(`${filePath}-wal`),
    fileFingerprint(`${filePath}-journal`),
  ].join('|');
}

function assertNoActiveWal() {
  try {
    if (fs.statSync(`${filePath}-wal`).size > 0) {
      const error = new Error(
        'La base SQLite tiene un archivo WAL activo. Para evitar leer una instantánea incompleta, haz CHECKPOINT/cierra el proceso escritor y vuelve a conectar.',
      );
      error.code = 'SQLITE_BUSY_WAL';
      throw error;
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
}

function assertDiskUnchanged() {
  const current = readDiskFingerprint();
  if (current !== diskFingerprint) {
    const error = new Error(
      'El archivo SQLite fue modificado por otra aplicación desde que se abrió. Simple DB no lo sobrescribirá; desconecta y vuelve a conectar para recargarlo.',
    );
    error.code = 'SQLITE_BUSY_EXTERNAL';
    throw error;
  }
}

function persistDatabase() {
  if (readOnly || !database || !filePath) {
    return;
  }
  assertDiskUnchanged();
  const bytes = Buffer.from(database.export());
  database.run('PRAGMA foreign_keys = ON');
  const temporaryPath = `${filePath}.simple-db.tmp`;
  fs.writeFileSync(temporaryPath, bytes);
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (_error) {
    fs.writeFileSync(filePath, bytes);
    try {
      fs.unlinkSync(temporaryPath);
    } catch (_unlinkError) {
      // El archivo temporal se limpiará en la próxima escritura si sigue presente.
    }
  }
  diskFingerprint = readDiskFingerprint();
}

async function ensureSqlJs() {
  if (SQL) {
    return SQL;
  }
  SQL = await initSqlJs({
    locateFile: (filename) => require.resolve(`sql.js/dist/${filename}`),
  });
  return SQL;
}

async function openDatabase(payload) {
  await ensureSqlJs();
  filePath = path.resolve(String(payload.filePath));
  readOnly = Boolean(payload.readOnly);

  if (readOnly && !fs.existsSync(filePath)) {
    const error = new Error(`No existe el archivo SQLite: ${filePath}`);
    error.code = 'SQLITE_CANTOPEN';
    throw error;
  }

  const exists = fs.existsSync(filePath);
  if (exists) assertNoActiveWal();
  diskFingerprint = readDiskFingerprint();
  const data = exists ? fs.readFileSync(filePath) : null;
  database = data?.length
    ? new SQL.Database(new Uint8Array(data))
    : new SQL.Database();
  database.run('PRAGMA foreign_keys = ON');
  inTransaction = false;
  transactionDirty = false;
  savepointDepth = 0;
  savepointStartedTransaction = false;

  if (!exists && !readOnly) {
    persistDatabase();
  }

  const version = database.exec('SELECT sqlite_version() AS version');
  return {
    version: version[0]?.values?.[0]?.[0] || 'SQLite',
  };
}

function queryAll(sql) {
  if (!database) {
    throw new Error('SQLite no está conectado.');
  }
  assertDiskUnchanged();
  const results = database.exec(sql, { useBigInt: true });
  if (!results.length) {
    return [];
  }
  const first = results[0];
  return first.values.map((values) =>
    Object.fromEntries(
      first.columns.map((column, index) => [
        column,
        normalizeSqliteInteger(values[index]),
      ]),
    ),
  );
}

function sendStreamEvent(requestId, event, payload) {
  const sequence = nextSequence;
  nextSequence += 1;
  parentPort.postMessage({
    type: 'stream',
    requestId,
    sequence,
    event,
    ...payload,
  });
  return new Promise((resolve) => {
    acknowledgements.set(`${requestId}:${sequence}`, resolve);
  });
}

async function executeSql(requestId, payload) {
  if (!database) {
    throw new Error('SQLite no está conectado.');
  }
  // sql.js trabaja sobre un snapshot en memoria. Si otro proceso modifica el
  // archivo (o crea WAL/journal), se obliga a reconectar también para lecturas.
  assertDiskUnchanged();
  assertWritableSql(payload.sql);

  const pageSize = Math.max(1, Number(payload.pageSize || 500));
  const maxRows = Math.max(0, Number(payload.maxRows || 0));
  const hasLimit = maxRows > 0;
  let resultSetIndex = 0;
  let rowCount = 0;
  let rowsAffected = 0;
  let truncated = false;
  let statementCount = 0;
  let shouldPersist = false;

  for (const statement of database.iterateStatements(payload.sql)) {
    statementCount += 1;
    const statementSql = statement.getSQL();
    const control = transactionControl(statementSql);
    const wasInTransaction = inTransaction;
    const columns = statement.getColumnNames().map((name) => ({ name, type: '' }));
    let setRows = 0;
    let setTruncated = false;
    let buffer = [];

    if (columns.length > 0) {
      await sendStreamEvent(requestId, 'start', {
        setIndex: resultSetIndex,
        columns,
      });
    }

    try {
      while (statement.step()) {
        if (columns.length === 0) {
          continue;
        }
        setRows += 1;
        if (!hasLimit || setRows <= maxRows) {
          buffer.push(
            statement
              .get(null, { useBigInt: true })
              .map((value) => normalizeSqliteInteger(value)),
          );
          if (buffer.length >= pageSize) {
            await sendStreamEvent(requestId, 'rows', {
              setIndex: resultSetIndex,
              rows: buffer,
            });
            buffer = [];
          }
        } else {
          setTruncated = true;
        }
      }

      if (buffer.length > 0) {
        await sendStreamEvent(requestId, 'rows', {
          setIndex: resultSetIndex,
          rows: buffer,
        });
      }

      if (changesRows(statementSql)) {
        rowsAffected += Number(database.getRowsModified() || 0);
      }
      if (columns.length > 0) {
        const visibleRows = hasLimit ? Math.min(setRows, maxRows) : setRows;
        await sendStreamEvent(requestId, 'end', {
          setIndex: resultSetIndex,
          rowCount: visibleRows,
          truncated: setTruncated,
        });
        resultSetIndex += 1;
        rowCount += visibleRows;
        truncated ||= setTruncated;
      }

      if (databaseChangedBy(statementSql)) {
        if (inTransaction) transactionDirty = true;
        else shouldPersist = true;
      }
      shouldPersist ||= applyTransactionControl(control, wasInTransaction);
    } finally {
      statement.free();
    }
  }

  if (!inTransaction && shouldPersist) {
    persistDatabase();
  }

  return {
    command: 'SQLite',
    rowCount,
    rowsAffected,
    resultSetCount: resultSetIndex,
    statementCount,
    truncated,
    inTransaction,
  };
}

async function handleCommand(message) {
  switch (message.type) {
    case 'open':
      return openDatabase(message.payload);
    case 'queryAll':
      return { rows: queryAll(message.payload.sql) };
    case 'execute':
      return executeSql(message.requestId, message.payload);
    case 'begin':
      if (inTransaction) {
        throw new Error('Ya existe una transacción SQLite activa.');
      }
      assertDiskUnchanged();
      database.run('BEGIN TRANSACTION');
      inTransaction = true;
      transactionDirty = false;
      savepointDepth = 0;
      savepointStartedTransaction = false;
      return {};
    case 'commit':
      if (!inTransaction) {
        throw new Error('No hay una transacción SQLite activa.');
      }
      if (transactionDirty) assertDiskUnchanged();
      database.run('COMMIT');
      inTransaction = false;
      if (transactionDirty) persistDatabase();
      transactionDirty = false;
      savepointDepth = 0;
      savepointStartedTransaction = false;
      return {};
    case 'rollback':
      if (inTransaction) {
        database.run('ROLLBACK');
        inTransaction = false;
      }
      transactionDirty = false;
      savepointDepth = 0;
      savepointStartedTransaction = false;
      return {};
    case 'close':
      if (database) {
        if (inTransaction) {
          database.run('ROLLBACK');
          inTransaction = false;
        }
        transactionDirty = false;
        savepointDepth = 0;
        savepointStartedTransaction = false;
        database.close();
        database = null;
      }
      return {};
    default:
      throw new Error(`Comando SQLite desconocido: ${message.type}`);
  }
}

parentPort.on('message', (message) => {
  if (message.type === 'ack') {
    const key = `${message.requestId}:${message.sequence}`;
    acknowledgements.get(key)?.();
    acknowledgements.delete(key);
    return;
  }

  commandQueue = commandQueue.then(async () => {
    try {
      const result = await handleCommand(message);
      parentPort.postMessage({
        type: 'response',
        requestId: message.requestId,
        result,
      });
    } catch (error) {
      parentPort.postMessage({
        type: 'error',
        requestId: message.requestId,
        error: serializeError(error),
      });
    }
  });
});
