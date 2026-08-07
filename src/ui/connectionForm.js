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

async function inputNumber(options) {
  const result = await inputText({
    ...options,
    value: String(options.value ?? options.defaultValue ?? ''),
    required: true,
    validateInput: undefined,
  });
  if (result === undefined) {
    return undefined;
  }
  const number = Number(result);
  if (!Number.isInteger(number) || number < (options.minimum ?? 0)) {
    await vscode.window.showErrorMessage(
      `${options.prompt}: enter a valid integer.`,
    );
    return inputNumber(options);
  }
  return number;
}

async function inputBoolean(title, label, value) {
  const picked = await vscode.window.showQuickPick(
    [
      { label: value ? 'Yes' : 'No', value },
      { label: value ? 'No' : 'Yes', value: !value },
    ],
    {
      title,
      placeHolder: label,
      ignoreFocusOut: true,
    },
  );
  return picked?.value;
}

async function chooseSqlitePath(existingProfile) {
  if (existingProfile) {
    return inputText({
      title: 'Simple DB — Edit SQLite',
      prompt: 'Full SQLite file path',
      value: existingProfile.filePath,
      required: true,
    });
  }

  const mode = await vscode.window.showQuickPick(
    [
      { label: '$(folder-opened) Open Existing File', value: 'open' },
      { label: '$(new-file) Create New File', value: 'create' },
      { label: '$(edit) Enter Path Manually', value: 'manual' },
    ],
    {
      title: 'Simple DB — SQLite File',
      placeHolder: 'Choose how to specify the SQLite file',
      ignoreFocusOut: true,
    },
  );
  if (!mode) {
    return undefined;
  }

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
    title: 'Simple DB — SQLite File',
    prompt: 'Full SQLite file path',
    required: true,
  });
}

async function promptConnection(options = {}) {
  const existing = options.existingProfile;
  let engineId = existing?.engine || options.engineId;

  if (!engineId) {
    const enginePick = await vscode.window.showQuickPick(
      DATABASE_ENGINES.map((engine) => ({
        label: `$(database) ${engine.displayName}`,
        description:
          engine.defaultPort === null ? 'Local file' : `Port ${engine.defaultPort}`,
        value: engine.id,
      })),
      {
        title: 'Simple DB — New Connection',
        placeHolder: 'Select a database engine',
        ignoreFocusOut: true,
      },
    );
    if (!enginePick) {
      return null;
    }
    engineId = enginePick.value;
  }

  const engine = getDatabaseEngine(engineId);
  if (!engine) {
    throw new Error(`Invalid database engine: ${engineId}`);
  }

  const name = await inputText({
    title: `Simple DB — ${existing ? 'Edit' : 'New'} ${engine.displayName} Connection`,
    prompt: 'Connection display name',
    value: existing?.name || '',
    required: true,
  });
  if (name === undefined) {
    return null;
  }

  const profile = {
    ...existing,
    name: name.trim(),
    engine: engineId,
  };

  let password;
  if (engineId === 'sqlite') {
    const sqlitePath = await chooseSqlitePath(existing);
    if (sqlitePath === undefined) {
      return null;
    }
    const readOnly = await inputBoolean(
      'Simple DB — SQLite',
      'Open in read-only mode?',
      existing?.readOnly || false,
    );
    if (readOnly === undefined) {
      return null;
    }
    profile.filePath = sqlitePath;
    profile.readOnly = readOnly;
  } else if (engineId === 'oracle') {
    const mode = await vscode.window.showQuickPick(
      [
        {
          label: 'Host + port + service/PDB',
          value: 'service',
          description: 'Standard Oracle Easy Connect format',
        },
        {
          label: 'Connect string / alias TNS',
          value: 'connectString',
          description: 'Use a connection string directly',
        },
      ],
      {
        title: 'Simple DB — Oracle',
        placeHolder: 'Oracle connection mode',
        ignoreFocusOut: true,
      },
    );
    if (!mode) {
      return null;
    }

    if (mode.value === 'service') {
      profile.host = await inputText({
        title: 'Simple DB — Oracle',
        prompt: 'Server / host',
        value: existing?.host || 'localhost',
        required: true,
      });
      if (profile.host === undefined) return null;
      profile.port = await inputNumber({
        title: 'Simple DB — Oracle',
        prompt: 'Port',
        value: existing?.port || 1521,
        minimum: 1,
      });
      if (profile.port === undefined) return null;
      profile.serviceName = await inputText({
        title: 'Simple DB — Oracle',
        prompt: 'Service / PDB',
        value: existing?.serviceName || existing?.database || '',
        required: true,
      });
      if (profile.serviceName === undefined) return null;
      profile.database = profile.serviceName;
      profile.connectString = '';
    } else {
      profile.connectString = await inputText({
        title: 'Simple DB — Oracle',
        prompt: 'Connect string or TNS alias',
        value: existing?.connectString || '',
        required: true,
      });
      if (profile.connectString === undefined) return null;
      profile.host = existing?.host || '';
      profile.port = existing?.port || 1521;
      profile.serviceName = existing?.serviceName || '';
      profile.database = existing?.database || '';
    }

    profile.user = await inputText({
      title: 'Simple DB — Oracle',
      prompt: 'Username',
      value: existing?.user || '',
      required: true,
    });
    if (profile.user === undefined) return null;
    password = await inputText({
      title: 'Simple DB — Oracle',
      prompt: existing ? 'Password (leave empty to keep the current one)' : 'Password',
      password: true,
      required: false,
    });
    if (password === undefined) return null;
  } else {
    profile.host = await inputText({
      title: `Simple DB — ${engine.displayName}`,
      prompt: 'Server / host',
      value: existing?.host || 'localhost',
      required: true,
    });
    if (profile.host === undefined) return null;

    if (engineId === 'sqlserver') {
      profile.instanceName = await inputText({
        title: 'Simple DB — SQL Server',
        prompt: 'Instance (optional; leave empty to use the TCP port)',
        value: existing?.instanceName || '',
      });
      if (profile.instanceName === undefined) return null;
    }

    profile.port = await inputNumber({
      title: `Simple DB — ${engine.displayName}`,
      prompt: 'Port',
      value: existing?.port || engine.defaultPort,
      minimum: 1,
    });
    if (profile.port === undefined) return null;

    profile.database = await inputText({
      title: `Simple DB — ${engine.displayName}`,
      prompt: engineId === 'mysql' ? 'Initial database (optional)' : 'Initial database',
      value:
        existing?.database ||
        (engineId === 'postgresql' ? 'postgres' : engineId === 'sqlserver' ? 'master' : ''),
      required: engineId !== 'mysql',
    });
    if (profile.database === undefined) return null;

    profile.user = await inputText({
      title: `Simple DB — ${engine.displayName}`,
      prompt: 'Username',
      value: existing?.user || '',
      required: true,
    });
    if (profile.user === undefined) return null;

    password = await inputText({
      title: `Simple DB — ${engine.displayName}`,
      prompt: existing ? 'Password (leave empty to keep the current one)' : 'Password',
      password: true,
      required: false,
    });
    if (password === undefined) return null;

    if (engineId === 'sqlserver') {
      profile.encrypt = await inputBoolean(
        'Simple DB — SQL Server',
        'Encrypt the connection?',
        existing?.encrypt !== false,
      );
      if (profile.encrypt === undefined) return null;
      profile.trustServerCertificate = await inputBoolean(
        'Simple DB — SQL Server',
        'Trust the server certificate?',
        existing?.trustServerCertificate || false,
      );
      if (profile.trustServerCertificate === undefined) return null;
    } else {
      profile.ssl = await inputBoolean(
        `Simple DB — ${engine.displayName}`,
        'Use SSL/TLS?',
        existing?.ssl || false,
      );
      if (profile.ssl === undefined) return null;
      if (profile.ssl) {
        profile.trustServerCertificate = await inputBoolean(
          `Simple DB — ${engine.displayName}`,
          'Accept an unverified certificate?',
          existing?.trustServerCertificate || false,
        );
        if (profile.trustServerCertificate === undefined) return null;
      } else {
        profile.trustServerCertificate = false;
      }
    }
  }

  profile.connectTimeoutMs = await inputNumber({
    title: `Simple DB — ${engine.displayName}`,
    prompt: 'Connection timeout (ms)',
    value: existing?.connectTimeoutMs ?? 15000,
    minimum: 1,
  });
  if (profile.connectTimeoutMs === undefined) return null;

  profile.queryTimeoutMs = await inputNumber({
    title: `Simple DB — ${engine.displayName}`,
    prompt: 'Query timeout (ms; 0 = no timeout)',
    value: existing?.queryTimeoutMs ?? 300000,
    minimum: 0,
  });
  if (profile.queryTimeoutMs === undefined) return null;

  const finish = await vscode.window.showQuickPick(
    [
      {
        label: '$(beaker) Test Connection and Save',
        value: 'test',
        description: 'Recommended',
      },
      {
        label: '$(save) Save without Testing',
        value: 'save',
      },
    ],
    {
      title: `Simple DB — ${profile.name}`,
      placeHolder: 'How do you want to finish?',
      ignoreFocusOut: true,
    },
  );
  if (!finish) {
    return null;
  }

  const effectivePassword =
    existing && password === '' ? options.existingPassword || '' : password || '';
  return {
    profile,
    password: existing && password === '' ? undefined : password,
    effectivePassword,
    testBeforeSave: finish.value === 'test',
  };
}

module.exports = {
  promptConnection,
};
