'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

describe('XLSX export dependency', () => {
  it('writes and reads an XLSX with the streaming writer', async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'simple-db-xlsx-'));
    const filename = path.join(temporary, 'result.xlsx');
    try {
      const output = new ExcelJS.stream.xlsx.WorkbookWriter({ filename });
      const sheet = output.addWorksheet('Result');
      sheet.addRow(['id', 'name']).commit();
      sheet.addRow([1, 'demo']).commit();
      sheet.commit();
      await output.commit();

      const input = new ExcelJS.Workbook();
      await input.xlsx.readFile(filename);
      expect(input.getWorksheet('Result').getRow(2).values.slice(1)).toEqual([
        1,
        'demo',
      ]);
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });
});
