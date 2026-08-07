'use strict';

const { randomUUID } = require('node:crypto');
const vscode = require('vscode');
const { QueryCancelledError, isCancellationError } = require('../core/errors');
const { classifySqlSafety } = require('../sql/safety');
const { findStatementAtOffset, splitSqlDocument } = require('../sql/sqlSplitter');
const { detectTransactionControl } = require('../sql/transactionControl');

class QueryRunner {
  constructor(options) {
    this.connectionStore = options.connectionStore;
    this.connectionManager = options.connectionManager;
    this.editorSessionManager = options.editorSessionManager;
    this.resultStore = options.resultStore;
    this.resultPanel = options.resultPanel;
    this.historyStore = options.historyStore;
  }

  _configuration() {
    const config = vscode.workspace.getConfiguration('simpleDb');
    return {
      maxRows: Math.max(0, Math.trunc(Number(config.get('maxRows', 0)))),
      pageSize: Math.max(1, Math.trunc(Number(config.get('resultPageSize', 500)))),
      maxCellCharacters: Math.max(
        100,
        Math.trunc(Number(config.get('maxCellCharacters', 10000))),
      ),
      confirmDestructiveQueries: config.get('confirmDestructiveQueries', true),
      warnUnsafeDml: config.get('warnUnsafeDml', true),
    };
  }

  _statements(editor, engineId, mode) {
    const documentText = editor.document.getText();
    const selection = editor.selection;
    if (mode === 'selection') {
      if (selection.isEmpty) {
        throw new Error('Selecciona primero el SQL que quieres ejecutar.');
      }
      const selected = editor.document.getText(selection);
      return {
        statements: splitSqlDocument(selected, engineId),
        historySql: selected,
        baseOffset: editor.document.offsetAt(selection.start),
      };
    }

    if (mode === 'current') {
      if (!selection.isEmpty) {
        const selected = editor.document.getText(selection);
        return {
          statements: splitSqlDocument(selected, engineId),
          historySql: selected,
          baseOffset: editor.document.offsetAt(selection.start),
        };
      }
      const offset = editor.document.offsetAt(selection.active);
      const statement = findStatementAtOffset(documentText, engineId, offset);
      return {
        statements: statement ? [statement] : [],
        historySql: statement?.sql || '',
        baseOffset: 0,
      };
    }

    return {
      statements: splitSqlDocument(documentText, engineId),
      historySql: documentText,
      baseOffset: 0,
    };
  }

  async _confirmSafety(statements, engineId, config) {
    for (const statement of statements) {
      const safety = classifySqlSafety(statement.sql, engineId);
      let warning = '';
      if (safety.destructive && config.confirmDestructiveQueries) {
        warning = `${safety.operation} puede eliminar o truncar objetos/datos. ¿Ejecutar?`;
      } else if (safety.unsafeDml && config.warnUnsafeDml) {
        warning = `${safety.operation} no contiene cláusula WHERE. Puede afectar a todas las filas. ¿Ejecutar?`;
      }
      if (!warning) continue;
      const answer = await vscode.window.showWarningMessage(
        warning,
        { modal: true },
        'Ejecutar',
      );
      if (answer !== 'Ejecutar') return false;
    }
    return true;
  }

  _sink(executionId, statementIndex, statementSql, nextGlobalSet) {
    const localSets = new Map();
    const statementStarted = Date.now();
    const globalIndex = (localSetIndex) => {
      if (!localSets.has(localSetIndex)) {
        localSets.set(localSetIndex, nextGlobalSet());
      }
      return localSets.get(localSetIndex);
    };

    return {
      localSets,
      start: async (localSetIndex, columns) => {
        await this.resultStore.startSet(
          executionId,
          globalIndex(localSetIndex),
          { statementIndex, columns, sql: statementSql, kind: 'rows' },
        );
      },
      rows: async (localSetIndex, rows) => {
        await this.resultStore.appendRows(
          executionId,
          globalIndex(localSetIndex),
          rows,
        );
      },
      end: async (localSetIndex, metadata = {}) => {
        await this.resultStore.finishSet(
          executionId,
          globalIndex(localSetIndex),
          {
            ...metadata,
            durationMs: Date.now() - statementStarted,
          },
        );
      },
    };
  }

  async run(mode = 'current') {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      throw new Error('No hay un editor SQL activo.');
    }

    const session = await this.editorSessionManager.ensureActiveSession();
    if (!session) return null;
    if (session.runningExecutionId) {
      throw new Error('Ya hay una consulta en ejecución en este editor. Cancélala o espera a que termine.');
    }
    const profile = this.connectionStore.get(session.profileId);
    if (!profile) throw new Error('La conexión vinculada al editor ya no existe.');

    const extracted = this._statements(editor, profile.engine, mode);
    if (extracted.statements.length === 0) {
      throw new Error('No se ha encontrado ninguna sentencia SQL ejecutable.');
    }
    const config = this._configuration();
    if (!(await this._confirmSafety(extracted.statements, profile.engine, config))) {
      return null;
    }

    this.resultStore.configure?.({
      pageSize: config.pageSize,
      maxCellCharacters: config.maxCellCharacters,
    });

    const executionId = randomUUID();
    const started = Date.now();
    await this.resultStore.createExecution(executionId, {
      profileId: profile.id,
      connectionName: profile.name,
      engine: profile.engine,
      database: session.database || '',
      schema: session.schema || '',
      maxRows: config.maxRows,
      pageSize: config.pageSize,
      statementCount: extracted.statements.length,
    });

    this.editorSessionManager.setRunning(session, executionId);
    let globalSetIndex = 0;
    const nextGlobalSet = () => {
      const value = globalSetIndex;
      globalSetIndex += 1;
      return value;
    };
    let failure = null;
    let cancelled = false;
    let schemaChanged = false;
    let currentStatement = null;
    let affectedRowsTotal = 0;

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Simple DB — ${profile.name}`,
          cancellable: true,
        },
        async (progress, token) => {
          const cancelDisposable = token.onCancellationRequested(() => {
            cancelled = true;
            void this.connectionManager.cancel(profile.id, executionId);
          });
          try {
            for (let index = 0; index < extracted.statements.length; index += 1) {
              if (cancelled) break;
              const statement = extracted.statements[index];
              currentStatement = statement;
              progress.report({
                message: `sentencia ${index + 1}/${extracted.statements.length}`,
              });

              const safety = classifySqlSafety(statement.sql, profile.engine);
              if (['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME'].includes(safety.operation)) {
                schemaChanged = true;
              }

              const sink = this._sink(
                executionId,
                index,
                statement.sql,
                nextGlobalSet,
              );
              const statementStarted = Date.now();
              const transactionControl = detectTransactionControl(
                statement.sql,
                profile.engine,
              );
              if (transactionControl === 'begin') {
                await this.connectionManager.begin(profile.id, session.id, {
                  database: session.database,
                  schema: session.schema,
                  beginSql: ['postgresql', 'mysql'].includes(profile.engine)
                    ? statement.sql
                    : '',
                });
                this.editorSessionManager.markTransactionNeedsRollback(session, false);
                await this.resultStore.addMessageSet(executionId, nextGlobalSet(), {
                  statementIndex: index,
                  sql: statement.sql,
                  durationMs: Date.now() - statementStarted,
                  message: 'BEGIN completado. Transacción activa en este editor.',
                });
                continue;
              }
              if (
                ['commit', 'rollback'].includes(transactionControl) &&
                this.connectionManager.hasTransaction(profile.id, session.id)
              ) {
                if (
                  transactionControl === 'commit' &&
                  session.transactionNeedsRollback
                ) {
                  throw new Error(
                    'La transacción tuvo un error. Ejecuta ROLLBACK antes de COMMIT.',
                  );
                }
                await this.connectionManager[transactionControl](
                  profile.id,
                  session.id,
                );
                this.editorSessionManager.markTransactionNeedsRollback(session, false);
                await this.resultStore.addMessageSet(executionId, nextGlobalSet(), {
                  statementIndex: index,
                  sql: statement.sql,
                  durationMs: Date.now() - statementStarted,
                  message: `${transactionControl.toUpperCase()} completado.`,
                });
                continue;
              }
              let timedOut = false;
              let timeoutHandle = null;
              const queryTimeoutMs = Math.max(0, Number(profile.queryTimeoutMs || 0));
              if (queryTimeoutMs > 0) {
                timeoutHandle = setTimeout(() => {
                  timedOut = true;
                  void this.connectionManager.cancel(profile.id, executionId);
                }, queryTimeoutMs);
              }

              try {
                const result = await this.connectionManager.execute(
                  profile.id,
                  session.id,
                  statement.sql,
                  {
                    executionId,
                    maxRows: config.maxRows,
                    pageSize: config.pageSize,
                    database: session.database,
                    schema: session.schema,
                    sink,
                  },
                );
                affectedRowsTotal += Number(result.rowsAffected || 0);
                if (result.resultSetCount === 0) {
                  const setIndex = nextGlobalSet();
                  const affectedRows = Number(result.rowsAffected || 0);
                  await this.resultStore.addMessageSet(executionId, setIndex, {
                    statementIndex: index,
                    sql: statement.sql,
                    affectedRows,
                    durationMs: Date.now() - statementStarted,
                    message: `${result.command || safety.operation || 'SQL'} ejecutado correctamente${affectedRows ? ` · ${affectedRows} filas afectadas` : ''}.`,
                  });
                }
              } catch (error) {
                if (timedOut) {
                  const timeoutError = new Error(
                    `La consulta superó el tiempo máximo configurado (${queryTimeoutMs} ms).`,
                  );
                  timeoutError.code = 'SIMPLE_DB_TIMEOUT';
                  throw timeoutError;
                }
                throw error;
              } finally {
                if (timeoutHandle) clearTimeout(timeoutHandle);
              }
            }
            if (cancelled) throw new QueryCancelledError();
          } finally {
            cancelDisposable.dispose();
          }
        },
      );
    } catch (error) {
      cancelled = cancelled || isCancellationError(error);
      failure = error;
      if (this.connectionManager.hasTransaction(profile.id, session.id)) {
        this.editorSessionManager.markTransactionNeedsRollback(session, true);
      }
      if (!cancelled && currentStatement) {
        const start = editor.document.positionAt(
          extracted.baseOffset + currentStatement.start,
        );
        const end = editor.document.positionAt(
          extracted.baseOffset + currentStatement.end,
        );
        editor.selection = new vscode.Selection(start, end);
        editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
      await this.resultStore.addMessageSet(executionId, nextGlobalSet(), {
        kind: cancelled ? 'message' : 'error',
        message: cancelled ? 'Consulta cancelada.' : `Error: ${error.message}`,
      });
    } finally {
      this.editorSessionManager.setRunning(session, null);
    }

    const durationMs = Date.now() - started;
    const status = failure ? (cancelled ? 'cancelled' : 'error') : 'success';
    const resultSnapshot = this.resultStore.getMetadata(executionId);
    const totalRows = (resultSnapshot?.sets || []).reduce(
      (sum, set) => sum + Number(set?.rowCount || 0),
      0,
    );
    const totalAffectedRows = affectedRowsTotal;
    const finalMetadata = await this.resultStore.finalizeExecution(executionId, {
      status,
      durationMs,
      error: failure && !cancelled ? failure.message : '',
      totalRows,
      affectedRows: totalAffectedRows,
    });

    await this.historyStore.add({
      engine: profile.engine,
      profileId: profile.id,
      connectionName: profile.name,
      database: session.database,
      schema: session.schema,
      sql: extracted.historySql,
      durationMs,
      rows: totalRows,
      affectedRows: totalAffectedRows,
      success: !failure,
      error: failure?.message || '',
    });

    if (schemaChanged) this.connectionManager.notifyChanged(profile.id);
    if (editor.document.isClosed) {
      await this.resultStore.deleteExecution(executionId);
      return finalMetadata;
    }
    await this.resultPanel.show(executionId);
    if (!failure) {
      vscode.window.setStatusBarMessage(
        `$(check) Simple DB: ${totalRows} filas${totalAffectedRows ? ` · ${totalAffectedRows} afectadas` : ''} · ${durationMs} ms`,
        5000,
      );
    } else if (!cancelled) {
      vscode.window.showErrorMessage(`Simple DB: ${failure.message}`);
    }
    return finalMetadata;
  }
}

module.exports = {
  QueryRunner,
};
