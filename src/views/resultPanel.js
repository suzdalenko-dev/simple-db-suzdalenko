'use strict';

const { randomBytes } = require('node:crypto');
const vscode = require('vscode');
const { createResultViewHtml } = require('./resultViewHtml');

const RESULT_VIEW_ID = 'simpleDb.results';

function nonce() {
  return randomBytes(18).toString('base64');
}

class ResultPanel {
  constructor(resultStore, exportService) {
    this.resultStore = resultStore;
    this.exportService = exportService;
    this.view = null;
    this.executionId = null;
    this.viewDisposables = [];
  }

  resolveWebviewView(webviewView) {
    this._disposeViewBindings();
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = createResultViewHtml(nonce());

    const messageDisposable = webviewView.webview.onDidReceiveMessage((message) =>
      this._handleMessage(message),
    );
    const visibilityDisposable = webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this.executionId) {
        this._sendMetadata().catch(() => {});
      }
    });
    const disposeDisposable = webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = null;
    });
    this.viewDisposables = [
      messageDisposable,
      visibilityDisposable,
      disposeDisposable,
    ];
  }

  async show(executionId) {
    const previousExecutionId = this.executionId;
    this.executionId = executionId;

    if (this.view) {
      this.view.show(true);
    } else {
      await vscode.commands.executeCommand(`${RESULT_VIEW_ID}.focus`, {
        preserveFocus: true,
      });
      this.view?.show(true);
    }

    await this._sendMetadata();
    if (previousExecutionId && previousExecutionId !== executionId) {
      await this.resultStore.deleteExecution(previousExecutionId).catch(() => {});
    }
  }

  async _handleMessage(message) {
    if (!this.view || !this.executionId) return;
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
            title: `Simple DB — Exporting ${format.toUpperCase()}`,
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
          vscode.window.showInformationMessage(`Simple DB: exported to ${filename}`);
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
    if (!metadata || !this.view) return;
    await this.view.webview.postMessage({ type: 'metadata', metadata });
  }

  async _sendPage(setIndex, requestedPage) {
    const metadata = this.resultStore.getMetadata(this.executionId);
    const set = metadata?.sets?.[setIndex];
    if (!set || !this.view) return;
    const maximum = Math.max(0, set.pages - 1);
    const pageIndex = Math.min(maximum, Math.max(0, requestedPage || 0));
    const rows = await this.resultStore.getPage(this.executionId, setIndex, pageIndex);
    await this.view.webview.postMessage({
      type: 'pageData',
      setIndex,
      pageIndex,
      rowOffset: pageIndex * this.resultStore.pageSize,
      rows,
    });
  }

  _disposeViewBindings() {
    for (const disposable of this.viewDisposables) disposable.dispose();
    this.viewDisposables = [];
  }

  dispose() {
    this._disposeViewBindings();
    this.view = null;
    this.executionId = null;
  }
}

module.exports = {
  RESULT_VIEW_ID,
  ResultPanel,
};
