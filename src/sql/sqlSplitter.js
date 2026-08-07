'use strict';

function createCodeMask(sql, options = {}) {
  const mask = sql.split('');
  const allowDollarQuotes = options.dollarQuotes === true;
  const allowHashComments = options.hashComments === true;
  const allowOracleQuotes = options.oracleQuotes === true;
  let i = 0;
  let blockDepth = 0;
  let lineComment = false;
  let quote = null;
  let dollarTag = null;
  let oracleQuoteEnd = null;

  const hide = (index) => {
    if (mask[index] !== '\n' && mask[index] !== '\r') {
      mask[index] = ' ';
    }
  };

  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];

    if (lineComment) {
      hide(i);
      if (char === '\n') {
        lineComment = false;
      }
      i += 1;
      continue;
    }

    if (blockDepth > 0) {
      hide(i);
      if (char === '/' && next === '*') {
        hide(i + 1);
        blockDepth += 1;
        i += 2;
      } else if (char === '*' && next === '/') {
        hide(i + 1);
        blockDepth -= 1;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (dollarTag !== null) {
      if (sql.startsWith(dollarTag, i)) {
        for (let j = 0; j < dollarTag.length; j += 1) {
          hide(i + j);
        }
        i += dollarTag.length;
        dollarTag = null;
      } else {
        hide(i);
        i += 1;
      }
      continue;
    }

    if (oracleQuoteEnd !== null) {
      if (sql.startsWith(oracleQuoteEnd, i)) {
        for (let j = 0; j < oracleQuoteEnd.length; j += 1) hide(i + j);
        i += oracleQuoteEnd.length;
        oracleQuoteEnd = null;
      } else {
        hide(i);
        i += 1;
      }
      continue;
    }

    if (quote !== null) {
      hide(i);

      if (quote === ']' && char === ']' && next === ']') {
        hide(i + 1);
        i += 2;
        continue;
      }

      if (char === quote) {
        if ((quote === "'" || quote === '"' || quote === '`') && next === quote) {
          hide(i + 1);
          i += 2;
          continue;
        }

        let backslashes = 0;
        for (let j = i - 1; j >= 0 && sql[j] === '\\'; j -= 1) {
          backslashes += 1;
        }
        if (backslashes % 2 === 0) {
          quote = null;
        }
      }

      i += 1;
      continue;
    }

    if (char === '-' && next === '-') {
      hide(i);
      hide(i + 1);
      lineComment = true;
      i += 2;
      continue;
    }

    if (allowHashComments && char === '#') {
      hide(i);
      lineComment = true;
      i += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      hide(i);
      hide(i + 1);
      blockDepth = 1;
      i += 2;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      hide(i);
      quote = char;
      i += 1;
      continue;
    }

    if (allowOracleQuotes && /[qQ]/.test(char) && next === "'" && i + 2 < sql.length) {
      const opening = sql[i + 2];
      const closing = { '[': ']', '{': '}', '(': ')', '<': '>' }[opening] || opening;
      hide(i);
      hide(i + 1);
      hide(i + 2);
      oracleQuoteEnd = `${closing}'`;
      i += 3;
      continue;
    }

    if (char === '[') {
      hide(i);
      quote = ']';
      i += 1;
      continue;
    }

    if (allowDollarQuotes && char === '$') {
      const match = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (match) {
        dollarTag = match[0];
        for (let j = 0; j < dollarTag.length; j += 1) {
          hide(i + j);
        }
        i += dollarTag.length;
        continue;
      }
    }

    i += 1;
  }

  return mask.join('');
}

function isExecutableSql(sql, options = {}) {
  return createCodeMask(sql, options).trim().length > 0;
}

function trimSegment(source, start, end, removeSuffix = 0) {
  let left = start;
  let right = Math.max(start, end - removeSuffix);

  while (left < right && /\s/.test(source[left])) {
    left += 1;
  }
  while (right > left && /\s/.test(source[right - 1])) {
    right -= 1;
  }

  return { sql: source.slice(left, right), start: left, end: right };
}

function splitWithDelimiter(source, delimiter = ';', options = {}) {
  const allowDollarQuotes = options.dollarQuotes === true;
  const keepDelimiter = options.keepDelimiter ?? delimiter === ';';
  const mask = createCodeMask(source, {
    dollarQuotes: allowDollarQuotes,
    hashComments: options.hashComments === true,
    oracleQuotes: options.oracleQuotes === true,
  });
  const segments = [];
  let start = 0;
  let i = 0;

  while (i <= source.length - delimiter.length) {
    if (
      mask.startsWith(delimiter, i) &&
      source.startsWith(delimiter, i)
    ) {
      const rawEnd = i + delimiter.length;
      const segment = trimSegment(
        source,
        start,
        rawEnd,
        keepDelimiter ? 0 : delimiter.length,
      );
      if (isExecutableSql(segment.sql, options)) {
        segments.push(segment);
      }
      start = rawEnd;
      i = rawEnd;
      continue;
    }
    i += 1;
  }

  const tail = trimSegment(source, start, source.length);
  if (isExecutableSql(tail.sql, options)) {
    segments.push(tail);
  }
  return segments;
}

function lineRanges(source) {
  const ranges = [];
  let start = 0;
  for (let i = 0; i <= source.length; i += 1) {
    if (i === source.length || source[i] === '\n') {
      ranges.push({ start, end: i, next: Math.min(i + 1, source.length) });
      start = i + 1;
    }
  }
  return ranges;
}

function splitSqlServer(source) {
  const mask = createCodeMask(source);
  const segments = [];
  let batchStart = 0;

  for (const line of lineRanges(source)) {
    const codeLine = mask.slice(line.start, line.end).trim();
    const match = codeLine.match(/^GO(?:\s+(\d+))?$/i);
    if (!match) {
      continue;
    }

    const batch = trimSegment(source, batchStart, line.start);
    if (isExecutableSql(batch.sql)) {
      const repetitions = Math.max(1, Number.parseInt(match[1] || '1', 10));
      for (let count = 0; count < repetitions; count += 1) {
        segments.push({ ...batch });
      }
    }
    batchStart = line.next;
  }

  const tail = trimSegment(source, batchStart, source.length);
  if (isExecutableSql(tail.sql)) {
    segments.push(tail);
  }
  return segments;
}

function splitMysql(source) {
  const mask = createCodeMask(source, { hashComments: true });
  const segments = [];
  let delimiter = ';';
  let sectionStart = 0;

  const addSection = (start, end, currentDelimiter) => {
    const section = source.slice(start, end);
    for (const statement of splitWithDelimiter(section, currentDelimiter, {
      keepDelimiter: currentDelimiter === ';',
      hashComments: true,
    })) {
      segments.push({
        sql: statement.sql,
        start: statement.start + start,
        end: statement.end + start,
      });
    }
  };

  for (const line of lineRanges(source)) {
    const codeLine = mask.slice(line.start, line.end).trim();
    const match = codeLine.match(/^DELIMITER\s+(\S+)\s*$/i);
    if (!match) {
      continue;
    }

    addSection(sectionStart, line.start, delimiter);
    delimiter = match[1];
    sectionStart = line.next;
  }

  addSection(sectionStart, source.length, delimiter);
  return segments;
}

function looksLikeOraclePlsql(source) {
  const code = createCodeMask(source).trimStart();
  return /^(?:DECLARE\b|BEGIN\b|CREATE\s+(?:OR\s+REPLACE\s+)?(?:PROCEDURE|FUNCTION|PACKAGE(?:\s+BODY)?|TRIGGER|TYPE(?:\s+BODY)?)\b)/i.test(
    code,
  );
}

function splitOracleChunk(source, offset, segments) {
  const trimmed = trimSegment(source, 0, source.length);
  if (!isExecutableSql(trimmed.sql)) {
    return;
  }

  if (looksLikeOraclePlsql(trimmed.sql)) {
    segments.push({
      sql: trimmed.sql,
      start: offset + trimmed.start,
      end: offset + trimmed.end,
    });
    return;
  }

  for (const statement of splitWithDelimiter(source, ';', { oracleQuotes: true })) {
    segments.push({
      sql: statement.sql,
      start: offset + statement.start,
      end: offset + statement.end,
    });
  }
}

function splitOracle(source) {
  const mask = createCodeMask(source, { oracleQuotes: true });
  const segments = [];
  let chunkStart = 0;

  for (const line of lineRanges(source)) {
    if (mask.slice(line.start, line.end).trim() !== '/') {
      continue;
    }
    splitOracleChunk(source.slice(chunkStart, line.start), chunkStart, segments);
    chunkStart = line.next;
  }

  splitOracleChunk(source.slice(chunkStart), chunkStart, segments);
  return segments;
}

function splitSqlite(source) {
  const raw = splitWithDelimiter(source, ';');
  const result = [];
  let trigger = null;

  for (const segment of raw) {
    const code = createCodeMask(segment.sql).trim();
    if (trigger === null && /^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(code)) {
      trigger = { ...segment };
      if (/\bEND\s*;?\s*$/i.test(code)) {
        result.push(trigger);
        trigger = null;
      }
      continue;
    }

    if (trigger !== null) {
      trigger.sql = source.slice(trigger.start, segment.end);
      trigger.end = segment.end;
      if (/\bEND\s*;?\s*$/i.test(code)) {
        result.push(trigger);
        trigger = null;
      }
      continue;
    }

    result.push(segment);
  }

  if (trigger !== null) {
    result.push(trigger);
  }
  return result;
}

function splitSqlDocument(source, engineId) {
  switch (engineId) {
    case 'postgresql':
      return splitWithDelimiter(source, ';', { dollarQuotes: true });
    case 'mysql':
      return splitMysql(source);
    case 'sqlserver':
      return splitSqlServer(source);
    case 'oracle':
      return splitOracle(source);
    case 'sqlite':
      return splitSqlite(source);
    default:
      return splitWithDelimiter(source, ';');
  }
}

function findStatementAtOffset(source, engineId, offset) {
  const statements = splitSqlDocument(source, engineId);
  if (statements.length === 0) {
    return null;
  }

  const exact = statements.find(
    (statement) => offset >= statement.start && offset <= statement.end,
  );
  if (exact) {
    return exact;
  }

  const previous = [...statements]
    .reverse()
    .find((statement) => statement.end < offset);
  return previous || statements[0];
}

module.exports = {
  createCodeMask,
  findStatementAtOffset,
  isExecutableSql,
  looksLikeOraclePlsql,
  splitSqlDocument,
  splitWithDelimiter,
};
