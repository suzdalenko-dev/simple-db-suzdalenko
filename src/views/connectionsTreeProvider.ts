import * as vscode from 'vscode';

import {
  DATABASE_ENGINES,
  type DatabaseEngineDefinition,
  type DatabaseEngineId,
} from '../databaseEngines';

interface EngineNode {
  readonly kind: 'engine';
  readonly engine: DatabaseEngineDefinition;
}

interface EmptyNode {
  readonly kind: 'empty';
  readonly engineId: DatabaseEngineId;
}

type ConnectionTreeNode = EngineNode | EmptyNode;

export class ConnectionsTreeProvider
  implements vscode.TreeDataProvider<ConnectionTreeNode>, vscode.Disposable
{
  private readonly changeEmitter =
    new vscode.EventEmitter<ConnectionTreeNode | undefined | void>();

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public refresh(): void {
    this.changeEmitter.fire();
  }

  public getTreeItem(element: ConnectionTreeNode): vscode.TreeItem {
    if (element.kind === 'engine') {
      const item = new vscode.TreeItem(
        element.engine.displayName,
        vscode.TreeItemCollapsibleState.Collapsed,
      );

      item.id = `simpleDb.engine.${element.engine.id}`;
      item.contextValue = 'simpleDb.engine';
      item.description = '0 conexiones';
      item.iconPath = new vscode.ThemeIcon('database');
      item.tooltip = new vscode.MarkdownString(
        `**${element.engine.displayName}**  \nPuerto predeterminado: ${element.engine.defaultPort}`,
      );

      return item;
    }

    const item = new vscode.TreeItem(
      'Sin conexiones configuradas',
      vscode.TreeItemCollapsibleState.None,
    );

    item.id = `simpleDb.empty.${element.engineId}`;
    item.contextValue = 'simpleDb.empty';
    item.description = 'se añadirá en el Paso 3';
    item.iconPath = new vscode.ThemeIcon('info');

    return item;
  }

  public getChildren(element?: ConnectionTreeNode): ConnectionTreeNode[] {
    if (element === undefined) {
      return DATABASE_ENGINES.map((engine) => ({
        kind: 'engine',
        engine,
      }));
    }

    if (element.kind === 'engine') {
      return [
        {
          kind: 'empty',
          engineId: element.engine.id,
        },
      ];
    }

    return [];
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }
}
