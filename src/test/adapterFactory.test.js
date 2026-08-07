'use strict';

const { createAdapter } = require('../adapters/factory');

const profiles = [
  { id: 'sqlite', engine: 'sqlite', filePath: '/tmp/test.db' },
  { id: 'postgresql', engine: 'postgresql', host: 'localhost', database: 'db', user: 'u' },
  { id: 'mysql', engine: 'mysql', host: 'localhost', database: 'db', user: 'u' },
  { id: 'sqlserver', engine: 'sqlserver', host: 'localhost', database: 'db', user: 'u' },
  { id: 'oracle', engine: 'oracle', host: 'localhost', serviceName: 'svc', user: 'u' },
];

describe('adapter factory contract', () => {
  it.each(profiles)('loads the $engine adapter and satisfies the common contract', (profile) => {
    const adapter = createAdapter(profile, 'password');
    for (const method of [
      'connect',
      'disconnect',
      'execute',
      'begin',
      'commit',
      'rollback',
      'cancel',
      'listDatabases',
      'listSchemas',
      'listTables',
      'listViews',
      'listColumns',
      'listProcedures',
      'getObjectDefinition',
      'quoteIdentifier',
      'quoteTable',
    ]) {
      expect(typeof adapter[method], `${profile.engine}.${method}`).toBe('function');
    }
  });

  it('rejects unknown engines', () => {
    expect(() => createAdapter({ engine: 'unknown' }, '')).toThrow(/unsupported database engine/i);
  });
});
