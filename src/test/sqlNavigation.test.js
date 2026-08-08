'use strict';

const {
  extractSqlReference,
  navigationCandidates,
  resolveSqlDefinition,
} = require('../services/sqlNavigation');

describe('SQL navigation', () => {
  it('extracts qualified and quoted identifiers at the cursor', () => {
    const sql = 'SELECT * FROM "Sales"."Order Lines";';
    const reference = extractSqlReference(sql, sql.indexOf('Order') + 2);

    expect(reference.parts).toEqual(['Sales', 'Order Lines']);
  });

  it('maps SQL Server three-part names to database, schema, and object', () => {
    const [candidate] = navigationCandidates(
      { id: 'mssql', engine: 'sqlserver', database: 'master' },
      { database: 'master', schema: 'dbo' },
      { parts: ['SalesDb', 'reporting', 'BuildReport'] },
    );

    expect(candidate).toMatchObject({
      database: 'SalesDb',
      schema: 'reporting',
      name: 'BuildReport',
    });
  });

  it('resolves an Oracle package member to the package source', async () => {
    const calls = [];
    const manager = {
      listObjectGroup: async (_profileId, _database, schema, group) => {
        calls.push({ schema, group });
        if (schema === 'FROXA' && group === 'packages') {
          return [{ name: 'ORDER_API', type: 'VALID' }];
        }
        return [];
      },
      getObjectDefinition: async (_profileId, _database, schema, name, type) => {
        expect({ schema, name, type }).toEqual({
          schema: 'FROXA',
          name: 'ORDER_API',
          type: 'package',
        });
        return 'CREATE OR REPLACE PACKAGE ORDER_API AS\n  PROCEDURE CREATE_ORDER;\nEND;';
      },
    };

    const target = await resolveSqlDefinition(
      manager,
      { id: 'oracle', engine: 'oracle', serviceName: 'ORCL', user: 'froxa' },
      { database: 'ORCL', schema: 'FROXA' },
      { parts: ['ORDER_API', 'CREATE_ORDER'] },
    );

    expect(target).toMatchObject({
      schema: 'FROXA',
      name: 'ORDER_API',
      memberName: 'CREATE_ORDER',
      objectType: 'package',
    });
    expect(target.definition).toContain('PROCEDURE CREATE_ORDER');
    expect(calls).toContainEqual({ schema: 'FROXA', group: 'packages' });
  });

  it('resolves a PostgreSQL function through the native routine metadata', async () => {
    const manager = {
      listObjectGroup: async (_profileId, _database, schema, group) =>
        schema === 'public' && group === 'procedures'
          ? [{ name: 'calculate_total', type: 'FUNCTION', signature: 'integer' }]
          : [],
      getObjectDefinition: async () =>
        'CREATE OR REPLACE FUNCTION public.calculate_total(integer) RETURNS integer AS $$ SELECT $1 $$ LANGUAGE sql;',
    };

    const target = await resolveSqlDefinition(
      manager,
      { id: 'pg', engine: 'postgresql', database: 'app' },
      { database: 'app', schema: 'public' },
      { parts: ['calculate_total'] },
    );

    expect(target).toMatchObject({
      schema: 'public',
      name: 'calculate_total',
      objectType: 'procedure',
    });
    expect(target.definition).toContain('FUNCTION public.calculate_total');
  });
});
