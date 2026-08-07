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
      ? (value) => (value.trim() ? undefined : 'Este campo es obligatorio.')
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
      `${options.prompt}: introduce un número entero válido.`,
    );
    return inputNumber(options);
  }
  return number;
}

async function inputBoolean(title, label, value) {
  const picked = await vscode.window.showQuickPick(
    [
      { label: value ? 'Sí' : 'No', value },
      { label: value ? 'No' : 'Sí', value: !value },
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
      title: 'Simple DB — Editar SQLite',
      prompt: 'Ruta completa del archivo SQLite',
      value: existingProfile.filePath,
      required: true,
    });
  }

  const mode = await vscode.window.showQuickPick(
    [
      { label: '$(folder-opened) Abrir archivo existente', value: 'open' },
      { label: '$(new-file) Crear archivo nuevo', value: 'create' },
      { label: '$(edit) Escribir la ruta manualmente', value: 'manual' },
    ],
    {
      title: 'Simple DB — Archivo SQLite',
      placeHolder: 'Selecciona cómo indicar el archivo SQLite',
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
      title: 'Seleccionar base de datos SQLite',
      filters: {
        'SQLite database': ['db', 'sqlite', 'sqlite3'],
        'Todos los archivos': ['*'],
      },
    });
    return selected?.[0]?.fsPath;
  }

  if (mode.value === 'create') {
    const selected = await vscode.window.showSaveDialog({
      title: 'Crear base de datos SQLite',
      filters: { 'SQLite database': ['db', 'sqlite', 'sqlite3'] },
    });
    return selected?.fsPath;
  }

  return inputText({
    title: 'Simple DB — Archivo SQLite',
    prompt: 'Ruta completa del archivo SQLite',
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
          engine.defaultPort === null ? 'Archivo local' : `Puerto ${engine.defaultPort}`,
        value: engine.id,
      })),
      {
        title: 'Simple DB — Nueva conexión',
        placeHolder: 'Selecciona el motor de base de datos',
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
    throw new Error(`Motor no válido: ${engineId}`);
  }

  const name = await inputText({
    title: `Simple DB — ${existing ? 'Editar' : 'Nueva'} conexión ${engine.displayName}`,
    prompt: 'Nombre visible de la conexión',
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
      '¿Abrir en modo solo lectura?',
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
          label: 'Host + puerto + servicio/PDB',
          value: 'service',
          description: 'Formato habitual de Oracle Easy Connect',
        },
        {
          label: 'Connect string / alias TNS',
          value: 'connectString',
          description: 'Usar una cadena de conexión directamente',
        },
      ],
      {
        title: 'Simple DB — Oracle',
        placeHolder: 'Modo de conexión Oracle',
        ignoreFocusOut: true,
      },
    );
    if (!mode) {
      return null;
    }

    if (mode.value === 'service') {
      profile.host = await inputText({
        title: 'Simple DB — Oracle',
        prompt: 'Servidor / host',
        value: existing?.host || 'localhost',
        required: true,
      });
      if (profile.host === undefined) return null;
      profile.port = await inputNumber({
        title: 'Simple DB — Oracle',
        prompt: 'Puerto',
        value: existing?.port || 1521,
        minimum: 1,
      });
      if (profile.port === undefined) return null;
      profile.serviceName = await inputText({
        title: 'Simple DB — Oracle',
        prompt: 'Servicio / PDB',
        value: existing?.serviceName || existing?.database || '',
        required: true,
      });
      if (profile.serviceName === undefined) return null;
      profile.database = profile.serviceName;
      profile.connectString = '';
    } else {
      profile.connectString = await inputText({
        title: 'Simple DB — Oracle',
        prompt: 'Connect string o alias TNS',
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
      prompt: 'Usuario',
      value: existing?.user || '',
      required: true,
    });
    if (profile.user === undefined) return null;
    password = await inputText({
      title: 'Simple DB — Oracle',
      prompt: existing ? 'Contraseña (vacío = conservar la actual)' : 'Contraseña',
      password: true,
      required: false,
    });
    if (password === undefined) return null;
  } else {
    profile.host = await inputText({
      title: `Simple DB — ${engine.displayName}`,
      prompt: 'Servidor / host',
      value: existing?.host || 'localhost',
      required: true,
    });
    if (profile.host === undefined) return null;

    if (engineId === 'sqlserver') {
      profile.instanceName = await inputText({
        title: 'Simple DB — SQL Server',
        prompt: 'Instancia (opcional; vacío = usar puerto TCP)',
        value: existing?.instanceName || '',
      });
      if (profile.instanceName === undefined) return null;
    }

    profile.port = await inputNumber({
      title: `Simple DB — ${engine.displayName}`,
      prompt: 'Puerto',
      value: existing?.port || engine.defaultPort,
      minimum: 1,
    });
    if (profile.port === undefined) return null;

    profile.database = await inputText({
      title: `Simple DB — ${engine.displayName}`,
      prompt: engineId === 'mysql' ? 'Base de datos inicial (opcional)' : 'Base de datos inicial',
      value:
        existing?.database ||
        (engineId === 'postgresql' ? 'postgres' : engineId === 'sqlserver' ? 'master' : ''),
      required: engineId !== 'mysql',
    });
    if (profile.database === undefined) return null;

    profile.user = await inputText({
      title: `Simple DB — ${engine.displayName}`,
      prompt: 'Usuario',
      value: existing?.user || '',
      required: true,
    });
    if (profile.user === undefined) return null;

    password = await inputText({
      title: `Simple DB — ${engine.displayName}`,
      prompt: existing ? 'Contraseña (vacío = conservar la actual)' : 'Contraseña',
      password: true,
      required: false,
    });
    if (password === undefined) return null;

    if (engineId === 'sqlserver') {
      profile.encrypt = await inputBoolean(
        'Simple DB — SQL Server',
        '¿Cifrar la conexión?',
        existing?.encrypt !== false,
      );
      if (profile.encrypt === undefined) return null;
      profile.trustServerCertificate = await inputBoolean(
        'Simple DB — SQL Server',
        '¿Confiar en el certificado del servidor?',
        existing?.trustServerCertificate || false,
      );
      if (profile.trustServerCertificate === undefined) return null;
    } else {
      profile.ssl = await inputBoolean(
        `Simple DB — ${engine.displayName}`,
        '¿Usar SSL/TLS?',
        existing?.ssl || false,
      );
      if (profile.ssl === undefined) return null;
      if (profile.ssl) {
        profile.trustServerCertificate = await inputBoolean(
          `Simple DB — ${engine.displayName}`,
          '¿Aceptar un certificado no verificado?',
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
    prompt: 'Tiempo máximo de conexión (ms)',
    value: existing?.connectTimeoutMs ?? 15000,
    minimum: 1,
  });
  if (profile.connectTimeoutMs === undefined) return null;

  profile.queryTimeoutMs = await inputNumber({
    title: `Simple DB — ${engine.displayName}`,
    prompt: 'Tiempo máximo por consulta (ms; 0 = sin límite)',
    value: existing?.queryTimeoutMs ?? 300000,
    minimum: 0,
  });
  if (profile.queryTimeoutMs === undefined) return null;

  const finish = await vscode.window.showQuickPick(
    [
      {
        label: '$(beaker) Probar conexión y guardar',
        value: 'test',
        description: 'Recomendado',
      },
      {
        label: '$(save) Guardar sin probar',
        value: 'save',
      },
    ],
    {
      title: `Simple DB — ${profile.name}`,
      placeHolder: '¿Cómo quieres terminar?',
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
