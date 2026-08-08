'use strict';

const { randomUUID } = require('node:crypto');
const vscode = require('vscode');
const { getDatabaseEngine } = require('../databaseEngines');
const { DEFINITION_SCHEME, isSqlDocument } = require('../sql/sqlDocument');

function databaseForProfile(profile, preferred = '') {
  return (
    preferred ||
    profile.database ||
    profile.serviceName ||
    (profile.engine === 'sqlite' ? 'main' : '')
  );
}

function schemaForProfile(profile, database, preferred = '') {
  if (preferred) return preferred;
  if (profile.engine === 'postgresql') return 'public';
  if (profile.engine === 'sqlserver') return 'dbo';
  if (profile.engine === 'oracle') return String(profile.user || '').toUpperCase();
  if (profile.engine === 'mysql') return database || profile.database || '';
  if (profile.engine === 'sqlite') return database || 'main';
  return '';
}

class EditorSessionManager {
  constructor(connectionStore, connectionManager, editorConnectionStore) {
    this.connectionStore = connectionStore;
    this.connectionManager = connectionManager;
    this.editorConnectionStore = editorConnectionStore;
    this.sessions = new Map();
    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.statusBar.command = 'simpleDb.changeEditorConnection';
    this.statusBar.tooltip = 'Simple DB: select the connection for this SQL file';

    this.activeEditorDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
      this.refreshStatusBar();
    });
    this.transactionListener = () => this.refreshStatusBar();
    this.connectionManager.on('transaction', this.transactionListener);
    this.connectionManager.on('change', this.transactionListener);
    this.refreshStatusBar();
  }

  _key(document) {
    return document.uri.toString();
  }

  _isSqlDocument(document) {
    return isSqlDocument(document);
  }

  _canPersist(document) {
    return (
      this._isSqlDocument(document) &&
      !document.isUntitled &&
      document.uri.scheme !== 'untitled'
    );
  }

  _newSession(document, profile, options = {}) {
    const database = databaseForProfile(profile, options.database);
    const session = {
      id: randomUUID(),
      documentUri: document.uri.toString(),
      profileId: profile.id,
      database,
      schema: schemaForProfile(profile, database, options.schema),
      runningExecutionId: null,
      transactionNeedsRollback: false,
    };
    this.sessions.set(this._key(document), session);
    this.refreshStatusBar();
    return session;
  }

  async _persist(document, session) {
    if (!this.editorConnectionStore || !this._canPersist(document)) return;
    await this.editorConnectionStore.set(this._key(document), {
      profileId: session.profileId,
      database: session.database,
      schema: session.schema,
    });
  }

  _restore(document) {
    if (!this.editorConnectionStore || !this._canPersist(document)) return undefined;
    const binding = this.editorConnectionStore.get(this._key(document));
    if (!binding) return undefined;
    const profile = this.connectionStore.get(binding.profileId);
    if (!profile) {
      void this.editorConnectionStore.delete(this._key(document)).catch(() => {});
      return undefined;
    }
    return this._newSession(document, profile, {
      database: binding.database,
      schema: binding.schema,
    });
  }

  async createSession(document, profile, options = {}) {
    const session = this._newSession(document, profile, options);
    await this._persist(document, session);
    return session;
  }

  get(document) {
    if (!document) return undefined;
    return this.sessions.get(this._key(document)) || this._restore(document);
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
    const session = await this.createSession(document, profile, options);
    return { document, session };
  }

  async _pickConnection(session, document) {
    const profiles = this.connectionStore.list();
    const items = profiles.map((profile) => ({
      label:
        (profile.id === session?.profileId ? '$(check) ' : '$(database) ') +
        profile.name,
      description: getDatabaseEngine(profile.engine)?.displayName || profile.engine,
      detail: databaseForProfile(profile),
      profile,
    }));
    items.push(
      {
        label: '$(add) Create New Connection...',
        description: 'Simple DB',
        createConnection: true,
      },
      {
        label: '$(close) Cancel / Close',
        description: 'Dismiss this menu',
        cancel: true,
      },
    );
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Simple DB — Select Connection for SQL File',
      placeHolder: session
        ? 'Choose a different connection for this SQL file'
        : 'Choose the connection this SQL file should use',
      ignoreFocusOut: false,
    });
    if (!pick || pick.cancel) return null;
    if (!pick.createConnection) return pick.profile;

    const created = await vscode.commands.executeCommand('simpleDb.addConnection');
    if (!created) return null;
    if (document) {
      await vscode.window.showTextDocument(document, { preview: false });
    }
    return created;
  }

  async ensureSession(document) {
    if (!this._isSqlDocument(document)) {
      throw new Error('Open a regular SQL file before selecting a database connection.');
    }
    const existing = this.get(document);
    if (existing) return existing;

    const profile = await this._pickConnection(undefined, document);
    if (!profile) return null;
    return this.createSession(document, profile);
  }

  async ensureActiveSession() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) throw new Error('There is no active SQL editor.');
    return this.ensureSession(editor.document);
  }

  async changeActiveConnection() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this._isSqlDocument(editor.document)) return;
    const session = this.get(editor.document);
    if (session?.runningExecutionId) {
      throw new Error('Cancel or wait for the active query before changing connections.');
    }
    if (session && this.connectionManager.hasTransaction(session.profileId, session.id)) {
      throw new Error('Run COMMIT or ROLLBACK before changing the editor connection.');
    }

    const profile = await this._pickConnection(session, editor.document);
    if (!profile) return;

    if (session) {
      session.profileId = profile.id;
      session.database = databaseForProfile(profile);
      session.schema = schemaForProfile(profile, session.database);
      session.transactionNeedsRollback = false;
      await this._persist(editor.document, session);
    } else {
      await this.createSession(editor.document, profile);
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
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this._isSqlDocument(editor.document)) {
      this.statusBar.hide();
      return;
    }

    const session = this.get(editor.document);
    if (!session) {
      this.statusBar.text = '$(database) Simple DB: Select Connection';
      this.statusBar.tooltip = 'No connection is attached to this SQL file. Click to select one.';
      this.statusBar.show();
      return;
    }

    const profile = this.connectionStore.get(session.profileId);
    if (!profile) {
      this.sessions.delete(this._key(editor.document));
      this.statusBar.text = '$(warning) Simple DB: Select Connection';
      this.statusBar.tooltip = 'The connection previously attached to this SQL file no longer exists.';
      this.statusBar.show();
      return;
    }

    const engine = getDatabaseEngine(profile.engine)?.displayName || profile.engine;
    const connected = this.connectionManager.isConnected(profile.id);
    const transaction = this.connectionManager.hasTransaction(profile.id, session.id);
    const mode = session.transactionNeedsRollback
      ? 'ROLLBACK required'
      : transaction
        ? 'TX active'
        : 'Auto-commit';
    const running = session.runningExecutionId ? ' · $(sync~spin) Running' : '';
    const connectionIcon = connected ? '$(database)' : '$(circle-outline)';
    this.statusBar.text = `${connectionIcon} ${profile.name}${running}`;
    this.statusBar.tooltip = [
      `Simple DB — ${profile.name}`,
      engine,
      session.database ? `Database: ${session.database}` : '',
      session.schema ? `Schema: ${session.schema}` : '',
      connected ? `Connected · ${mode}` : `Connects on first query · ${mode}`,
      'Click to change the connection for this SQL file.',
    ].filter(Boolean).join('\n');
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
  DEFINITION_SCHEME,
  EditorSessionManager,
  databaseForProfile,
  schemaForProfile,
};
