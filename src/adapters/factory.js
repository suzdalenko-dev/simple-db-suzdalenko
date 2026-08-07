'use strict';

const { MySqlAdapter } = require('./mysqlAdapter');
const { OracleAdapter } = require('./oracleAdapter');
const { PostgreSqlAdapter } = require('./postgresqlAdapter');
const { SqliteAdapter } = require('./sqliteAdapter');
const { SqlServerAdapter } = require('./sqlServerAdapter');

function createAdapter(profile, password) {
  switch (profile.engine) {
    case 'sqlite':
      return new SqliteAdapter(profile, password);
    case 'postgresql':
      return new PostgreSqlAdapter(profile, password);
    case 'mysql':
      return new MySqlAdapter(profile, password);
    case 'sqlserver':
      return new SqlServerAdapter(profile, password);
    case 'oracle':
      return new OracleAdapter(profile, password);
    default:
      throw new Error(`Motor no soportado: ${profile.engine}`);
  }
}

module.exports = {
  createAdapter,
};
