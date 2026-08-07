'use strict';

const vscode = require('vscode');
const { getDatabaseEngine } = require('../databaseEngines');

function compactSql(sql) {
  return String(sql || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
}

class HistoryTreeProvider {
  constructor(historyStore) {
    this.historyStore = historyStore;
    this.changeEmitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changeEmitter.event;
    this.historyDisposable = historyStore.onDidChange(() => this.refresh());
  }

  refresh() {
    this.changeEmitter.fire();
  }

  getTreeItem(node) {
    if (node.kind === 'empty') {
      const item = new vscode.TreeItem('Sin consultas en el historial');
      item.iconPath = new vscode.ThemeIcon('info');
      return item;
    }

    const entry = node.entry;
    const item = new vscode.TreeItem(
      compactSql(entry.sql) || '(consulta vacía)',
      vscode.TreeItemCollapsibleState.None,
    );
    item.contextValue = 'simpleDb.historyEntry';
    const affected = entry.affectedRows ? ` • ${entry.affectedRows} afectadas` : '';
    item.description = `${entry.connectionName} • ${entry.rows} filas${affected} • ${entry.durationMs} ms`;
    item.iconPath = new vscode.ThemeIcon(entry.success ? 'pass-filled' : 'error');
    item.command = {
      command: 'simpleDb.openHistoryEntry',
      title: 'Abrir consulta',
      arguments: [node],
    };

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(
      `**${getDatabaseEngine(entry.engine)?.displayName || entry.engine} — ${entry.connectionName}**  \n`,
    );
    tooltip.appendMarkdown(`${new Date(entry.timestamp).toLocaleString()}  \n`);
    tooltip.appendCodeblock(entry.sql, 'sql');
    if (entry.error) {
      tooltip.appendMarkdown(`\nError: ${entry.error}`);
    }
    item.tooltip = tooltip;
    return item;
  }

  getChildren(node) {
    if (node) {
      return [];
    }
    const entries = this.historyStore.list();
    return entries.length
      ? entries.map((entry) => ({ kind: 'history', entry }))
      : [{ kind: 'empty' }];
  }

  dispose() {
    this.historyDisposable.dispose();
    this.changeEmitter.dispose();
  }
}

module.exports = {
  HistoryTreeProvider,
};
