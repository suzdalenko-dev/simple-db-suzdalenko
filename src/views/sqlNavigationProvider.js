'use strict';

const vscode = require('vscode');
const { DEFINITION_SCHEME } = require('../managers/editorSessionManager');
const { extractSqlReference, resolveSqlTargets } = require('../services/sqlNavigation');

function positionAt(text, offset) {
  const source = String(text || '');
  const safeOffset = Math.max(0, Math.min(Number(offset) || 0, source.length));
  const before = source.slice(0, safeOffset);
  const lines = before.split('\n');
  return new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
}

function findSymbolPosition(text, symbol, startOffset = 0) {
  if (!symbol) return new vscode.Position(0, 0);
  const escaped = String(symbol).replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
  const match = new RegExp(escaped, 'i').exec(String(text || '').slice(startOffset));
  return positionAt(text, match ? startOffset + match.index : startOffset);
}

function cancellationToken() {
  return { isCancellationRequested: false };
}

class SqlNavigationProvider {
  constructor(connectionStore, connectionManager, editorSessionManager) {
    this.connectionStore = connectionStore;
    this.connectionManager = connectionManager;
    this.editorSessionManager = editorSessionManager;
    this.documents = new Map();
    this.serial = 0;
  }

  provideTextDocumentContent(uri) {
    return (
      this.documents.get(uri.toString())?.content ||
      '-- Simple DB definition is no longer available.'
    );
  }

  async _context(document) {
    if (document.uri.scheme === DEFINITION_SCHEME) {
      const record = this.documents.get(document.uri.toString());
      if (!record) return null;
      const profile = this.connectionStore.get(record.profileId);
      if (!profile) return null;
      return {
        profile,
        session: {
          profileId: profile.id,
          database: record.database,
          schema: record.schema,
        },
      };
    }

    const session = await this.editorSessionManager.ensureSession(document);
    if (!session) return null;
    const profile = this.connectionStore.get(session.profileId);
    return profile ? { profile, session } : null;
  }

  _virtualLocation(profile, target, localDocuments) {
    const sourceKey = [
      profile.id,
      target.database,
      target.schema,
      target.objectType,
      target.name,
      target.mode,
      target.definition,
    ].join('\u0000');
    let record = localDocuments.get(sourceKey);
    if (!record) {
      const qualified = [target.schema, target.name].filter(Boolean).join('.');
      const via = target.synonymChain?.length
        ? '\n-- Resolved via synonym: ' + target.synonymChain.join(' -> ')
        : '';
      const heading =
        '-- Simple DB | ' +
        profile.name +
        ' | ' +
        target.mode +
        ' | ' +
        target.objectType +
        ' ' +
        qualified +
        via +
        '\n\n';
      const content = heading + target.definition;
      const serial = this.serial;
      this.serial += 1;
      const uri = vscode.Uri.from({
        scheme: DEFINITION_SCHEME,
        path: '/' + encodeURIComponent(qualified || target.name) + '.sql',
        query:
          'profile=' +
          encodeURIComponent(profile.id) +
          '&mode=' +
          target.mode +
          '&v=' +
          serial,
      });
      record = {
        uri,
        content,
        headerLength: heading.length,
        profileId: profile.id,
        database: target.database,
        schema: target.schema,
        target,
      };
      localDocuments.set(sourceKey, record);
      this.documents.set(uri.toString(), record);
    }

    const offset = record.headerLength + Math.max(0, Number(target.definitionOffset || 0));
    return new vscode.Location(record.uri, positionAt(record.content, offset));
  }

  async _locations(document, position, token, mode) {
    if (token.isCancellationRequested) return null;
    const reference = extractSqlReference(
      document.getText(),
      document.offsetAt(position),
    );
    if (!reference) return null;

    const context = await this._context(document);
    if (!context || token.isCancellationRequested) return null;
    await this.connectionManager.ensureConnected(context.profile.id);
    if (token.isCancellationRequested) return null;

    const targets = await resolveSqlTargets(
      this.connectionManager,
      context.profile,
      context.session,
      reference,
      mode,
    );
    if (!targets.length || token.isCancellationRequested) return null;

    const localDocuments = new Map();
    return targets.map((target) =>
      this._virtualLocation(context.profile, target, localDocuments),
    );
  }

  _reportError(error, mode) {
    const action = mode === 'declaration' ? 'declaration' : 'definition';
    if (error?.code === 'SIMPLE_DB_NAVIGATION_SOURCE_UNAVAILABLE') {
      vscode.window.showWarningMessage('Simple DB: ' + error.message);
      return;
    }
    vscode.window.showErrorMessage(
      'Simple DB: could not find ' + action + ' — ' + error.message,
    );
  }

  async _provide(document, position, token, mode) {
    try {
      const locations = await this._locations(document, position, token, mode);
      if (!locations?.length) return null;
      return locations.length === 1 ? locations[0] : locations;
    } catch (error) {
      this._reportError(error, mode);
      return null;
    }
  }

  provideDefinition(document, position, token) {
    return this._provide(document, position, token, 'definition');
  }

  provideDeclaration(document, position, token) {
    return this._provide(document, position, token, 'declaration');
  }

  async _openLocation(location) {
    const document = await vscode.workspace.openTextDocument(location.uri);
    await vscode.window.showTextDocument(document, {
      preview: false,
      selection: new vscode.Range(location.range.start, location.range.start),
    });
  }

  async openFromActiveEditor(mode) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
      throw new Error('Open a SQL editor before navigating to a database object.');
    }
    let locations;
    try {
      locations = await this._locations(
        editor.document,
        editor.selection.active,
        cancellationToken(),
        mode,
      );
    } catch (error) {
      this._reportError(error, mode);
      return;
    }
    if (!locations?.length) {
      vscode.window.showInformationMessage(
        'Simple DB: no ' + mode + ' was found for the symbol under the cursor.',
      );
      return;
    }
    if (locations.length === 1) {
      await this._openLocation(locations[0]);
      return;
    }

    const items = [];
    for (const location of locations) {
      const document = await vscode.workspace.openTextDocument(location.uri);
      const line = document.lineAt(location.range.start.line).text.trim();
      const record = this.documents.get(location.uri.toString());
      items.push({
        label: line || record?.target?.name || 'Database object',
        description: [
          record?.target?.metadata?.signature,
          [record?.target?.schema, record?.target?.name].filter(Boolean).join('.'),
        ]
          .filter(Boolean)
          .join(' — '),
        detail: record?.target?.objectType,
        location,
      });
    }
    const title =
      mode === 'declaration' ? 'Simple DB — Choose Declaration' : 'Simple DB — Choose Definition';
    const pick = await vscode.window.showQuickPick(items, {
      title,
      placeHolder: 'Multiple database objects or overloads match this reference',
      ignoreFocusOut: true,
    });
    if (pick) await this._openLocation(pick.location);
  }

  dispose() {
    this.documents.clear();
  }
}

module.exports = {
  SqlNavigationProvider,
  findSymbolPosition,
  positionAt,
};
