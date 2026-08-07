'use strict';

const {
  DATABASE_ENGINES,
  DATABASE_ENGINE_IDS,
  getDatabaseEngine,
  isDatabaseEngineId,
} = require('../databaseEngines');

describe('databaseEngines', () => {
  it('expone exactamente los cinco motores soportados', () => {
    expect(DATABASE_ENGINE_IDS).toEqual([
      'sqlite',
      'postgresql',
      'mysql',
      'sqlserver',
      'oracle',
    ]);
    expect(DATABASE_ENGINES).toHaveLength(5);
  });

  it('define puertos y grupos de objetos propios de cada motor', () => {
    expect(getDatabaseEngine('sqlite').defaultPort).toBeNull();
    expect(getDatabaseEngine('postgresql').defaultPort).toBe(5432);
    expect(getDatabaseEngine('mysql').defaultPort).toBe(3306);
    expect(getDatabaseEngine('sqlserver').defaultPort).toBe(1433);
    expect(getDatabaseEngine('oracle').defaultPort).toBe(1521);
    expect(getDatabaseEngine('oracle').objectGroups).toContain('packages');
    expect(getDatabaseEngine('postgresql').objectGroups).toContain('materializedViews');
    expect(getDatabaseEngine('mysql').objectGroups).toContain('events');
  });

  it('valida identificadores de motor sin aceptar valores desconocidos', () => {
    expect(isDatabaseEngineId('oracle')).toBe(true);
    expect(isDatabaseEngineId('mongo')).toBe(false);
    expect(getDatabaseEngine('mongo')).toBeUndefined();
  });
});
