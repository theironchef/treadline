// Runs Code.gs outside Google. An in-memory sheet stands in for
// SpreadsheetApp, so the tests and the local dev server exercise the real
// script.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function loadScript() {
  const sheets = {};
  const book = {
    getSheetByName: (name) => sheets[name] ?? null,
    insertSheet: (name) => (sheets[name] = fakeSheet()),
  };
  const context = {
    SpreadsheetApp: { getActiveSpreadsheet: () => book },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('./Code.gs', import.meta.url), 'utf8'), context);
  return {
    get: (parameter = {}) => JSON.parse(context.doGet({ parameter }).text),
    post: (body) => JSON.parse(context.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).text),
    // Rows as the sheet holds them, header first.
    rows: () => sheets.Runs?.rows ?? [],
  };
}

function fakeSheet() {
  const rows = [];
  const blank = (r) => !r || r.every((v) => v === '');
  return {
    rows,
    getLastRow() {
      let n = rows.length;
      while (n > 0 && blank(rows[n - 1])) n--;
      return n;
    },
    getRange(row, col, numRows = 1, numCols = 1) {
      const cells = (fn) => {
        for (let i = 0; i < numRows; i++) for (let j = 0; j < numCols; j++) fn(row - 1 + i, col - 1 + j, i, j);
      };
      return {
        getValues() {
          const out = Array.from({ length: numRows }, () => new Array(numCols).fill(''));
          cells((r, c, i, j) => (out[i][j] = rows[r]?.[c] ?? ''));
          return out;
        },
        setValues(values) {
          cells((r, c, i, j) => {
            rows[r] ??= [];
            rows[r][c] = values[i][j];
          });
        },
        clearContent() {
          cells((r, c) => {
            if (rows[r]) rows[r][c] = '';
          });
        },
      };
    },
    setFrozenRows() {},
  };
}
