import * as vscode from 'vscode';

import { ConnectionsTreeProvider } from './views/connectionsTreeProvider';

const CONNECTIONS_VIEW_ID = 'simpleDb.connections';
const REFRESH_CONNECTIONS_COMMAND_ID = 'simpleDb.refreshConnections';

export function activate(context: vscode.ExtensionContext): void {
  const connectionsTreeProvider = new ConnectionsTreeProvider();
  const connectionsTreeView = vscode.window.createTreeView(CONNECTIONS_VIEW_ID, {
    treeDataProvider: connectionsTreeProvider,
    showCollapseAll: true,
  });
  const refreshConnectionsCommand = vscode.commands.registerCommand(
    REFRESH_CONNECTIONS_COMMAND_ID,
    () => {
      connectionsTreeProvider.refresh();
    },
  );

  context.subscriptions.push(
    connectionsTreeProvider,
    connectionsTreeView,
    refreshConnectionsCommand,
  );
}

export function deactivate(): void {
  // Los recursos registrados se liberan mediante context.subscriptions.
}
