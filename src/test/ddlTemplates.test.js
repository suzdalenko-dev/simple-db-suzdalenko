'use strict';

const {
  OBJECT_TYPES_BY_ENGINE,
  alterTemplate,
  createTemplate,
  dropTemplate,
  objectTypesForEngine,
} = require('../sql/ddlTemplates');

const quote = (value) => `"${value}"`;

describe('DDL templates', () => {
  it('ofrece CREATE/ALTER/DROP para todos los tipos anunciados', () => {
    for (const [engine, types] of Object.entries(OBJECT_TYPES_BY_ENGINE)) {
      expect(objectTypesForEngine(engine)).toEqual(types);
      for (const type of types) {
        const created = createTemplate(engine, type, '"schema"."object"', quote, {
          identifierName: '"object"',
        });
        const altered = alterTemplate(engine, type, '"schema"."object"');
        const dropped = dropTemplate(engine, type, '"schema"."object"');
        expect(created.length).toBeGreaterThan(10);
        expect(altered.length).toBeGreaterThan(5);
        expect(dropped).toMatch(/^DROP /);
      }
    }
  });

  it('crea un DROP INDEX correcto para MySQL y SQL Server cuando conoce la tabla', () => {
    expect(
      dropTemplate('mysql', 'index', '`db`.`idx`', {
        identifierName: '`idx`',
        tableQualifiedName: '`db`.`items`',
      }),
    ).toBe('DROP INDEX `idx` ON `db`.`items`;');
    expect(
      dropTemplate('sqlserver', 'index', '[dbo].[idx]', {
        identifierName: '[idx]',
        tableQualifiedName: '[dbo].[items]',
      }),
    ).toBe('DROP INDEX [idx] ON [dbo].[items];');
  });

  it('respeta las reglas DDL especiales de índices, triggers y constraints', () => {
    expect(
      createTemplate('postgresql', 'index', '"public"."idx_items"', quote, {
        identifierName: '"idx_items"',
      }),
    ).toMatch(/^CREATE INDEX "idx_items"/);
    expect(
      createTemplate('postgresql', 'trigger', '"public"."trg_items"', quote, {
        identifierName: '"trg_items"',
      }),
    ).toContain('CREATE TRIGGER "trg_items"');
    expect(
      dropTemplate('postgresql', 'trigger', '"public"."trg_items"', {
        identifierName: '"trg_items"',
        tableQualifiedName: '"public"."items"',
      }),
    ).toBe('DROP TRIGGER IF EXISTS "trg_items" ON "public"."items";');
    expect(
      dropTemplate('mysql', 'index', '`db`.`PRIMARY`', {
        identifierName: '`PRIMARY`',
        objectName: 'PRIMARY',
        tableQualifiedName: '`db`.`items`',
      }),
    ).toBe('ALTER TABLE `db`.`items` DROP PRIMARY KEY;');
    expect(
      dropTemplate('sqlserver', 'index', '[dbo].[PK_items]', {
        identifierName: '[PK_items]',
        isConstraint: true,
        tableQualifiedName: '[dbo].[items]',
      }),
    ).toBe('ALTER TABLE [dbo].[items] DROP CONSTRAINT [PK_items];');
    expect(
      dropTemplate('postgresql', 'index', '"public"."items_pkey"', {
        constraintName: '"items_pkey"',
        tableQualifiedName: '"public"."items"',
      }),
    ).toBe('ALTER TABLE "public"."items" DROP CONSTRAINT IF EXISTS "items_pkey";');
  });

  it('genera ALTER específico cuando el motor necesita el nombre de tabla', () => {
    expect(
      alterTemplate('sqlserver', 'index', '[dbo].[idx]', {
        identifierName: '[idx]',
        tableQualifiedName: '[dbo].[items]',
      }),
    ).toContain('ALTER INDEX [idx] ON [dbo].[items]');
    expect(
      alterTemplate('postgresql', 'trigger', '"public"."trg"', {
        identifierName: '"trg"',
        tableQualifiedName: '"public"."items"',
      }),
    ).toContain('ALTER TRIGGER "trg" ON "public"."items"');
  });

  it('no introduce TOP/LIMIT/FETCH en las plantillas SELECT', () => {
    for (const engine of Object.keys(OBJECT_TYPES_BY_ENGINE)) {
      if (!objectTypesForEngine(engine).includes('view')) continue;
      const sql = createTemplate(engine, 'view', 'demo', quote);
      expect(sql).not.toMatch(/\b(?:TOP|LIMIT|FETCH)\b/i);
    }
  });
});
