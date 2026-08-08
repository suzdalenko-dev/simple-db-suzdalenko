'use strict';

const {
  extractSqlReference,
  navigationCandidates,
  resolveSqlDefinition,
  resolveSqlTargets,
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
      objectType: 'function',
    });
    expect(target.definition).toContain('FUNCTION public.calculate_total');
  });

  it('maps alias.column to the underlying relation and column', async () => {
    const sql = 'SELECT c.nombre FROM clientes c WHERE c.id = 1;';
    const reference = extractSqlReference(sql, sql.indexOf('nombre') + 2);
    expect(reference.aliasTarget).toEqual(['clientes']);

    const candidates = navigationCandidates(
      { id: 'pg', engine: 'postgresql', database: 'app' },
      { database: 'app', schema: 'public' },
      reference,
    );
    expect(candidates[0]).toMatchObject({
      database: 'app',
      schema: 'public',
      name: 'clientes',
      columnName: 'nombre',
    });

    const manager = {
      listObjectGroup: async (_id, _database, _schema, group) =>
        group === 'tables' ? [{ name: 'clientes' }] : [],
      listColumns: async () => [{ name: 'id' }, { name: 'nombre' }],
      getObjectDefinition: async () =>
        'CREATE TABLE public.clientes (id integer, nombre text);',
    };
    const targets = await resolveSqlTargets(
      manager,
      { id: 'pg', engine: 'postgresql', database: 'app' },
      { database: 'app', schema: 'public' },
      reference,
      'definition',
    );
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      name: 'clientes',
      columnName: 'nombre',
      objectType: 'table',
    });
    expect(
      targets[0].definition.slice(targets[0].definitionOffset),
    ).toMatch(/^nombre/i);
  });

  it('uses the Oracle package specification for declaration and body for definition', async () => {
    const source = [
      'CREATE OR REPLACE PACKAGE ORDER_API AS',
      '  PROCEDURE CREATE_ORDER(p_id NUMBER);',
      '  PROCEDURE CREATE_ORDER(p_id NUMBER, p_name VARCHAR2);',
      'END ORDER_API;',
      '/',
      '',
      'CREATE OR REPLACE PACKAGE BODY ORDER_API AS',
      '  PROCEDURE CREATE_ORDER(p_id NUMBER) IS BEGIN NULL; END;',
      '  PROCEDURE CREATE_ORDER(p_id NUMBER, p_name VARCHAR2) IS BEGIN NULL; END;',
      'END ORDER_API;',
      '/',
    ].join('\n');
    const sql = "BEGIN ORDER_API.CREATE_ORDER(123, 'ABC'); END;";
    const reference = extractSqlReference(sql, sql.indexOf('CREATE_ORDER') + 3);
    const manager = {
      listObjectGroup: async (_id, _database, schema, group) =>
        schema === 'FROXA' && group === 'packages'
          ? [{ name: 'ORDER_API', type: 'VALID' }]
          : [],
      getObjectDefinition: async () => source,
    };
    const profile = {
      id: 'oracle',
      engine: 'oracle',
      serviceName: 'ORCL',
      user: 'FROXA',
    };
    const session = { database: 'ORCL', schema: 'FROXA' };

    const [declaration] = await resolveSqlTargets(
      manager,
      profile,
      session,
      reference,
      'declaration',
    );
    const [definition] = await resolveSqlTargets(
      manager,
      profile,
      session,
      reference,
      'definition',
    );
    const bodyOffset = source.indexOf('PACKAGE BODY');
    expect(declaration.definitionOffset).toBeLessThan(bodyOffset);
    expect(definition.definitionOffset).toBeGreaterThan(bodyOffset);
    expect(source.slice(declaration.definitionOffset)).toMatch(/^CREATE_ORDER/i);
    expect(source.slice(definition.definitionOffset)).toMatch(/^CREATE_ORDER/i);
    expect(source.slice(definition.definitionOffset - 12, definition.definitionOffset + 60))
      .toContain('p_name VARCHAR2');
  });

  it('chooses the PostgreSQL overload compatible with the call signature', async () => {
    const sql = "SELECT calculate_total(7, 'EUR');";
    const reference = extractSqlReference(sql, sql.indexOf('calculate_total') + 3);
    const seenSignatures = [];
    const manager = {
      listObjectGroup: async (_id, _database, _schema, group) =>
        group === 'procedures'
          ? [
              {
                name: 'calculate_total',
                type: 'FUNCTION',
                signature: 'integer',
                argumentCount: 1,
                defaultArgumentCount: 0,
              },
              {
                name: 'calculate_total',
                type: 'FUNCTION',
                signature: 'integer, text',
                argumentCount: 2,
                defaultArgumentCount: 0,
              },
            ]
          : [],
      getObjectDefinition: async (_id, _database, _schema, _name, _type, metadata) => {
        seenSignatures.push(metadata.signature);
        return 'CREATE FUNCTION public.calculate_total(' + metadata.signature + ') RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql;';
      },
    };
    const targets = await resolveSqlTargets(
      manager,
      { id: 'pg', engine: 'postgresql', database: 'app' },
      { database: 'app', schema: 'public' },
      reference,
    );

    expect(targets).toHaveLength(1);
    expect(targets[0].metadata.signature).toBe('integer, text');
    expect(seenSignatures).toEqual(['integer, text']);
  });

  it('returns every equally valid overload instead of guessing', async () => {
    const sql = 'SELECT convert_value(input_value);';
    const reference = extractSqlReference(sql, sql.indexOf('convert_value') + 3);
    const manager = {
      listObjectGroup: async (_id, _database, _schema, group) =>
        group === 'procedures'
          ? [
              {
                name: 'convert_value',
                type: 'FUNCTION',
                signature: 'integer',
                argumentCount: 1,
              },
              {
                name: 'convert_value',
                type: 'FUNCTION',
                signature: 'text',
                argumentCount: 1,
              },
            ]
          : [],
      getObjectDefinition: async (_id, _database, _schema, _name, _type, metadata) =>
        'CREATE FUNCTION convert_value(' + metadata.signature + ') RETURNS text AS $$ SELECT NULL $$ LANGUAGE sql;',
    };
    const targets = await resolveSqlTargets(
      manager,
      { id: 'pg', engine: 'postgresql', database: 'app' },
      { database: 'app', schema: 'public' },
      reference,
    );

    expect(targets).toHaveLength(2);
    expect(targets.map((target) => target.metadata.signature)).toEqual([
      'integer',
      'text',
    ]);
  });

  it('follows an Oracle synonym to the source object', async () => {
    const sql = 'SELECT * FROM CLIENTES_ACTIVOS;';
    const reference = extractSqlReference(sql, sql.indexOf('CLIENTES_ACTIVOS') + 3);
    const manager = {
      listObjectGroup: async (_id, _database, schema, group) => {
        if (schema === 'FROXA' && group === 'synonyms') {
          return [
            {
              name: 'CLIENTES_ACTIVOS',
              owner: 'FROXA',
              target: 'CORE.CLIENTES',
            },
          ];
        }
        if (schema === 'CORE' && group === 'tables') {
          return [{ name: 'CLIENTES' }];
        }
        return [];
      },
      getObjectDefinition: async (_id, _database, schema, name) =>
        schema === 'CORE' && name === 'CLIENTES'
          ? 'CREATE TABLE CORE.CLIENTES (ID NUMBER);'
          : null,
    };
    const targets = await resolveSqlTargets(
      manager,
      { id: 'oracle', engine: 'oracle', serviceName: 'ORCL', user: 'FROXA' },
      { database: 'ORCL', schema: 'FROXA' },
      reference,
    );

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      schema: 'CORE',
      name: 'CLIENTES',
      objectType: 'table',
      synonymChain: ['FROXA.CLIENTES_ACTIVOS'],
    });
  });

  it('follows a local SQL Server synonym across database/schema qualifiers', async () => {
    const sql = 'SELECT * FROM ActiveCustomers;';
    const reference = extractSqlReference(sql, sql.indexOf('ActiveCustomers') + 3);
    const manager = {
      listObjectGroup: async (_id, database, schema, group) => {
        if (database === 'Sales' && schema === 'dbo' && group === 'synonyms') {
          return [
            {
              name: 'ActiveCustomers',
              target: '[Archive].[reporting].[Customers]',
            },
          ];
        }
        if (
          database === 'Archive' &&
          schema === 'reporting' &&
          group === 'tables'
        ) {
          return [{ name: 'Customers' }];
        }
        return [];
      },
      getObjectDefinition: async (_id, database, schema, name) =>
        database === 'Archive' && schema === 'reporting' && name === 'Customers'
          ? 'CREATE TABLE reporting.Customers (id bigint);'
          : null,
    };
    const targets = await resolveSqlTargets(
      manager,
      { id: 'mssql', engine: 'sqlserver', database: 'Sales' },
      { database: 'Sales', schema: 'dbo' },
      reference,
    );

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      database: 'Archive',
      schema: 'reporting',
      name: 'Customers',
      objectType: 'table',
    });
  });

  it('reports when an existing object source is not visible', async () => {
    const sql = 'SELECT * FROM secret_view;';
    const reference = extractSqlReference(sql, sql.indexOf('secret_view') + 2);
    const manager = {
      listObjectGroup: async (_id, _database, _schema, group) =>
        group === 'views' ? [{ name: 'secret_view' }] : [],
      getObjectDefinition: async () => null,
    };

    await expect(
      resolveSqlTargets(
        manager,
        { id: 'mssql', engine: 'sqlserver', database: 'Sales' },
        { database: 'Sales', schema: 'dbo' },
        reference,
      ),
    ).rejects.toMatchObject({
      code: 'SIMPLE_DB_NAVIGATION_SOURCE_UNAVAILABLE',
    });
  });
});
