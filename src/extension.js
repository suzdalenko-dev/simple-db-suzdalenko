'use strict';

const path = require('node:path');
const vscode = require('vscode');
const { ConnectionManager } = require('./managers/connectionManager');
const { EditorSessionManager } = require('./managers/editorSessionManager');
const { QueryRunner } = require('./services/queryRunner');
const { ExportService } = require('./services/exportService');
const {
  OBJECT_LABELS,
  alterTemplate,
  createTemplate,
  dropTemplate,
  objectTypesForEngine,
} = require('./sql/ddlTemplates');
const { ConnectionStore } = require('./storage/connectionStore');
const { HistoryStore } = require('./storage/historyStore');
const { ResultStore } = require('./storage/resultStore');
const { promptConnection, promptPassword } = require('./ui/connectionForm');
const { ConnectionsTreeProvider } = require('./views/connectionsTreeProvider');
const { HistoryTreeProvider } = require('./views/historyTreeProvider');
const { RESULT_VIEW_ID, ResultPanel } = require('./views/resultPanel');
const { getDatabaseEngine } = require('./databaseEngines');

let runtime = null;

function historyConfiguration() {
  const config = vscode.workspace.getConfiguration('simpleDb');
  return {
    enabled: config.get('history.enabled', true),
    maxEntries: Math.max(0, Number(config.get('history.maxEntries', 500))),
  };
}

function exportConfiguration() {
  const config = vscode.workspace.getConfiguration('simpleDb');
  return {
    csvDelimiter: config.get('csvDelimiter', ';'),
    csvProtectFormulaInjection: config.get('csvProtectFormulaInjection', true),
  };
}

function profileForNode(connectionStore, node) {
  return node?.profileId ? connectionStore.get(node.profileId) : null;
}

async function pickProfile(connectionStore, title = 'Simple DB — Select Connection') {
  const profiles = connectionStore.list();
  if (!profiles.length) {
    throw new Error('No connections are configured. Create a connection first.');
  }
  const pick = await vscode.window.showQuickPick(
    profiles.map((profile) => ({
      label: `$(database) ${profile.name}`,
      description: getDatabaseEngine(profile.engine)?.displayName || profile.engine,
      profile,
    })),
    { title, ignoreFocusOut: true },
  );
  return pick?.profile || null;
}

function databaseContext(profile, node) {
  return (
    node?.database ||
    profile.database ||
    profile.serviceName ||
    (profile.engine === 'sqlite' ? 'main' : '')
  );
}

function schemaContext(profile, node, database) {
  if (node?.schema) return node.schema;
  if (profile.engine === 'postgresql') return 'public';
  if (profile.engine === 'sqlserver') return 'dbo';
  if (profile.engine === 'oracle') return '';
  if (profile.engine === 'sqlite' || profile.engine === 'mysql') return database;
  return '';
}

function groupObjectType(groupType) {
  return {
    tables: 'table',
    views: 'view',
    materializedViews: 'materializedView',
    indexes: 'index',
    triggers: 'trigger',
    sequences: 'sequence',
    packages: 'package',
    types: 'type',
    synonyms: 'synonym',
    events: 'event',
  }[groupType];
}

function effectiveObjectType(node) {
  if (node?.objectType === 'procedure') {
    return String(node.type || '').toUpperCase() === 'FUNCTION'
      ? 'function'
      : 'procedure';
  }
  return node?.objectType;
}

function ddlQualifiedName(connectionManager, profile, database, schema, name) {
  return connectionManager.quoteTable(
    profile.id,
    profile.engine === 'sqlserver' ? null : database,
    schema,
    name,
  );
}

function registerCommand(context, commandId, handler) {
  const disposable = vscode.commands.registerCommand(commandId, async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      vscode.window.showErrorMessage(`Simple DB: ${error.message}`);
      return undefined;
    }
  });
  context.subscriptions.push(disposable);
}

async function activate(context) {
  const connectionStore = new ConnectionStore(context.globalState, context.secrets, {
    directoryPath: path.join(context.globalStorageUri.fsPath, 'connections'),
  });
  const connectionLoad = await connectionStore.initialize();
  if (connectionLoad.errors.length > 0) {
    vscode.window.showWarningMessage(
      `Simple DB: ${connectionLoad.errors.length} connection JSON file(s) could not be loaded. Open the Connections folder to review them.`,
    );
  }
  const connectionManager = new ConnectionManager(connectionStore);
  const editorSessionManager = new EditorSessionManager(
    connectionStore,
    connectionManager,
  );
  const historyStore = new HistoryStore(context.globalState, historyConfiguration);
  const config = vscode.workspace.getConfiguration('simpleDb');
  const resultStore = new ResultStore(
    path.join(context.globalStorageUri.fsPath, 'results'),
    {
      pageSize: config.get('resultPageSize', 500),
      maxCellCharacters: config.get('maxCellCharacters', 10000),
    },
  );
  await resultStore.initialize();
  const exportService = new ExportService(resultStore, exportConfiguration);
  const resultPanel = new ResultPanel(resultStore, exportService);
  const resultViewRegistration = vscode.window.registerWebviewViewProvider(
    RESULT_VIEW_ID,
    resultPanel,
    { webviewOptions: { retainContextWhenHidden: true } },
  );
  const queryRunner = new QueryRunner({
    connectionStore,
    connectionManager,
    editorSessionManager,
    resultStore,
    resultPanel,
    historyStore,
  });
  const connectionsProvider = new ConnectionsTreeProvider(
    connectionStore,
    connectionManager,
  );
  const historyProvider = new HistoryTreeProvider(historyStore);

  const connectionsView = vscode.window.createTreeView('simpleDb.connections', {
    treeDataProvider: connectionsProvider,
    showCollapseAll: true,
  });
  const historyView = vscode.window.createTreeView('simpleDb.history', {
    treeDataProvider: historyProvider,
  });
  context.subscriptions.push(
    connectionsView,
    historyView,
    resultViewRegistration,
    connectionsProvider,
    historyProvider,
    editorSessionManager,
  );

  registerCommand(context, 'simpleDb.addConnection', async (node) => {
    const form = await promptConnection({ engineId: node?.engineId });
    if (!form) return;
    const saved = await connectionStore.save(form.profile, form.password);
    connectionsProvider.refresh();
    const filePath = connectionStore.connectionFile(saved.id);
    const document = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(document, { preview: false });
    vscode.window.showInformationMessage(
      `Simple DB: "${saved.name}" created. Edit the JSON, press Ctrl+S, then test or connect.`,
    );
  });

  registerCommand(context, 'simpleDb.refreshConnections', async () => {
    const hasActiveConnection = connectionStore
      .list()
      .some((profile) => connectionManager.isConnected(profile.id));
    if (!hasActiveConnection) {
      const result = await connectionStore.reload();
      if (result.errors.length > 0) {
        vscode.window.showWarningMessage(
          `Simple DB: ${result.errors.length} connection JSON file(s) could not be loaded.`,
        );
      }
    }
    connectionsProvider.refresh();
  });

  registerCommand(context, 'simpleDb.connect', async (node) => {
    const profile = profileForNode(connectionStore, node);
    if (!profile) throw new Error('Connection not found.');
    const adapter = await connectionManager.connect(profile.id);
    vscode.window.showInformationMessage(
      `Simple DB: connected to ${profile.name} · ${adapter.serverVersion}`,
    );
  });

  registerCommand(context, 'simpleDb.disconnect', async (node) => {
    const profile = profileForNode(connectionStore, node);
    if (!profile) throw new Error('Connection not found.');
    const transactionCount = connectionManager.transactionCount(profile.id);
    const executionCount = connectionManager.executionCount(profile.id);
    if (transactionCount > 0 || executionCount > 0) {
      const details = [
        executionCount > 0 ? `${executionCount} active query/queries` : '',
        transactionCount > 0 ? `${transactionCount} active transaction(s)` : '',
      ].filter(Boolean).join(' and ');
      const answer = await vscode.window.showWarningMessage(
        `There are ${details}. Disconnecting will cancel queries and ROLLBACK transactions.`,
        { modal: true },
        'Cancel queries, ROLLBACK, and disconnect',
      );
      if (!answer) return;
    }
    await connectionManager.disconnect(profile.id);
  });

  registerCommand(context, 'simpleDb.testConnection', async (node) => {
    const profile = profileForNode(connectionStore, node) || (await pickProfile(connectionStore));
    if (!profile) throw new Error('Connection not found.');
    const result = await connectionManager.testConnection(profile.id);
    vscode.window.showInformationMessage(
      `Simple DB: ${profile.name} responded in ${result.elapsedMs} ms · ${result.serverVersion}`,
    );
  });

  registerCommand(context, 'simpleDb.editConnection', async (node) => {
    const profile = profileForNode(connectionStore, node);
    if (!profile) throw new Error('Connection not found.');
    if (connectionManager.isConnected(profile.id)) {
      const transactions = connectionManager.transactionCount(profile.id);
      const executions = connectionManager.executionCount(profile.id);
      const text = transactions > 0 || executions > 0
        ? `Editing requires disconnecting: ${executions} query/queries will be cancelled and ${transactions} transaction(s) will be rolled back.`
        : 'Editing requires disconnecting the active connection.';
      const answer = await vscode.window.showWarningMessage(
        text,
        { modal: true },
        transactions > 0 || executions > 0
          ? 'Disconnect, cancel queries, and ROLLBACK'
          : 'Disconnect and edit',
      );
      if (!answer) return;
      await connectionManager.disconnect(profile.id);
    }
    const filePath = connectionStore.connectionFile(profile.id);
    if (!filePath) throw new Error('Connection JSON file not found.');
    const document = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(document, { preview: false });
  });

  registerCommand(context, 'simpleDb.setPassword', async (node) => {
    const profile = profileForNode(connectionStore, node) || (await pickProfile(connectionStore));
    if (!profile) return;
    if (profile.engine === 'sqlite') {
      vscode.window.showInformationMessage('Simple DB: SQLite connections do not use a password.');
      return;
    }
    const password = await promptPassword(profile);
    if (password === undefined) return;
    await connectionStore.setPassword(profile.id, password);
    vscode.window.showInformationMessage(
      `Simple DB: password for "${profile.name}" stored securely.`,
    );
  });

  registerCommand(context, 'simpleDb.openConnectionsFolder', async () => {
    await vscode.commands.executeCommand(
      'revealFileInOS',
      vscode.Uri.file(connectionStore.connectionDirectory()),
    );
  });

  registerCommand(context, 'simpleDb.deleteConnection', async (node) => {
    const profile = profileForNode(connectionStore, node);
    if (!profile) throw new Error('Connection not found.');
    const transactions = connectionManager.transactionCount(profile.id);
    const executions = connectionManager.executionCount(profile.id);
    const warning = transactions > 0 || executions > 0
      ? ` ${executions} query/queries will be cancelled and ${transactions} active transaction(s) will be rolled back.`
      : '';
    const answer = await vscode.window.showWarningMessage(
      `Delete connection "${profile.name}"?${warning}`,
      { modal: true },
      'Delete',
    );
    if (answer !== 'Delete') return;
    await connectionManager.disconnect(profile.id);
    await connectionStore.delete(profile.id);
    connectionsProvider.refresh();
  });

  registerCommand(context, 'simpleDb.newQuery', async (node) => {
    const profile = profileForNode(connectionStore, node) || (await pickProfile(connectionStore));
    if (!profile) return;
    const database = databaseContext(profile, node);
    const schema = schemaContext(profile, node, database);
    await editorSessionManager.createQuery(profile, '', { database, schema });
  });

  registerCommand(context, 'simpleDb.changeEditorConnection', () =>
    editorSessionManager.changeActiveConnection(),
  );

  registerCommand(context, 'simpleDb.executeCurrent', () => queryRunner.run('current'));
  registerCommand(context, 'simpleDb.executeSelection', () =>
    queryRunner.run('selection'),
  );
  registerCommand(context, 'simpleDb.executeDocument', () => queryRunner.run('document'));

  registerCommand(context, 'simpleDb.cancelQuery', async () => {
    const session = editorSessionManager.getActive();
    if (!session?.runningExecutionId) {
      vscode.window.showInformationMessage('Simple DB: there is no active query to cancel.');
      return;
    }
    await connectionManager.cancel(session.profileId, session.runningExecutionId);
  });

  registerCommand(context, 'simpleDb.beginTransaction', async () => {
    const session = await editorSessionManager.ensureActiveSession();
    if (!session) return;
    if (session.runningExecutionId) {
      throw new Error('Wait for or cancel the active query before starting a transaction.');
    }
    if (connectionManager.hasTransaction(session.profileId, session.id)) {
      throw new Error('This editor already has an active transaction.');
    }
    await connectionManager.begin(session.profileId, session.id, {
      database: session.database,
      schema: session.schema,
    });
    editorSessionManager.markTransactionNeedsRollback(session, false);
    vscode.window.showInformationMessage('Simple DB: transaction started.');
  });

  registerCommand(context, 'simpleDb.commit', async () => {
    const session = await editorSessionManager.ensureActiveSession();
    if (!session) return;
    if (session.runningExecutionId) {
      throw new Error('Wait for or cancel the active query before COMMIT.');
    }
    if (session.transactionNeedsRollback) {
      throw new Error('The transaction encountered an error. Run ROLLBACK before continuing.');
    }
    await connectionManager.commit(session.profileId, session.id);
    editorSessionManager.markTransactionNeedsRollback(session, false);
    vscode.window.showInformationMessage('Simple DB: COMMIT completed.');
  });

  registerCommand(context, 'simpleDb.rollback', async () => {
    const session = await editorSessionManager.ensureActiveSession();
    if (!session) return;
    if (session.runningExecutionId) {
      throw new Error('Cancel or wait for the active query before ROLLBACK.');
    }
    await connectionManager.rollback(session.profileId, session.id);
    editorSessionManager.markTransactionNeedsRollback(session, false);
    vscode.window.showInformationMessage('Simple DB: ROLLBACK completed.');
  });

  registerCommand(context, 'simpleDb.selectTable', async (node) => {
    if (node?.kind !== 'object' || !['table', 'view', 'materializedView'].includes(node.objectType)) {
      throw new Error('Select a table or view in the explorer.');
    }
    const profile = profileForNode(connectionStore, node);
    await connectionManager.ensureConnected(profile.id);
    const qualified = connectionManager.quoteTable(
      profile.id,
      node.database,
      node.schema,
      node.name,
    );
    await editorSessionManager.createQuery(profile, `SELECT * FROM ${qualified};`, {
      database: node.database,
      schema: node.schema,
    });
  });

  registerCommand(context, 'simpleDb.showDefinition', async (node) => {
    if (node?.kind !== 'object') throw new Error('Select a database object.');
    const profile = profileForNode(connectionStore, node);
    await connectionManager.ensureConnected(profile.id);
    const definition = await connectionManager.getObjectDefinition(
      profile.id,
      node.database,
      node.schema,
      node.name,
      node.objectType,
      node,
    );
    if (!definition) {
      vscode.window.showWarningMessage(
        `Simple DB: the server did not return a definition for ${node.name}.`,
      );
      return;
    }
    await editorSessionManager.createQuery(profile, definition, {
      database: node.database,
      schema: node.schema,
    });
  });

  registerCommand(context, 'simpleDb.createObject', async (node) => {
    const profile = profileForNode(connectionStore, node) || (await pickProfile(connectionStore));
    if (!profile) return;
    await connectionManager.ensureConnected(profile.id);
    const database = databaseContext(profile, node);
    const schema = schemaContext(profile, node, database);
    let objectType = groupObjectType(node?.groupType);
    if (!objectType) {
      const types = objectTypesForEngine(profile.engine);
      const pick = await vscode.window.showQuickPick(
        types.map((type) => ({ label: OBJECT_LABELS[type] || type, type })),
        { title: `Simple DB — Create Object in ${profile.name}` },
      );
      objectType = pick?.type;
    } else if (node?.groupType === 'procedures') {
      objectType = undefined;
    }
    if (!objectType && node?.groupType === 'procedures') {
      const routine = await vscode.window.showQuickPick(
        [
          { label: 'Procedure', type: 'procedure' },
          { label: 'Function', type: 'function' },
        ],
        { title: `Simple DB — Create Routine in ${profile.name}` },
      );
      objectType = routine?.type;
    }
    if (!objectType) return;

    const name = await vscode.window.showInputBox({
      title: `Simple DB — Create ${OBJECT_LABELS[objectType] || objectType}`,
      prompt: 'New object name',
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? null : 'Name is required.'),
    });
    if (!name) return;
    const qualified = ddlQualifiedName(
      connectionManager,
      profile,
      database,
      schema,
      name.trim(),
    );
    const template = createTemplate(
      profile.engine,
      objectType,
      qualified,
      (identifier) => connectionManager.quoteIdentifier(profile.id, identifier),
      {
        identifierName: connectionManager.quoteIdentifier(profile.id, name.trim()),
      },
    );
    await editorSessionManager.createQuery(profile, template, { database, schema });
  });

  registerCommand(context, 'simpleDb.alterObject', async (node) => {
    if (node?.kind !== 'object') throw new Error('Select a database object.');
    const profile = profileForNode(connectionStore, node);
    await connectionManager.ensureConnected(profile.id);
    const objectType = effectiveObjectType(node);
    let qualified = ddlQualifiedName(
      connectionManager,
      profile,
      node.database,
      node.schema,
      node.name,
    );
    if (
      profile.engine === 'postgresql' &&
      ['procedure', 'function'].includes(objectType) &&
      node.signature !== undefined
    ) {
      qualified += `(${node.signature})`;
    }
    const tableQualifiedName = node.tableName
      ? ddlQualifiedName(
          connectionManager,
          profile,
          node.database,
          node.schema,
          node.tableName,
        )
      : '';
    const template = alterTemplate(profile.engine, objectType, qualified, {
      tableQualifiedName,
      identifierName: connectionManager.quoteIdentifier(profile.id, node.name),
    });
    await editorSessionManager.createQuery(profile, template, {
      database: node.database,
      schema: node.schema,
    });
  });

  registerCommand(context, 'simpleDb.dropObjectScript', async (node) => {
    if (node?.kind !== 'object') throw new Error('Select a database object.');
    const profile = profileForNode(connectionStore, node);
    await connectionManager.ensureConnected(profile.id);
    const objectType = effectiveObjectType(node);
    let qualified = ddlQualifiedName(
      connectionManager,
      profile,
      node.database,
      node.schema,
      node.name,
    );
    if (
      profile.engine === 'postgresql' &&
      ['procedure', 'function'].includes(objectType) &&
      node.signature !== undefined
    ) {
      qualified += `(${node.signature})`;
    }
    const tableQualifiedName = node.tableName
      ? ddlQualifiedName(
          connectionManager,
          profile,
          node.database,
          node.schema,
          node.tableName,
        )
      : '';
    const script = dropTemplate(profile.engine, objectType, qualified, {
      tableQualifiedName,
      identifierName: connectionManager.quoteIdentifier(profile.id, node.name),
      objectName: node.name,
      isConstraint: Boolean(node.isPrimaryKey || node.isUniqueConstraint),
      constraintName: node.constraintName
        ? connectionManager.quoteIdentifier(profile.id, node.constraintName)
        : '',
    });
    await editorSessionManager.createQuery(profile, script, {
      database: node.database,
      schema: node.schema,
    });
  });

  registerCommand(context, 'simpleDb.copyQualifiedName', async (node) => {
    if (node?.kind !== 'object') throw new Error('Select a database object.');
    const profile = profileForNode(connectionStore, node);
    await connectionManager.ensureConnected(profile.id);
    const qualified = connectionManager.quoteTable(
      profile.id,
      node.database,
      node.schema,
      node.name,
    );
    await vscode.env.clipboard.writeText(qualified);
  });

  registerCommand(context, 'simpleDb.showHistory', () =>
    vscode.commands.executeCommand('simpleDb.history.focus'),
  );

  registerCommand(context, 'simpleDb.clearHistory', async () => {
    if (!historyStore.list().length) return;
    const answer = await vscode.window.showWarningMessage(
      'Clear all local Simple DB query history?',
      { modal: true },
      'Clear History',
    );
    if (answer === 'Clear History') await historyStore.clear();
  });

  const historyEntry = (node) => node?.entry || historyStore.get(node?.id);

  registerCommand(context, 'simpleDb.openHistoryEntry', async (node) => {
    const entry = historyEntry(node);
    if (!entry) throw new Error('The history entry no longer exists.');
    const profile = connectionStore.get(entry.profileId);
    if (!profile) throw new Error('The connection associated with this query no longer exists.');
    await editorSessionManager.createQuery(profile, entry.sql, {
      database: entry.database,
      schema: entry.schema,
    });
  });

  registerCommand(context, 'simpleDb.copyHistoryEntry', async (node) => {
    const entry = historyEntry(node);
    if (!entry) throw new Error('The history entry no longer exists.');
    await vscode.env.clipboard.writeText(entry.sql);
  });

  registerCommand(context, 'simpleDb.rerunHistoryEntry', async (node) => {
    const entry = historyEntry(node);
    if (!entry) throw new Error('The history entry no longer exists.');
    const profile = connectionStore.get(entry.profileId);
    if (!profile) throw new Error('The connection associated with this query no longer exists.');
    await editorSessionManager.createQuery(profile, entry.sql, {
      database: entry.database,
      schema: entry.schema,
    });
    await queryRunner.run('document');
  });

  registerCommand(context, 'simpleDb.deleteHistoryEntry', async (node) => {
    const entry = historyEntry(node);
    if (entry) await historyStore.delete(entry.id);
  });

  const connectionFileSaveDisposable = vscode.workspace.onDidSaveTextDocument(
    async (document) => {
      const filePath = document.uri.fsPath;
      if (!connectionStore.isConnectionFile(filePath)) return;
      try {
        const profileId = connectionStore.profileIdForFile(filePath);
        if (profileId && connectionManager.isConnected(profileId)) {
          const transactions = connectionManager.transactionCount(profileId);
          const executions = connectionManager.executionCount(profileId);
          if (transactions > 0 || executions > 0) {
            vscode.window.showWarningMessage(
              'Simple DB: connection settings were saved on disk but cannot be applied while queries or transactions are active. Disconnect, then refresh Connections.',
            );
            return;
          }
          await connectionManager.disconnect(profileId);
        }
        const saved = await connectionStore.reloadFile(filePath);
        connectionsProvider.refresh();
        vscode.window.showInformationMessage(
          `Simple DB: connection "${saved.name}" updated from JSON.`,
        );
      } catch (error) {
        vscode.window.showErrorMessage(
          `Simple DB: could not load this connection JSON — ${error.message}`,
        );
      }
    },
  );
  context.subscriptions.push(connectionFileSaveDisposable);

  const closeDisposable = vscode.workspace.onDidCloseTextDocument(async (document) => {
    const session = editorSessionManager.detach(document);
    if (!session) return;
    try {
      const hadTransaction = connectionManager.hasTransaction(
        session.profileId,
        session.id,
      );
      if (session.runningExecutionId) {
        await connectionManager.cancel(session.profileId, session.runningExecutionId);
      }
      if (connectionManager.hasTransaction(session.profileId, session.id)) {
        await connectionManager.rollback(session.profileId, session.id);
      }
      if (hadTransaction) {
        vscode.window.showWarningMessage(
          'Simple DB: the transaction was rolled back when the SQL editor closed.',
        );
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Simple DB: the editor transaction could not be closed: ${error.message}`,
      );
    }
  });
  context.subscriptions.push(closeDisposable);

  runtime = {
    connectionManager,
    resultPanel,
    resultStore,
  };
}

async function deactivate() {
  const active = runtime;
  runtime = null;
  if (!active) return;
  active.resultPanel.dispose();
  await active.connectionManager.disconnectAll();
  await active.resultStore.dispose();
}

module.exports = {
  activate,
  deactivate,
};
