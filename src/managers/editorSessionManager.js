'use strict';

const { randomUUID } = require('node:crypto');
const vscode = require('vscode');
const { getDatabaseEngine } = require('../databaseEngines');

class EditorSessionManager {
  constructor(connectionStore, connectionManager) {
    this.connectionStore = connectionStore;
    this.connectionManager = connectionManager;
    this.sessions = new Map();
    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.statusBar.command = 'simpleDb.changeEditorConnection';
    this.statusBar.tooltip = 'Simple DB: cambiar la conexión del editor SQL';

    this.activeEditorDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
      this.refreshStatusBar();
    });
    this.transactionListener = () => this.refreshStatusBar();
    this.connectionManager.on('transaction', this.transactionListener);
    this.connectionManager.on('change', this.transactionListener);
  }

  _key(document) {
    return document.uri.toString();
  }

  createSession(document, profile, options = {}) {
    const session = {
      id: randomUUID(),
      documentUri: document.uri.toString(),
      profileId: profile.id,
      database:
        options.database ||
        profile.database ||
        profile.serviceName ||
        (profile.engine === 'sqlite' ? 'main' : ''),
      schema: options.schema || '',
      runningExecutionId: null,
      transactionNeedsRollback: false,
    };
    this.sessions.set(this._key(document), session);
    this.refreshStatusBar();
    return session;
  }

  get(document) {
    return document ? this.sessions.get(this._key(document)) : undefined;
  }

  getActive() {
    return this.get(vscode.window.activeTextEditor?.document);
  }

  detach(document) {
    const key = this._key(document);
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    this.refreshStatusBar();
    return session;
  }

  async createQuery(profile, initialSql = '', options = {}) {
    const heading = options.includeHeading === false
      ? ''
      : `-- Simple DB | ${getDatabaseEngine(profile.engine)?.displayName || profile.engine} | ${profile.name}\n\n`;
    const document = await vscode.workspace.openTextDocument({
      language: 'sql',
      content: `${heading}${initialSql}`,
    });
    await vscode.window.showTextDocument(document, { preview: false });
    const session = this.createSession(document, profile, options);
    return { document, session };
  }

  async ensureActiveSession() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      throw new Error('No hay un editor SQL activo.');
    }
    const existing = this.get(editor.document);
    if (existing) {
      return existing;
    }

    const profiles = this.connectionStore.list();
    if (!profiles.length) {
      throw new Error('Primero debes crear una conexión en Simple DB.');
    }
    const pick = await vscode.window.showQuickPick(
      profiles.map((profile) => ({
        label: `$(database) ${profile.name}`,
        description: getDatabaseEngine(profile.engine)?.displayName || profile.engine,
        profile,
      })),
      {
        title: 'Simple DB — Vincular editor a una conexión',
        placeHolder: 'Selecciona la conexión para este editor SQL',
      },
    );
    if (!pick) {
      return null;
    }
    return this.createSession(editor.document, pick.profile);
  }

  async changeActiveConnection() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const session = this.get(editor.document);
    if (session?.runningExecutionId) {
      throw new Error('Cancela o espera a que termine la consulta antes de cambiar de conexión.');
    }
    if (session && this.connectionManager.hasTransaction(session.profileId, session.id)) {
      throw new Error('Haz COMMIT o ROLLBACK antes de cambiar la conexión del editor.');
    }

    const profiles = this.connectionStore.list();
    const pick = await vscode.window.showQuickPick(
      profiles.map((profile) => ({
        label: profile.name,
        description: getDatabaseEngine(profile.engine)?.displayName || profile.engine,
        profile,
      })),
      { title: 'Simple DB — Cambiar conexión del editor' },
    );
    if (!pick) {
      return;
    }

    if (session) {
      session.profileId = pick.profile.id;
      session.database =
        pick.profile.database ||
        pick.profile.serviceName ||
        (pick.profile.engine === 'sqlite' ? 'main' : '');
      session.schema = '';
      session.transactionNeedsRollback = false;
    } else {
      this.createSession(editor.document, pick.profile);
    }
    this.refreshStatusBar();
  }

  setRunning(session, executionId) {
    session.runningExecutionId = executionId;
    this.refreshStatusBar();
  }

  markTransactionNeedsRollback(session, value = true) {
    session.transactionNeedsRollback = value;
    this.refreshStatusBar();
  }

  refreshStatusBar() {
    const session = this.getActive();
    if (!session) {
      this.statusBar.hide();
      return;
    }
    const profile = this.connectionStore.get(session.profileId);
    if (!profile) {
      this.statusBar.text = '$(warning) Simple DB | conexión eliminada';
      this.statusBar.show();
      return;
    }

    const engine = getDatabaseEngine(profile.engine)?.displayName || profile.engine;
    const connected = this.connectionManager.isConnected(profile.id);
    const transaction = this.connectionManager.hasTransaction(profile.id, session.id);
    const mode = session.transactionNeedsRollback
      ? 'TX requiere ROLLBACK'
      : transaction
        ? 'TX activa'
        : 'Auto-commit';
    const running = session.runningExecutionId ? ' | $(sync~spin) Ejecutando' : '';
    const connectionIcon = connected ? '$(database)' : '$(circle-slash)';
    this.statusBar.text = `${connectionIcon} ${engine} | ${profile.name} | ${session.database || '-'} | ${mode}${running}`;
    this.statusBar.show();
  }

  dispose() {
    this.activeEditorDisposable.dispose();
    this.connectionManager.off('transaction', this.transactionListener);
    this.connectionManager.off('change', this.transactionListener);
    this.statusBar.dispose();
    this.sessions.clear();
  }
}

module.exports = {
  EditorSessionManager,
};
