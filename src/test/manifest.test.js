'use strict';

const manifest = require('../../package.json');

describe('extension manifest', () => {
  it('ships 0.1.6 without the removed History feature', () => {
    expect(manifest.version).toBe('0.1.6');
    expect(JSON.stringify(manifest).toLowerCase()).not.toContain('history');
  });

  it('exposes only Open Configuration in the Command Palette', () => {
    const commandIds = manifest.contributes.commands.map((entry) => entry.command);
    const hiddenIds = new Set(
      manifest.contributes.menus.commandPalette
        .filter((entry) => entry.when === 'false')
        .map((entry) => entry.command),
    );
    expect(commandIds.filter((commandId) => !hiddenIds.has(commandId))).toEqual([
      'simpleDb.openConfiguration',
    ]);
    expect(
      manifest.contributes.commands.find(
        (command) => command.command === 'simpleDb.openConfiguration',
      ),
    ).toMatchObject({
      title: 'Open Configuration',
      category: 'Simple DB',
    });
  });

  it('puts connection selection next to query execution in SQL editors', () => {
    const editorTitle = manifest.contributes.menus['editor/title'];
    expect(editorTitle.map((entry) => entry.command)).toEqual([
      'simpleDb.changeEditorConnection',
      'simpleDb.executeCurrent',
      'simpleDb.executeDocument',
      'simpleDb.cancelQuery',
    ]);
    expect(
      manifest.contributes.commands.find(
        (command) => command.command === 'simpleDb.changeEditorConnection',
      ),
    ).toMatchObject({
      title: 'Select / Change Connection...',
      icon: '$(database)',
    });
  });

  it('exposes the complete Simple DB workflow from the SQL editor context menu', () => {
    const menu = manifest.contributes.menus['simpleDb.editorContextMenu'];
    expect(menu.map((entry) => entry.command)).toEqual([
      'simpleDb.openConfiguration',
      'simpleDb.refreshConnections',
      'simpleDb.openConnectionsFolder',
      'simpleDb.changeEditorConnection',
      'simpleDb.addConnection',
      'simpleDb.connect',
      'simpleDb.disconnect',
      'simpleDb.testConnection',
      'simpleDb.editConnection',
      'simpleDb.setPassword',
      'simpleDb.deleteConnection',
      'simpleDb.newQuery',
      'simpleDb.executeCurrent',
      'simpleDb.executeSelection',
      'simpleDb.executeDocument',
      'simpleDb.cancelQuery',
      'simpleDb.beginTransaction',
      'simpleDb.commit',
      'simpleDb.rollback',
      'simpleDb.goToDefinition',
      'simpleDb.goToDeclaration',
      'simpleDb.goToPackageSpecification',
      'simpleDb.goToPackageBody',
    ]);
  });

  it('uses Ctrl+Enter, F5, and F12 for the main SQL workflow', () => {
    const bindings = Object.fromEntries(
      manifest.contributes.keybindings.map((binding) => [
        binding.command,
        binding.key,
      ]),
    );
    expect(bindings['simpleDb.executeCurrent']).toBe('ctrl+enter');
    expect(bindings['simpleDb.executeDocument']).toBe('f5');
    expect(bindings['simpleDb.goToDefinition']).toBe('f12');
  });
});
