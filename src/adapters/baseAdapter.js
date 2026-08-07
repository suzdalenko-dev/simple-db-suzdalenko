'use strict';

class BaseAdapter {
  constructor(profile, password) {
    this.profile = { ...profile };
    this.password = password || '';
    this.transactions = new Map();
    this.activeExecutions = new Map();
    this.connected = false;
    this.serverVersion = '';
  }

  isConnected() {
    return this.connected;
  }

  hasTransaction(sessionId) {
    return this.transactions.has(sessionId);
  }

  transactionCount() {
    return this.transactions.size;
  }

  executionCount() {
    return this.activeExecutions.size;
  }

  async rollbackAll() {
    for (const sessionId of [...this.transactions.keys()]) {
      try {
        await this.rollback(sessionId);
      } catch (_error) {
        // Closing the pool/connection later also releases the transaction.
      }
    }
  }

  async cancelAll() {
    for (const executionId of [...this.activeExecutions.keys()]) {
      try {
        await this.cancel(executionId);
      } catch (_error) {
        // Continue cleaning up the remaining resources.
      }
    }
  }

  quoteIdentifier(identifier) {
    return `"${String(identifier).replaceAll('"', '""')}"`;
  }

  quoteTable(_database, schema, table) {
    return [schema, table]
      .filter(Boolean)
      .map((part) => this.quoteIdentifier(part))
      .join('.');
  }

  async listMaterializedViews() {
    return [];
  }

  async listIndexes() {
    return [];
  }

  async listTriggers() {
    return [];
  }

  async listSequences() {
    return [];
  }

  async listPackages() {
    return [];
  }

  async listTypes() {
    return [];
  }

  async listSynonyms() {
    return [];
  }

  async listEvents() {
    return [];
  }

  async getObjectDefinition() {
    return null;
  }
}

function normalizeColumns(fields) {
  return (fields || []).map((field, index) => ({
    name: String(field.name || field.columnName || `Column ${index + 1}`),
    type: String(field.dataTypeID || field.type || field.dbTypeName || ''),
    nullable: field.nullable,
  }));
}

async function emitRowsInChunks(sink, setIndex, rows, pageSize, maxRows) {
  const hasLimit = Number(maxRows) > 0;
  const available = hasLimit ? Math.min(rows.length, maxRows) : rows.length;
  for (let offset = 0; offset < available; offset += pageSize) {
    await sink.rows(setIndex, rows.slice(offset, Math.min(offset + pageSize, available)));
  }
  return {
    rowCount: available,
    truncated: hasLimit && rows.length > maxRows,
  };
}

module.exports = {
  BaseAdapter,
  emitRowsInChunks,
  normalizeColumns,
};
