'use strict';

function createResultViewHtml(nonce) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; }
    body {
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    #summaryBar {
      min-height: 30px;
      padding: 5px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      background: var(--vscode-editorGroupHeader-tabsBackground);
    }
    #summary { color: var(--vscode-descriptionForeground); }
    #tabs {
      min-height: 30px;
      display: flex;
      align-items: end;
      gap: 2px;
      padding: 4px 8px 0;
      overflow-x: auto;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorGroupHeader-tabsBackground);
    }
    button {
      height: 24px;
      padding: 2px 8px;
      border: 1px solid transparent;
      border-radius: 2px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      cursor: pointer;
      font-family: var(--vscode-font-family);
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary, .tab {
      color: var(--vscode-foreground);
      background: var(--vscode-button-secondaryBackground);
    }
    .tab {
      min-width: 88px;
      border-radius: 2px 2px 0 0;
      border-bottom: 2px solid transparent;
      white-space: nowrap;
    }
    .tab.active {
      border-bottom-color: var(--vscode-focusBorder);
      background: var(--vscode-editor-background);
    }
    button:disabled { opacity: .45; cursor: default; }
    #toolbar {
      min-height: 34px;
      padding: 5px 8px;
      display: flex;
      gap: 5px;
      align-items: center;
      flex-wrap: wrap;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }
    #toolbar[hidden] { display: none; }
    .page-controls { display: flex; gap: 4px; align-items: center; }
    #page {
      width: 58px;
      height: 24px;
      padding: 2px 5px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    }
    #status {
      margin-left: auto;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }
    #grid {
      flex: 1;
      min-height: 0;
      overflow: auto;
      background: var(--vscode-editor-background);
    }
    table {
      border-collapse: separate;
      border-spacing: 0;
      width: max-content;
      min-width: 100%;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
    }
    th, td {
      height: 25px;
      padding: 3px 8px;
      border-right: 1px solid var(--vscode-panel-border);
      border-bottom: 1px solid var(--vscode-panel-border);
      text-align: left;
      white-space: pre;
      max-width: 700px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 2;
      font-weight: 600;
      background: var(--vscode-editorGroupHeader-tabsBackground);
    }
    .row-number {
      position: sticky;
      left: 0;
      z-index: 1;
      min-width: 48px;
      width: 48px;
      max-width: 78px;
      text-align: right;
      color: var(--vscode-editorLineNumber-foreground);
      background: var(--vscode-editorGutter-background, var(--vscode-editor-background));
      user-select: none;
    }
    th.row-number { z-index: 3; }
    tbody tr:hover td:not(.selected) { background: var(--vscode-list-hoverBackground); }
    td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
    td.selected {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .column-type {
      margin-left: 8px;
      color: var(--vscode-descriptionForeground);
      font-size: .9em;
      font-weight: 400;
    }
    .message { padding: 16px; white-space: pre-wrap; color: var(--vscode-descriptionForeground); }
    .error { color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <div id="summaryBar"><strong>Query Results</strong><span id="summary">Run a query to see results.</span></div>
  <div id="tabs"></div>
  <div id="toolbar" hidden>
    <div class="page-controls">
      <button id="prev" class="secondary" title="Previous page">&#8592;</button>
      <span>Page</span><input id="page" type="number" min="1" value="1"><span id="pages"></span>
      <button id="next" class="secondary" title="Next page">&#8594;</button>
    </div>
    <button id="copyCell" class="secondary">Copy Cell</button>
    <button id="copyRow" class="secondary">Copy Row</button>
    <button id="copySelection" class="secondary">Copy Selection</button>
    <button data-export="csv">CSV</button>
    <button data-export="json">JSON</button>
    <button data-export="xlsx">XLSX</button>
    <span id="status"></span>
  </div>
  <div id="grid"><div class="message">Run SELECT or another SQL statement to see its result here.</div></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let metadata = null;
    let activeSet = 0;
    let activePage = 0;
    let visibleRows = [];
    let rowOffset = 0;
    let anchorCell = null;
    let selection = null;
    const tabs = document.getElementById('tabs');
    const toolbar = document.getElementById('toolbar');
    const grid = document.getElementById('grid');
    const pageInput = document.getElementById('page');
    const pages = document.getElementById('pages');
    const status = document.getElementById('status');
    const prev = document.getElementById('prev');
    const next = document.getElementById('next');

    function sets() { return Array.isArray(metadata?.sets) ? metadata.sets : []; }
    function currentSet() { return sets()[activeSet]; }
    function rowLabel(count) { return count === 1 ? '1 row' : String(count) + ' rows'; }
    function messageNode(text, error) {
      const div = document.createElement('div');
      div.className = 'message' + (error ? ' error' : '');
      div.textContent = text;
      return div;
    }
    function requestPage(pageIndex) {
      const set = currentSet();
      if (!set) return;
      const maximum = Math.max(0, Number(set.pages || 0) - 1);
      const requested = Math.min(maximum, Math.max(0, Number(pageIndex) || 0));
      vscode.postMessage({ type: 'page', setIndex: activeSet, pageIndex: requested });
    }
    function selectSet(index) {
      activeSet = index;
      activePage = 0;
      renderTabs();
      const set = currentSet();
      if (!set) return;
      if (set.kind === 'rows') {
        toolbar.hidden = false;
        grid.replaceChildren(messageNode('Loading result rows...', false));
        requestPage(0);
      } else {
        toolbar.hidden = true;
        grid.replaceChildren(messageNode(set.message || 'Statement executed successfully.', set.kind === 'error'));
      }
    }
    function selectRange(rowStart, rowEnd, columnStart, columnEnd) {
      selection = {
        rowStart: Math.min(rowStart, rowEnd),
        rowEnd: Math.max(rowStart, rowEnd),
        columnStart: Math.min(columnStart, columnEnd),
        columnEnd: Math.max(columnStart, columnEnd)
      };
      grid.querySelectorAll('td[data-row]').forEach((cell) => {
        const row = Number(cell.dataset.row);
        const column = Number(cell.dataset.column);
        cell.classList.toggle(
          'selected',
          row >= selection.rowStart && row <= selection.rowEnd && column >= selection.columnStart && column <= selection.columnEnd
        );
      });
    }
    function cellText(value) { return value === null || value === undefined ? 'NULL' : String(value); }
    function copyRange(range) {
      if (!range) return;
      const lines = [];
      for (let row = range.rowStart; row <= range.rowEnd; row += 1) {
        const values = [];
        for (let column = range.columnStart; column <= range.columnEnd; column += 1) {
          values.push(cellText(visibleRows[row]?.[column]));
        }
        lines.push(values.join('\\t'));
      }
      vscode.postMessage({ type: 'copy', text: lines.join('\\n') });
    }
    function renderTabs() {
      tabs.replaceChildren();
      sets().forEach((set, index) => {
        if (!set) return;
        const button = document.createElement('button');
        button.className = 'tab' + (index === activeSet ? ' active' : '');
        button.textContent = set.kind === 'rows'
          ? 'Result ' + (index + 1) + ' · ' + rowLabel(Number(set.rowCount || 0))
          : 'Message ' + (index + 1);
        button.addEventListener('click', () => selectSet(index));
        tabs.appendChild(button);
      });
    }
    function renderPage(data) {
      if (data.setIndex !== activeSet) return;
      activePage = Number(data.pageIndex || 0);
      rowOffset = Number(data.rowOffset || 0);
      visibleRows = Array.isArray(data.rows) ? data.rows : [];
      anchorCell = null;
      selection = null;
      const set = currentSet();
      if (!set) return;

      const table = document.createElement('table');
      const head = document.createElement('thead');
      const headerRow = document.createElement('tr');
      const numberHeader = document.createElement('th');
      numberHeader.className = 'row-number';
      numberHeader.textContent = '#';
      headerRow.appendChild(numberHeader);
      (set.columns || []).forEach((column) => {
        const th = document.createElement('th');
        const name = document.createElement('span');
        name.textContent = column.name;
        th.appendChild(name);
        if (column.type) {
          const type = document.createElement('span');
          type.className = 'column-type';
          type.textContent = column.type;
          th.appendChild(type);
        }
        headerRow.appendChild(th);
      });
      head.appendChild(headerRow);
      table.appendChild(head);

      const body = document.createElement('tbody');
      visibleRows.forEach((row, rowIndex) => {
        const tr = document.createElement('tr');
        const numberCell = document.createElement('td');
        numberCell.className = 'row-number';
        numberCell.textContent = String(rowOffset + rowIndex + 1);
        tr.appendChild(numberCell);
        row.forEach((value, columnIndex) => {
          const td = document.createElement('td');
          td.dataset.row = String(rowIndex);
          td.dataset.column = String(columnIndex);
          if (value === null) {
            td.textContent = 'NULL';
            td.className = 'null';
          } else {
            td.textContent = String(value);
          }
          td.title = value === null ? 'NULL' : String(value);
          td.addEventListener('click', (event) => {
            if (event.shiftKey && anchorCell) {
              selectRange(anchorCell.row, rowIndex, anchorCell.column, columnIndex);
            } else {
              anchorCell = { row: rowIndex, column: columnIndex };
              selectRange(rowIndex, rowIndex, columnIndex, columnIndex);
            }
          });
          tr.appendChild(td);
        });
        body.appendChild(tr);
      });
      table.appendChild(body);
      grid.replaceChildren(table);

      const pageCount = Math.max(1, Number(set.pages || 0));
      pageInput.value = String(activePage + 1);
      pageInput.max = String(pageCount);
      pages.textContent = 'of ' + pageCount;
      prev.disabled = activePage <= 0;
      next.disabled = activePage >= pageCount - 1;
      if (visibleRows.length > 0) {
        status.textContent = 'Rows ' + (rowOffset + 1) + '–' + (rowOffset + visibleRows.length) + ' of ' + set.rowCount + (set.truncated ? ' · configured limit reached' : '');
      } else {
        status.textContent = '0 rows' + (set.truncated ? ' · configured limit reached' : '');
      }
    }
    function renderMetadata(value) {
      metadata = value;
      const parts = [];
      if (value.connectionName) parts.push(value.connectionName);
      if (value.database) parts.push(value.database);
      parts.push(rowLabel(Number(value.totalRows || 0)));
      if (Number(value.affectedRows || 0) > 0) parts.push(String(value.affectedRows) + ' affected');
      parts.push(String(Number(value.durationMs || 0)) + ' ms');
      if (value.status && value.status !== 'success') parts.push(String(value.status));
      document.getElementById('summary').textContent = parts.join(' · ');
      renderTabs();
      const firstRows = sets().findIndex((set) => set?.kind === 'rows');
      const first = firstRows >= 0 ? firstRows : sets().findIndex(Boolean);
      if (first >= 0) {
        selectSet(first);
      } else {
        toolbar.hidden = true;
        grid.replaceChildren(messageNode('Statement completed. No result set was returned.', false));
      }
    }

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'metadata') renderMetadata(message.metadata);
      else if (message.type === 'pageData') renderPage(message);
    });
    prev.addEventListener('click', () => requestPage(activePage - 1));
    next.addEventListener('click', () => requestPage(activePage + 1));
    pageInput.addEventListener('change', () => requestPage(Number(pageInput.value) - 1));
    document.getElementById('copyCell').addEventListener('click', () => {
      if (anchorCell) copyRange({ rowStart: anchorCell.row, rowEnd: anchorCell.row, columnStart: anchorCell.column, columnEnd: anchorCell.column });
    });
    document.getElementById('copyRow').addEventListener('click', () => {
      const set = currentSet();
      if (anchorCell && set?.columns?.length) {
        copyRange({ rowStart: anchorCell.row, rowEnd: anchorCell.row, columnStart: 0, columnEnd: set.columns.length - 1 });
      }
    });
    document.getElementById('copySelection').addEventListener('click', () => copyRange(selection));
    document.querySelectorAll('[data-export]').forEach((button) => {
      button.addEventListener('click', () => vscode.postMessage({ type: 'export', setIndex: activeSet, format: button.dataset.export }));
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

module.exports = {
  createResultViewHtml,
};
