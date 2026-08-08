'use strict';

const DEFINITION_SCHEME = 'simple-db-definition';

function hasSqlExtension(document) {
  const resourcePath = String(document?.uri?.path || document?.uri?.fsPath || '');
  return resourcePath.toLowerCase().endsWith('.sql');
}

function isSqlDocument(document, options = {}) {
  if (!document?.uri) return false;
  if (!options.allowDefinition && document.uri.scheme === DEFINITION_SCHEME) {
    return false;
  }
  return document.languageId === 'sql' || hasSqlExtension(document);
}

const SQL_DOCUMENT_SELECTOR = [
  { language: 'sql' },
  { pattern: '**/*.sql' },
];

module.exports = {
  DEFINITION_SCHEME,
  SQL_DOCUMENT_SELECTOR,
  hasSqlExtension,
  isSqlDocument,
};
