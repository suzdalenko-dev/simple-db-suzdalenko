'use strict';

function truncateText(value, maxCharacters) {
  if (value.length <= maxCharacters) {
    return value;
  }

  const removed = value.length - maxCharacters;
  return `${value.slice(0, maxCharacters)}… [${removed} caracteres omitidos]`;
}

function normalizeValue(value, maxCharacters = 10000) {
  if (value === null || value === undefined) {
    return null;
  }

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const buffer = Buffer.from(value);
    const preview = buffer.subarray(0, Math.min(buffer.length, 64)).toString('hex');
    const suffix = buffer.length > 64 ? '…' : '';
    return `<BINARY ${buffer.length} bytes: ${preview}${suffix}>`;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'string') {
    return truncateText(value, maxCharacters);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'object') {
    try {
      const serialized = JSON.stringify(value, (_key, nestedValue) =>
        typeof nestedValue === 'bigint' ? nestedValue.toString() : nestedValue,
      );
      return truncateText(serialized, maxCharacters);
    } catch (_error) {
      return truncateText(String(value), maxCharacters);
    }
  }

  return truncateText(String(value), maxCharacters);
}

function normalizeRows(rows, columns, maxCharacters) {
  return rows.map((row) =>
    columns.map((column, index) => {
      const value = Array.isArray(row) ? row[index] : row[column.name];
      return normalizeValue(value, maxCharacters);
    }),
  );
}

module.exports = {
  normalizeRows,
  normalizeValue,
  truncateText,
};
