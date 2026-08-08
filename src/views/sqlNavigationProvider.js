'use strict';

const vscode = require('vscode');
const { DEFINITION_SCHEME } = require('../managers/editorSessionManager');
const { extractSqlReference, resolveSqlDefinition } = require('../services/sqlNavigation');

function findSymbolPosition(text, symbol) {
  if (!symbol) return new vscode.Position(0, 0);
  const escaped = String(symbol).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\b${escaped}\\b`, 'i').exec(text);
  if (!match) return new vscode.Position(0, 0);
  const before = text.slice(0, match.index);
  const lines = before.split('\n');
  return new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
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
    return this.documents.get(uri.toString()) || '-- Simple DB definition is no longer available.';
  }

  async _location(document, position, token) {
    if (document.uri.scheme === DEFINITION_SCHEME || token.isCancellationRequested) {
      return null;
    }
    const reference = extractSqlReference(
      document.getText(),
      document.offsetAt(position),
    );
    if (!reference) return null;

    const session = await this.editorSessionManager.ensureSession(document);
    if (!session || token.isCancellationRequested) return null;
    const profile = this.connectionStore.get(session.profileId);
    if (!profile) return null;

    await this.connectionManager.ensureConnected(profile.id);
    if (token.isCancellationRequested) return null;
    const target = await resolveSqlDefinition(
      this.connectionManager,
      profile,
      session,
      reference,
    );
    if (!target || token.isCancellationRequested) return null;

    const qualified = [target.schema, target.name].filter(Boolean).join('.');
    const header = `-- Simple DB | ${profile.name} | ${target.objectType} ${qualified}\n\n`;
    const content = `${header}${target.definition}`;
    const serial = this.serial;
    this.serial += 1;
    const uri = vscode.Uri.from({
      scheme: DEFINITION_SCHEME,
      path: `/${encodeURIComponent(target.name)}.sql`,
      query: `profile=${encodeURIComponent(profile.id)}&v=${serial}`,
    });
    if (this.documents.size >= 50) {
      this.documents.delete(this.documents.keys().next().value);
    }
    this.documents.set(uri.toString(), content);

    const symbol = target.memberName || target.name;
    return new vscode.Location(uri, findSymbolPosition(content, symbol));
  }

  async provideDefinition(document, position, token) {
    try {
      return await this._location(document, position, token);
    } catch (error) {
      vscode.window.showErrorMessage(`Simple DB: could not find definition — ${error.message}`);
      return null;
    }
  }

  async provideDeclaration(document, position, token) {
    return this.provideDefinition(document, position, token);
  }

  dispose() {
    this.documents.clear();
  }
}

module.exports = {
  SqlNavigationProvider,
  findSymbolPosition,
};
