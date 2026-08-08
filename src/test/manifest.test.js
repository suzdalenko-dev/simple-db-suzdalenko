'use strict';

const manifest = require('../../package.json');

describe('extension manifest', () => {
  it('ships 0.1.3 without the removed History feature', () => {
    expect(manifest.version).toBe('0.1.3');
    expect(JSON.stringify(manifest).toLowerCase()).not.toContain('history');
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
      title: 'Select Connection for SQL File',
      icon: '$(database)',
    });
  });
});
