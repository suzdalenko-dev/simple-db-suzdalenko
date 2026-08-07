'use strict';

class QueryCancelledError extends Error {
  constructor(message = 'Consulta cancelada por el usuario.') {
    super(message);
    this.name = 'QueryCancelledError';
    this.code = 'SIMPLE_DB_CANCELLED';
  }
}

function isCancellationError(error) {
  const code = String(error?.code ?? '').toUpperCase();
  const message = String(error?.message ?? '').toLowerCase();

  return (
    error instanceof QueryCancelledError ||
    ['SIMPLE_DB_CANCELLED', 'ECANCEL', '57014', 'SQLITE_INTERRUPT'].includes(code) ||
    message.includes('cancelled') ||
    message.includes('canceled') ||
    message.includes('cancelada') ||
    message.includes('user requested cancel') ||
    message.includes('ora-01013')
  );
}

function normalizeDatabaseError(error, engineId) {
  if (isCancellationError(error)) {
    return new QueryCancelledError();
  }

  const normalized = new Error(error?.message || String(error));
  normalized.name = 'DatabaseError';
  normalized.code = error?.code || error?.number || error?.errorNum || undefined;
  normalized.engineId = engineId;
  normalized.position = error?.position || error?.lineNumber || error?.line || undefined;
  normalized.originalError = error;
  return normalized;
}

module.exports = {
  QueryCancelledError,
  isCancellationError,
  normalizeDatabaseError,
};
