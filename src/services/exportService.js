'use strict';

const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const ExcelJS = require('exceljs');

function csvCell(value, delimiter, protectFormulas = true) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (protectFormulas && /^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  if (
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r')
  ) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

async function writeChunk(stream, chunk) {
  if (!stream.write(chunk)) {
    await once(stream, 'drain');
  }
}

function uniqueJsonColumnNames(columns) {
  const used = new Map();
  return columns.map((column, index) => {
    const base = String(column.name || `column_${index + 1}`);
    const count = used.get(base) || 0;
    used.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

class ExportService {
  constructor(resultStore, configurationProvider) {
    this.resultStore = resultStore;
    this.configurationProvider = configurationProvider;
  }

  async chooseAndExport(executionId, setIndex, format) {
    const metadata = this.resultStore.getMetadata(executionId);
    const set = metadata?.sets?.[setIndex];
    if (!set || set.kind !== 'rows') {
      throw new Error('The result set is no longer available for export.');
    }

    const extension = format === 'xlsx' ? 'xlsx' : format;
    const defaultName = `simple-db-${new Date().toISOString().replaceAll(':', '-')}.${extension}`;
    const uri = await vscode.window.showSaveDialog({
      title: `Export Result as ${format.toUpperCase()}`,
      defaultUri: vscode.Uri.file(path.join(process.cwd(), defaultName)),
      filters: {
        [format.toUpperCase()]: [extension],
      },
    });
    if (!uri) return null;

    if (format === 'csv') {
      await this._writeCsv(uri.fsPath, executionId, setIndex, set);
    } else if (format === 'json') {
      await this._writeJson(uri.fsPath, executionId, setIndex, set);
    } else if (format === 'xlsx') {
      await this._writeXlsx(uri.fsPath, executionId, setIndex, set);
    } else {
      throw new Error(`Unsupported export format: ${format}`);
    }
    return uri.fsPath;
  }

  async _writeCsv(filename, executionId, setIndex, set) {
    const configuration = this.configurationProvider();
    const delimiter = configuration.csvDelimiter || ';';
    const protectFormulas = configuration.csvProtectFormulaInjection !== false;
    const stream = fs.createWriteStream(filename, { encoding: 'utf8' });
    try {
      await writeChunk(
        stream,
        `\uFEFF${set.columns.map((column) => csvCell(column.name, delimiter, protectFormulas)).join(delimiter)}\n`,
      );
      for await (const row of this.resultStore.iterateRows(executionId, setIndex)) {
        await writeChunk(
          stream,
          `${row.map((value) => csvCell(value, delimiter, protectFormulas)).join(delimiter)}\n`,
        );
      }
      const finished = once(stream, 'finish');
      stream.end();
      await finished;
    } catch (error) {
      stream.destroy();
      throw error;
    }
  }

  async _writeJson(filename, executionId, setIndex, set) {
    const names = uniqueJsonColumnNames(set.columns);
    const stream = fs.createWriteStream(filename, { encoding: 'utf8' });
    try {
      await writeChunk(stream, '[\n');
      let first = true;
      for await (const row of this.resultStore.iterateRows(executionId, setIndex)) {
        const object = Object.fromEntries(
          names.map((name, index) => [name, row[index] ?? null]),
        );
        const prefix = first ? '  ' : ',\n  ';
        await writeChunk(stream, `${prefix}${JSON.stringify(object)}`);
        first = false;
      }
      await writeChunk(stream, '\n]\n');
      const finished = once(stream, 'finish');
      stream.end();
      await finished;
    } catch (error) {
      stream.destroy();
      throw error;
    }
  }

  async _writeXlsx(filename, executionId, setIndex, set) {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename,
      useStyles: true,
      useSharedStrings: false,
    });
    const sheet = workbook.addWorksheet('Result');
    const header = sheet.addRow(set.columns.map((column) => column.name));
    header.font = { bold: true };
    header.commit();
    for await (const row of this.resultStore.iterateRows(executionId, setIndex)) {
      sheet.addRow(row).commit();
    }
    sheet.commit();
    await workbook.commit();
  }
}

module.exports = {
  ExportService,
  csvCell,
  uniqueJsonColumnNames,
};
