'use strict';

const {
  DEFINITION_SCHEME,
  hasSqlExtension,
  isSqlDocument,
} = require('../sql/sqlDocument');

function document({ languageId = 'plaintext', scheme = 'file', path = '/work/query.sql' } = {}) {
  return {
    languageId,
    uri: { scheme, path },
  };
}

describe('SQL document recognition', () => {
  it('recognizes .sql files even when VS Code reports plaintext', () => {
    const sqlFile = document({ languageId: 'plaintext' });
    expect(hasSqlExtension(sqlFile)).toBe(true);
    expect(isSqlDocument(sqlFile)).toBe(true);
  });

  it('keeps SQL language documents supported even when they are untitled', () => {
    expect(
      isSqlDocument(document({ languageId: 'sql', scheme: 'untitled', path: 'Untitled-1' })),
    ).toBe(true);
  });

  it('does not treat unrelated plaintext files as SQL', () => {
    expect(isSqlDocument(document({ path: '/work/notes.txt' }))).toBe(false);
  });

  it('keeps generated definition documents out of executable editor sessions', () => {
    const definition = document({
      languageId: 'sql',
      scheme: DEFINITION_SCHEME,
      path: '/PACKAGE.sql',
    });
    expect(isSqlDocument(definition)).toBe(false);
    expect(isSqlDocument(definition, { allowDefinition: true })).toBe(true);
  });
});
