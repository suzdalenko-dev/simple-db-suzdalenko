'use strict';

const { randomBytes } = require('node:crypto');
const vscode = require('vscode');

function nonce() {
  return randomBytes(18).toString('base64');
}

class ResultPanel {
  constructor(resultStore, exportService) {
    this.resultStore = resultStore;
    this.exportService = exportService;
    this.panel = null;
    this.executionId = null;
    this.messageDisposable = null;
    this.panelDisposable = null;
  }

  async show(executionId) {
    const previousExecutionId = this.executionId;
    this.executionId = executionId;

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'simpleDb.results',
        'Simple DB — Resultados',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      this.messageDisposable = this.panel.webview.onDidReceiveMessage((message) =>
        this._handleMessage(message),
      );
      this.panelDisposable = this.panel.onDidDispose(() => {
        this.messageDisposable?.dispose();
        this.messageDisposable = null;
        this.panelDisposable = null;
        this.panel = null;
      });
    } else {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
    }

    this.panel.webview.html = this._html(this.panel.webview, executionId);
    if (previousExecutionId && previousExecutionId !== executionId) {
      await this.resultStore.deleteExecution(previousExecutionId).catch(() => {});
    }
  }

  async _handleMessage(message) {
    if (!this.panel || !this.executionId) return;
    try {
      if (message.type === 'ready') {
        await this._sendMetadata();
        return;
      }
      if (message.type === 'page') {
        await this._sendPage(Number(message.setIndex), Number(message.pageIndex));
        return;
      }
      if (message.type === 'export') {
        const setIndex = Number(message.setIndex);
        const format = String(message.format || '').toLowerCase();
        const filename = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Simple DB — Exportando ${format.toUpperCase()}`,
            cancellable: false,
          },
          () =>
            this.exportService.chooseAndExport(
              this.executionId,
              setIndex,
              format,
            ),
        );
        if (filename) {
          vscode.window.showInformationMessage(`Simple DB: exportado a ${filename}`);
        }
        return;
      }
      if (message.type === 'copy') {
        await vscode.env.clipboard.writeText(String(message.text || ''));
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Simple DB: ${error.message}`);
    }
  }

  async _sendMetadata() {
    const metadata = this.resultStore.getMetadata(this.executionId);
    if (!metadata || !this.panel) return;
    await this.panel.webview.postMessage({ type: 'metadata', metadata });
  }

  async _sendPage(setIndex, requestedPage) {
    const metadata = this.resultStore.getMetadata(this.executionId);
    const set = metadata?.sets?.[setIndex];
    if (!set || !this.panel) return;
    const maximum = Math.max(0, set.pages - 1);
    const pageIndex = Math.min(maximum, Math.max(0, requestedPage || 0));
    const rows = await this.resultStore.getPage(this.executionId, setIndex, pageIndex);
    await this.panel.webview.postMessage({
      type: 'pageData',
      setIndex,
      pageIndex,
      rows,
    });
  }

  _html(webview, executionId) {
    const n = nonce();
    return `<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}';">
  <style nonce="${n}">
    :root { color-scheme: light dark; }
    body { padding: 0; margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    header { padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
    #summary { color: var(--vscode-descriptionForeground); }
    #tabs { display: flex; gap: 4px; padding: 8px 10px 0; flex-wrap: wrap; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 5px 9px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary, .tab { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
    .tab.active { outline: 2px solid var(--vscode-focusBorder); }
    button:disabled { opacity: .45; cursor: default; }
    #toolbar { padding: 8px 10px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; border-bottom: 1px solid var(--vscode-panel-border); }
    #status { margin-left: auto; color: var(--vscode-descriptionForeground); }
    #grid { overflow: auto; height: calc(100vh - 124px); }
    table { border-collapse: separate; border-spacing: 0; min-width: 100%; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
    th, td { border-right: 1px solid var(--vscode-panel-border); border-bottom: 1px solid var(--vscode-panel-border); padding: 4px 8px; text-align: left; white-space: pre; max-width: 700px; overflow: hidden; text-overflow: ellipsis; }
    th { position: sticky; top: 0; z-index: 1; background: var(--vscode-editorGroupHeader-tabsBackground); }
    td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
    td.selected { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .message { padding: 18px; white-space: pre-wrap; }
    .error { color: var(--vscode-errorForeground); }
    input { width: 70px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 4px; }
  </style>
</head>
<body>
  <header><strong>Simple DB</strong><span id="summary">Cargando…</span></header>
  <div id="tabs"></div>
  <div id="toolbar" hidden>
    <button id="prev" class="secondary">← Anterior</button>
    <span>Página</span><input id="page" type="number" min="1" value="1"><span id="pages"></span>
    <button id="next" class="secondary">Siguiente →</button>
    <button id="copyCell" class="secondary">Copiar celda</button><button id="copyRow" class="secondary">Copiar fila</button><button id="copySelection" class="secondary">Copiar selección</button>
    <button data-export="csv">CSV</button><button data-export="json">JSON</button><button data-export="xlsx">XLSX</button>
    <span id="status"></span>
  </div>
  <div id="grid"><div class="message">Cargando resultados…</div></div>
  <script nonce="${n}">
    const vscode = acquireVsCodeApi();
    const executionId = ${JSON.stringify(executionId)};
    let metadata = null;
    let activeSet = 0;
    let activePage = 0;
    let visibleRows = [];
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

    function currentSet() { return metadata?.sets?.[activeSet]; }
    function requestPage(pageIndex) { vscode.postMessage({ type: 'page', setIndex: activeSet, pageIndex }); }
    function selectSet(index) {
      activeSet = index;
      activePage = 0;
      renderTabs();
      const set = currentSet();
      if (!set) return;
      if (set.kind === 'rows') { toolbar.hidden = false; requestPage(0); }
      else { toolbar.hidden = true; grid.replaceChildren(messageNode(set.message || 'Sentencia ejecutada.', set.kind === 'error')); }
    }
    function messageNode(text, error) {
      const div = document.createElement('div'); div.className = 'message' + (error ? ' error' : ''); div.textContent = text; return div;
    }
    function selectRange(rowStart, rowEnd, columnStart, columnEnd) {
      selection = {
        rowStart: Math.min(rowStart, rowEnd), rowEnd: Math.max(rowStart, rowEnd),
        columnStart: Math.min(columnStart, columnEnd), columnEnd: Math.max(columnStart, columnEnd)
      };
      grid.querySelectorAll('td[data-row]').forEach((cell) => {
        const row = Number(cell.dataset.row); const column = Number(cell.dataset.column);
        cell.classList.toggle('selected', row >= selection.rowStart && row <= selection.rowEnd && column >= selection.columnStart && column <= selection.columnEnd);
      });
    }
    function cellText(value) { return value === null || value === undefined ? 'NULL' : String(value); }
    function copyRange(range) {
      if (!range) return;
      const lines = [];
      for (let row = range.rowStart; row <= range.rowEnd; row += 1) {
        const values = [];
        for (let column = range.columnStart; column <= range.columnEnd; column += 1) values.push(cellText(visibleRows[row]?.[column]));
        lines.push(values.join('\t'));
      }
      vscode.postMessage({ type: 'copy', text: lines.join('\n') });
    }
    function renderTabs() {
      tabs.replaceChildren();
      (metadata?.sets || []).forEach((set, index) => {
        if (!set) return;
        const button = document.createElement('button');
        button.className = 'tab' + (index === activeSet ? ' active' : '');
        button.textContent = set.kind === 'rows' ? 'Resultado ' + (index + 1) + ' (' + set.rowCount + ')' : 'Mensaje ' + (index + 1);
        button.addEventListener('click', () => selectSet(index)); tabs.appendChild(button);
      });
    }
    function renderPage(data) {
      if (data.setIndex !== activeSet) return;
      activePage = data.pageIndex;
      visibleRows = data.rows;
      anchorCell = null;
      selection = null;
      const set = currentSet(); if (!set) return;
      const table = document.createElement('table');
      const head = document.createElement('thead'); const headerRow = document.createElement('tr');
      set.columns.forEach((column) => { const th = document.createElement('th'); th.textContent = column.name + (column.type ? '  ·  ' + column.type : ''); headerRow.appendChild(th); });
      head.appendChild(headerRow); table.appendChild(head);
      const body = document.createElement('tbody');
      data.rows.forEach((row, rowIndex) => { const tr = document.createElement('tr'); row.forEach((value, columnIndex) => { const td = document.createElement('td'); td.dataset.row = String(rowIndex); td.dataset.column = String(columnIndex); if (value === null) { td.textContent = 'NULL'; td.className = 'null'; } else td.textContent = String(value); td.title = value === null ? 'NULL' : String(value); td.addEventListener('click', (event) => { if (event.shiftKey && anchorCell) selectRange(anchorCell.row, rowIndex, anchorCell.column, columnIndex); else { anchorCell = { row: rowIndex, column: columnIndex }; selectRange(rowIndex, rowIndex, columnIndex, columnIndex); } }); tr.appendChild(td); }); body.appendChild(tr); });
      table.appendChild(body); grid.replaceChildren(table);
      const pageCount = Math.max(1, set.pages); pageInput.value = String(activePage + 1); pageInput.max = String(pageCount); pages.textContent = 'de ' + pageCount;
      prev.disabled = activePage <= 0; next.disabled = activePage >= pageCount - 1;
      status.textContent = set.rowCount + ' filas' + (set.truncated ? ' · límite configurado alcanzado' : '');
    }
    function renderMetadata(value) {
      metadata = value;
      document.getElementById('summary').textContent = (value.connectionName || '') + ' · ' + (value.database || '') + ' · ' + (value.totalRows || 0) + ' filas' + (value.affectedRows ? ' · ' + value.affectedRows + ' afectadas' : '') + ' · ' + value.durationMs + ' ms · ' + value.status;
      renderTabs();
      const firstRows = value.sets.findIndex((set) => set?.kind === 'rows');
      const first = firstRows >= 0 ? firstRows : value.sets.findIndex(Boolean);
      if (first >= 0) selectSet(first); else { toolbar.hidden = true; grid.replaceChildren(messageNode('Sin resultados.', false)); }
    }
    window.addEventListener('message', (event) => { const message = event.data; if (message.type === 'metadata') renderMetadata(message.metadata); else if (message.type === 'pageData') renderPage(message); });
    prev.addEventListener('click', () => requestPage(activePage - 1)); next.addEventListener('click', () => requestPage(activePage + 1));
    pageInput.addEventListener('change', () => requestPage(Number(pageInput.value) - 1));
    document.getElementById('copyCell').addEventListener('click', () => { if (anchorCell) copyRange({ rowStart: anchorCell.row, rowEnd: anchorCell.row, columnStart: anchorCell.column, columnEnd: anchorCell.column }); });
    document.getElementById('copyRow').addEventListener('click', () => { const set = currentSet(); if (anchorCell && set?.columns?.length) copyRange({ rowStart: anchorCell.row, rowEnd: anchorCell.row, columnStart: 0, columnEnd: set.columns.length - 1 }); });
    document.getElementById('copySelection').addEventListener('click', () => copyRange(selection));
    document.querySelectorAll('[data-export]').forEach((button) => button.addEventListener('click', () => vscode.postMessage({ type: 'export', setIndex: activeSet, format: button.dataset.export })));
    vscode.postMessage({ type: 'ready', executionId });
  </script>
</body>
</html>`;
  }

  dispose() {
    this.messageDisposable?.dispose();
    this.panelDisposable?.dispose();
    this.panel?.dispose();
    this.messageDisposable = null;
    this.panelDisposable = null;
    this.panel = null;
  }
}

module.exports = {
  ResultPanel,
};
