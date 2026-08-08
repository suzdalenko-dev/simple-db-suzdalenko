'use strict';

const vscode = require('vscode');
const { DATABASE_ENGINES, getDatabaseEngine } = require('../databaseEngines');

async function inputText(options) {
  return vscode.window.showInputBox({
    title: options.title,
    prompt: options.prompt,
    value: options.value ?? '',
    password: options.password === true,
    ignoreFocusOut: true,
    validateInput: options.required
      ? (value) => (value.trim() ? undefined : 'This field is required.')
      : options.validateInput,
  });
}

async function chooseSqlitePath() {
  const mode = await vscode.window.showQuickPick(
    [
      { label: '$(folder-opened) Open Existing Database', value: 'open' },
      { label: '$(new-file) Create New Database', value: 'create' },
      { label: '$(edit) Enter Path Manually', value: 'manual' },
    ],
    {
      title: 'Simple DB — SQLite Database',
      placeHolder: 'Choose the SQLite database file',
      ignoreFocusOut: true,
    },
  );
  if (!mode) return undefined;

  if (mode.value === 'open') {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      title: 'Select SQLite Database',
      filters: {
        'SQLite database': ['db', 'sqlite', 'sqlite3'],
        'All files': ['*'],
      },
    });
    return selected?.[0]?.fsPath;
  }

  if (mode.value === 'create') {
    const selected = await vscode.window.showSaveDialog({
      title: 'Create SQLite Database',
      filters: { 'SQLite database': ['db', 'sqlite', 'sqlite3'] },
    });
    return selected?.fsPath;
  }

  return inputText({
    title: 'Simple DB — SQLite Database',
    prompt: 'Full SQLite file path',
    required: true,
  });
}

function defaultProfile(engineId, name) {
  const common = {
    name,
    engine: engineId,
    connectTimeoutMs: 15000,
    queryTimeoutMs: 300000,
  };

  switch (engineId) {
    case 'sqlite':
      return { ...common, filePath: '', readOnly: false };
    case 'postgresql':
      return {
        ...common,
        host: 'localhost',
        port: 5432,
        database: 'postgres',
        user: 'postgres',
        ssl: false,
        trustServerCertificate: false,
      };
    case 'mysql':
      return {
        ...common,
        host: 'localhost',
        port: 3306,
        database: '',
        user: 'root',
        ssl: false,
        trustServerCertificate: false,
      };
    case 'sqlserver':
      return {
        ...common,
        host: 'localhost',
        port: 1433,
        database: 'master',
        user: 'sa',
        instanceName: '',
        encrypt: true,
        trustServerCertificate: false,
      };
    case 'oracle':
      return {
        ...common,
        host: 'localhost',
        port: 1521,
        serviceName: '',
        connectString: '',
        user: '',
      };
    default:
      throw new Error(`Invalid database engine: ${engineId}`);
  }
}

async function promptConnection(options = {}) {
  let engineId = options.engineId;
  if (!engineId) {
    const enginePick = await vscode.window.showQuickPick(
      DATABASE_ENGINES.map((engine) => ({
        label: `$(database) ${engine.displayName}`,
        description:
          engine.defaultPort === null ? 'Local file' : `Default port ${engine.defaultPort}`,
        value: engine.id,
      })),
      {
        title: 'Simple DB — Create Connection',
        placeHolder: 'Select a database engine',
        ignoreFocusOut: true,
      },
    );
    if (!enginePick) return null;
    engineId = enginePick.value;
  }

  const engine = getDatabaseEngine(engineId);
  if (!engine) throw new Error(`Invalid database engine: ${engineId}`);

  const name = await inputText({
    title: `Simple DB — Create ${engine.displayName} Connection`,
    prompt: 'Connection name',
    required: true,
  });
  if (name === undefined) return null;

  const profile = defaultProfile(engineId, name.trim());
  if (engineId === 'sqlite') {
    const filePath = await chooseSqlitePath();
    if (filePath === undefined) return null;
    profile.filePath = filePath;
    return { profile, password: undefined };
  }

  const password = await inputText({
    title: `Simple DB — ${engine.displayName} Password`,
    prompt: 'Password (optional; stored securely and never written to the JSON file)',
    password: true,
    required: false,
  });
  if (password === undefined) return null;
  return { profile, password };
}

async function promptPassword(profile) {
  const engine = getDatabaseEngine(profile.engine);
  return inputText({
    title: `Simple DB — Set Password for ${profile.name}`,
    prompt: `${engine?.displayName || profile.engine} password (stored in VS Code SecretStorage)`,
    password: true,
    required: false,
  });
}

module.exports = {
  defaultProfile,
  promptConnection,
  promptPassword,
};
