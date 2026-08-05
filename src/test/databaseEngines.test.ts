import { describe, expect, it } from 'vitest';

import { DATABASE_ENGINES } from '../databaseEngines';

describe('DATABASE_ENGINES', () => {
  it('declara los cuatro motores previstos sin identificadores repetidos', () => {
    const ids = DATABASE_ENGINES.map((engine) => engine.id);

    expect(ids).toEqual(['postgresql', 'mysql', 'sqlserver', 'oracle']);
    expect(new Set(ids).size).toBe(DATABASE_ENGINES.length);
  });

  it('utiliza los puertos predeterminados correctos', () => {
    const ports = Object.fromEntries(
      DATABASE_ENGINES.map((engine) => [engine.id, engine.defaultPort]),
    );

    expect(ports).toEqual({
      postgresql: 5432,
      mysql: 3306,
      sqlserver: 1433,
      oracle: 1521,
    });
  });
});
