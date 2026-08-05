export type DatabaseEngineId =
  | 'postgresql'
  | 'mysql'
  | 'sqlserver'
  | 'oracle';

export interface DatabaseEngineDefinition {
  readonly id: DatabaseEngineId;
  readonly displayName: string;
  readonly defaultPort: number;
}

export const DATABASE_ENGINES: readonly DatabaseEngineDefinition[] = Object.freeze([
  {
    id: 'postgresql',
    displayName: 'PostgreSQL',
    defaultPort: 5432,
  },
  {
    id: 'mysql',
    displayName: 'MySQL',
    defaultPort: 3306,
  },
  {
    id: 'sqlserver',
    displayName: 'SQL Server',
    defaultPort: 1433,
  },
  {
    id: 'oracle',
    displayName: 'Oracle',
    defaultPort: 1521,
  },
]);
