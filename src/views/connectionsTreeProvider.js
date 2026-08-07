'use strict';

const vscode = require('vscode');
const { DATABASE_ENGINES, getDatabaseEngine } = require('../databaseEngines');

class ConnectionsTreeProvider {
  constructor(connectionStore, connectionManager) {
    this.connectionStore = connectionStore;
    this.connectionManager = connectionManager;
    this.changeEmitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changeEmitter.event;
    this.managerListener = () => this.refresh();
    this.connectionManager.on('change', this.managerListener);
  }

  refresh() {
    this.changeEmitter.fire();
  }

  _message(label, parentId, icon = 'info') {
    return { kind: 'message', label, parentId, icon };
  }

  getTreeItem(node) {
    switch (node.kind) {
      case 'engine': {
        const engine = getDatabaseEngine(node.engineId);
        const count = this.connectionStore
          .list()
          .filter((profile) => profile.engine === node.engineId).length;
        const item = new vscode.TreeItem(
          engine.displayName,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.id = `simpleDb.engine.${node.engineId}`;
        item.contextValue = 'simpleDb.engine';
        item.description = `${count} connection${count === 1 ? '' : 's'}`;
        item.iconPath = new vscode.ThemeIcon('server-environment');
        item.tooltip = engine.defaultPort
          ? `${engine.displayName} — default port ${engine.defaultPort}`
          : `${engine.displayName} — file database`;
        return item;
      }
      case 'connection': {
        const profile = this.connectionStore.get(node.profileId);
        if (!profile) {
          return new vscode.TreeItem('Connection deleted');
        }
        const status = this.connectionManager.status(profile.id);
        const connected = this.connectionManager.isConnected(profile.id);
        const transactionCount = this.connectionManager.transactionCount(profile.id);
        const item = new vscode.TreeItem(
          profile.name,
          connected
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None,
        );
        item.id = `simpleDb.connection.${profile.id}`;
        item.contextValue = connected
          ? transactionCount > 0
            ? 'simpleDb.connection.transaction'
            : 'simpleDb.connection.connected'
          : 'simpleDb.connection.disconnected';
        if (status.state === 'connecting') {
          item.description = 'connecting…';
          item.iconPath = new vscode.ThemeIcon('sync~spin');
        } else if (status.state === 'error') {
          item.description = 'error';
          item.iconPath = new vscode.ThemeIcon('error');
        } else if (connected) {
          item.description = transactionCount > 0 ? `TX: ${transactionCount}` : 'connected';
          item.iconPath = new vscode.ThemeIcon('database');
        } else {
          item.description = 'disconnected';
          item.iconPath = new vscode.ThemeIcon('circle-outline');
        }
        let location;
        if (profile.engine === 'sqlite') {
          location = profile.filePath;
        } else if (profile.engine === 'oracle' && profile.connectString) {
          location = profile.connectString;
        } else if (profile.engine === 'sqlserver' && profile.instanceName) {
          location = `${profile.host}\\${profile.instanceName}/${profile.database || ''}`;
        } else {
          location = `${profile.host}:${profile.port || ''}/${profile.database || profile.serviceName || ''}`;
        }
        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`**${profile.name}**  \n`);
        tooltip.appendMarkdown(`${getDatabaseEngine(profile.engine)?.displayName || profile.engine}  \n`);
        tooltip.appendText(location);
        if (status.serverVersion) {
          tooltip.appendMarkdown(`  \nServer: ${status.serverVersion}`);
        }
        if (status.error) {
          tooltip.appendMarkdown(`  \nError: ${status.error}`);
        }
        item.tooltip = tooltip;
        return item;
      }
      case 'database': {
        const item = new vscode.TreeItem(
          node.database,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = `simpleDb.database.${node.profileId}.${node.database}`;
        item.contextValue = 'simpleDb.database';
        item.iconPath = new vscode.ThemeIcon('database');
        if (node.file) {
          item.tooltip = node.file;
        }
        return item;
      }
      case 'schema': {
        const item = new vscode.TreeItem(
          node.schema,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.contextValue = 'simpleDb.schema';
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        return item;
      }
      case 'group': {
        const labels = {
          tables: 'Tables',
          views: 'Views',
          materializedViews: 'Materialized Views',
          procedures: 'Procedures and Functions',
          packages: 'Packages',
          indexes: 'Indexes',
          triggers: 'Triggers',
          sequences: 'Sequences',
          types: 'Types',
          synonyms: 'Synonyms',
          events: 'Events',
        };
        const icons = {
          tables: 'table',
          views: 'preview',
          materializedViews: 'preview',
          procedures: 'symbol-method',
          packages: 'package',
          indexes: 'list-tree',
          triggers: 'zap',
          sequences: 'list-ordered',
          types: 'symbol-class',
          synonyms: 'references',
          events: 'calendar',
        };
        const item = new vscode.TreeItem(
          labels[node.groupType] || node.groupType,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.contextValue = `simpleDb.group.${node.groupType}`;
        item.iconPath = new vscode.ThemeIcon(icons[node.groupType] || 'symbol-object');
        return item;
      }
      case 'object': {
        const hasColumns = ['table', 'view', 'materializedView'].includes(
          node.objectType,
        );
        const item = new vscode.TreeItem(
          node.name,
          hasColumns
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None,
        );
        item.contextValue = `simpleDb.${node.objectType}`;
        const icons = {
          table: 'table',
          view: 'preview',
          materializedView: 'preview',
          procedure: 'symbol-method',
          package: 'package',
          index: 'list-tree',
          trigger: 'zap',
          sequence: 'list-ordered',
          type: 'symbol-class',
          synonym: 'references',
          event: 'calendar',
        };
        item.iconPath = new vscode.ThemeIcon(icons[node.objectType] || 'symbol-object');
        item.description = node.type || node.tableName || node.target || '';
        return item;
      }
      case 'column': {
        const item = new vscode.TreeItem(
          node.name,
          vscode.TreeItemCollapsibleState.None,
        );
        item.contextValue = 'simpleDb.column';
        item.iconPath = new vscode.ThemeIcon('symbol-field');
        item.description = `${node.type || ''}${node.nullable === false ? ' • NOT NULL' : ''}`;
        return item;
      }
      case 'message':
      default: {
        const item = new vscode.TreeItem(
          node.label || 'No items',
          vscode.TreeItemCollapsibleState.None,
        );
        item.contextValue = 'simpleDb.message';
        item.iconPath = new vscode.ThemeIcon(node.icon || 'info');
        return item;
      }
    }
  }

  async getChildren(node) {
    if (!node) {
      return DATABASE_ENGINES.map((engine) => ({
        kind: 'engine',
        engineId: engine.id,
      }));
    }

    try {
      if (node.kind === 'engine') {
        const profiles = this.connectionStore
          .list()
          .filter((profile) => profile.engine === node.engineId)
          .sort((a, b) => a.name.localeCompare(b.name));
        return profiles.length
          ? profiles.map((profile) => ({ kind: 'connection', profileId: profile.id }))
          : [this._message('No connections configured', node.engineId)];
      }

      if (node.kind === 'connection') {
        if (!this.connectionManager.isConnected(node.profileId)) {
          return [this._message('Connect to explore the database', node.profileId)];
        }
        const databases = await this.connectionManager.listDatabases(node.profileId);
        return databases.length
          ? databases.map((database) => ({
              kind: 'database',
              profileId: node.profileId,
              database: String(database.name),
              file: database.file,
            }))
          : [this._message('No visible databases', node.profileId)];
      }

      if (node.kind === 'database') {
        const profile = this.connectionStore.get(node.profileId);
        if (profile.engine === 'mysql' || profile.engine === 'sqlite') {
          return this._objectGroups(node.profileId, node.database, node.database);
        }
        const schemas = await this.connectionManager.listSchemas(
          node.profileId,
          node.database,
        );
        return schemas.length
          ? schemas.map((schema) => ({
              kind: 'schema',
              profileId: node.profileId,
              database: node.database,
              schema: String(schema.name),
            }))
          : [this._message('No visible schemas', `${node.profileId}.${node.database}`)];
      }

      if (node.kind === 'schema') {
        return this._objectGroups(node.profileId, node.database, node.schema);
      }

      if (node.kind === 'group') {
        const objects = await this.connectionManager.listObjectGroup(
          node.profileId,
          node.database,
          node.schema,
          node.groupType,
        );
        const objectType = {
          tables: 'table',
          views: 'view',
          materializedViews: 'materializedView',
          procedures: 'procedure',
          packages: 'package',
          indexes: 'index',
          triggers: 'trigger',
          sequences: 'sequence',
          types: 'type',
          synonyms: 'synonym',
          events: 'event',
        }[node.groupType] || 'object';
        return objects.length
          ? objects.map((object) => ({
              ...object,
              kind: 'object',
              objectType,
              profileId: node.profileId,
              database: node.database,
              schema: node.schema,
              name: String(object.name),
              type: object.type || '',
            }))
          : [this._message('No items', `${node.profileId}.${node.groupType}`)];
      }

      if (
        node.kind === 'object' &&
        ['table', 'view', 'materializedView'].includes(node.objectType)
      ) {
        const columns = await this.connectionManager.listColumns(
          node.profileId,
          node.database,
          node.schema,
          node.name,
        );
        return columns.length
          ? columns.map((column) => ({
              kind: 'column',
              name: String(column.name),
              type: column.type || '',
              nullable: column.nullable === true || column.nullable === 1,
              position: column.position,
            }))
          : [this._message('No visible columns', `${node.profileId}.${node.name}`)];
      }

      return [];
    } catch (error) {
      return [this._message(`Error: ${error.message}`, `error.${Date.now()}`, 'error')];
    }
  }

  _objectGroups(profileId, database, schema) {
    const engineId = this.connectionStore.get(profileId)?.engine;
    const groups = getDatabaseEngine(engineId)?.objectGroups || ['tables', 'views'];
    return groups.map((groupType) => ({
      kind: 'group',
      groupType,
      profileId,
      database,
      schema,
    }));
  }

  getParent() {
    return undefined;
  }

  dispose() {
    this.connectionManager.off('change', this.managerListener);
    this.changeEmitter.dispose();
  }
}

module.exports = {
  ConnectionsTreeProvider,
};
