# Simple DB

Simple DB `0.1.6` is a Visual Studio Code extension written entirely in JavaScript for working with **SQLite, PostgreSQL, MySQL, SQL Server, and Oracle** through a single interface.

The extension opens regular VS Code SQL documents and loads `src/extension.js` directly: there is no TypeScript, `tsconfig.json`, `dist` folder, or compilation step.

## Main features

- Create, edit, test, and delete multiple connections for each database engine.
- Keep every connection in its own readable JSON file and edit all connection parameters in one place.
- Store passwords in `SecretStorage`, never inside profiles or the repository.
- Connect to several database engines simultaneously and disconnect them explicitly.
- Explore databases, schemas, and engine-specific objects.
- Attach any regular `.sql` file to a connection from the editor toolbar/status bar. Saved files remember that connection on the same VS Code installation until you change it.
- Execute the selection, the statement at the cursor, or the entire document.
- Execute arbitrary SQL: `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, and any other syntax accepted by the server.
- Generate `CREATE`, `ALTER`, and `DROP` scripts from the explorer and inspect object definitions/DDL.
- Use explicit per-editor transactions with `BEGIN`, `COMMIT`, and `ROLLBACK`.
- Cancel queries and configure query timeouts per connection.
- View results below the SQL editor in a resizable SQL Developer-style grid with row numbers, multiple result sets, types, `NULL`, affected rows, duration, and cell/row/selection copy actions.
- Preserve 64-bit integers and high-precision `NUMBER` values exactly before displaying or exporting them.
- Export already-retrieved results to CSV, JSON, or XLSX without executing the SQL again.
- Use **Go to Definition** / **Go to Declaration** for tables, views, routines, packages, triggers, types, sequences, indexes, synonyms, and other source/DDL-backed objects supported by each engine.
- Navigate through table aliases/columns, PostgreSQL and Oracle overloads, Oracle package specifications/bodies, and synonym targets without losing the SQL file's connection context.

## Quick start

1. Open **Simple DB** in the Activity Bar and choose **Create Connection**. The Command Palette exposes one Simple DB entry, **Simple DB: Open Configuration**, which opens this same view.
2. Select the database engine and enter a connection name. SQLite uses the native file picker; network databases create a JSON profile with the correct default parameters.
3. Edit the generated JSON if needed, press `Ctrl+S`, then use **Test Connection** or **Connect** from the connection menu. Passwords stay outside JSON in VS Code `SecretStorage`.
4. Open or create any `.sql` file. Right-click and use **Simple DB > Select / Change Connection...**, or click the database status-bar item, to choose the connection this file should use. The picker also offers **Create New Connection...**. If you press `Ctrl+Enter` before choosing, Simple DB opens the same picker and then attaches the selected connection automatically.
5. Press `Ctrl+Enter` (**Run Statement**) to run the selection or statement at the cursor. Press `F5` (**Run Script**) for the entire document. Saved SQL files keep their selected connection when closed and reopened.
6. Results appear automatically in the resizable **Simple DB — Results** panel below the SQL editor. `F12` / **Go to Definition** opens the implementation/source; **Go to Declaration** opens the declaration when the engine exposes a separate one.

## Five database engines

| Engine | Driver | Notable dialect and explorer support |
|---|---|---|
| SQLite | `sql.js` in a Worker | tables, views, indexes, triggers, PRAGMA, transactions |
| PostgreSQL | `pg` + `pg-cursor` | databases, schemas, tables, views/materialized views, routines, indexes, triggers, sequences, types, `$$` |
| MySQL | `mysql2` | databases/schemas, tables, views, routines, indexes, triggers, events, `DELIMITER` |
| SQL Server | `mssql` | databases, schemas, tables, views, procedures/functions, indexes, triggers, sequences, types, synonyms, `GO` |
| Oracle | `oracledb` Thin | schemas, tables, views/materialized views, procedures/functions, packages, indexes, triggers, sequences, types, synonyms, PL/SQL |

Oracle uses the default `node-oracledb` Thin mode, so normal connections do not require Oracle Client to be installed. Simple DB `0.1.6` uses SQL authentication with a username and password for SQL Server.

## No imposed row limit by default

`simpleDb.maxRows` defaults to **`0`, which means unlimited rows**.

Simple DB does not automatically add `TOP`, `LIMIT`, or `FETCH` to a query. Drivers consume results through cursors, result sets, or streaming, and temporary result storage is divided into pages so the webview does not receive every row at once.

`simpleDb.resultPageSize` (500 by default) controls only the temporary storage/display page size; **it is not a row limit**. If a user wants a limit, `simpleDb.maxRows` can be set to a value greater than zero.

## Explorer and DDL

Visible object groups depend on the database engine. From an object you can:

- open `SELECT *` for tables, views, and materialized views without adding a SQL row limit;
- show its definition when the server catalog provides one;
- prepare an `ALTER` script;
- prepare a `DROP` script;
- copy its qualified name.

From a database, schema, or object group, you can prepare a `CREATE` script for the corresponding object type. Generated scripts open in an editor first so the user can review them and decide whether to execute them.

`DROP` and `TRUNCATE` request confirmation by default. Simple DB also warns before `UPDATE` or `DELETE` without a `WHERE` clause. Both behaviors are configurable.

## Dialect-aware execution

Documents are not split with a simple `split(';')`. The parser understands:

- PostgreSQL: strings, comments, and dollar-quoted blocks such as `$$ ... $$`;
- MySQL: `DELIMITER`, strings, `--`, `/* ... */`, and `#` comments;
- SQL Server: `GO` and `GO n` batches;
- Oracle: `DECLARE`/`BEGIN` blocks, procedures, functions, packages, types, triggers, `/` terminators, and `q'[...]'` literals;
- SQLite: `CREATE TRIGGER ... BEGIN ... END` with internal statements.

Document execution stops on the first error and selects the failed block. An explicit selection is processed only within its boundaries, and client separators (`GO`, `DELIMITER`, `/`) are not sent to the server.

## Transactions

Each SQL editor has an independent session identifier. A transaction reserves its physical connection until `COMMIT` or `ROLLBACK`.

- Closing an editor with an active transaction performs `ROLLBACK` and shows a warning.
- Disconnecting a connection with open transactions requires confirmation and performs `ROLLBACK`.
- After an error or cancellation inside a transaction, the status bar can require `ROLLBACK`.
- SQLite prevents another tab from using the same adapter while an editor has an open transaction.

## Results, copy, and export

Executing SQL automatically reveals the **Simple DB** view in VS Code's lower Panel while keeping the SQL editor visible above it. `SELECT` results are displayed in a spreadsheet-like grid with a sticky header, row numbers, horizontal/vertical scrolling, page navigation, and tabs for multiple result sets.

The result grid distinguishes `NULL`, shows column types, supports selecting a cell or a range with `Shift`, and can copy a cell, row, or selection. Non-query statements display their execution message and affected-row information in the same lower Results view.

CSV, JSON, and XLSX are streamed from the retrieved temporary result pages. The query is not executed again. Very large cell values are bounded for display by `simpleDb.maxCellCharacters`; the UI explicitly indicates when a cell has been truncated for display.

CSV export protects values that spreadsheet applications could interpret as formulas by default. This protection can be disabled when literal CSV output is required.

## Connections and security

- **Create Connection** asks only for the database engine, a connection name, and a password for network databases. SQLite uses the native file picker.
- Simple DB then creates one readable JSON file per connection and opens it in VS Code so host, port, database/service, username, TLS options, and timeouts can be edited together.
- Saving a connection JSON with `Ctrl+S` reloads that connection automatically. Existing connections from Simple DB 0.1.1 are migrated to JSON files on first launch.
- **Open Connection JSON** opens the selected profile, **Set Password** changes its secure password, and **Open Connections Folder** reveals all local connection files.
- Connection JSON files never contain passwords. Passwords are stored with the VS Code `SecretStorage` API.
- SSL/TLS, encryption, and certificate trust are explicit options where supported by the database engine.
- `simpleDb.confirmDestructiveQueries` is enabled by default.
- `simpleDb.warnUnsafeDml` is enabled by default.

Example Oracle connection JSON:

```json
{
  "id": "generated-by-simple-db",
  "name": "Oracle Production",
  "engine": "oracle",
  "host": "192.168.1.20",
  "port": 1521,
  "serviceName": "ORCLPDB1",
  "connectString": "",
  "user": "report_user",
  "connectTimeoutMs": 15000,
  "queryTimeoutMs": 300000
}
```

Example SQLite connection JSON:

```json
{
  "id": "generated-by-simple-db",
  "name": "Local SQLite",
  "engine": "sqlite",
  "filePath": "C:\\data\\sample.db",
  "readOnly": false,
  "connectTimeoutMs": 15000,
  "queryTimeoutMs": 300000
}
```

The `id` is generated and managed by Simple DB. Do not change it. Use **Simple DB: Set Password** instead of adding a `password` field to a JSON file.

### Editor context menu

Right-clicking inside any regular SQL editor shows a native **Simple DB** submenu with the complete working set:

- Open Configuration
- Refresh Connections
- Open Connections Folder
- Select / Change Connection...
- Create Connection
- Connect / Disconnect
- Test Connection
- Open Connection JSON
- Set Password
- Delete Connection
- New Query
- Run Statement (`Ctrl+Enter`)
- Execute Selection
- Run Script (`F5`)
- Cancel Query
- Begin Transaction / Commit / Rollback
- Go to Definition (`F12`)
- Go to Declaration
- Go to Package Specification
- Go to Package Body

**Open Configuration** opens the same Simple DB Activity Bar view as clicking the Simple DB icon, where all configured database connections and their explorer actions are available. The Command Palette intentionally exposes only **Simple DB: Open Configuration**; SQL-file actions stay in this right-click submenu, their keyboard shortcuts, and the SQL editor controls. Connection actions invoked from a SQL file operate on the connection attached to that file. If no connection is attached yet, Simple DB opens the connection picker first.

The lower-right status bar shows the profile currently attached to the SQL file. **Select / Change Connection...** marks that profile in the picker and lets the file switch to another one. If there are no profiles yet, **Create New Connection...** is available directly in the picker. The picker and connection-creation prompts can be cancelled with **Cancel / Close**, `Esc`, or by clicking outside. Cancelling nested connection creation closes the selection flow instead of reopening it.

Navigation resolves against the connection attached to the SQL file and opens database-provided source/DDL in a read-only virtual SQL document. Oracle package **Go to Declaration** targets the package specification while **Go to Definition** targets the package body. **Go to Package Specification** and **Go to Package Body** provide explicit package-only navigation when the symbol under the cursor resolves to an Oracle package or package member. When an overload can be identified from the call arguments, Simple DB selects it; when several overloads remain valid, it presents all valid locations instead of guessing. `alias.column` references are resolved back to their underlying table/view column, Oracle and SQL Server synonyms are followed to the target object when it is local/resolvable, and navigation can continue from one opened database definition into another. If catalog/source permissions are insufficient, Simple DB reports that explicitly.

### SQLite note

SQLite runs in a dedicated WebAssembly Worker so long-running queries do not block the UI and can be cancelled by terminating the Worker. The database file is held as an in-memory snapshot while connected. Before every operation, Simple DB checks whether the main file, WAL, or journal changed externally. If a conflict is detected, it refuses to continue and asks the user to reconnect. If an active WAL exists when the connection is opened, the connection is rejected until the owning process checkpoints/closes the WAL, preventing Simple DB from loading or overwriting an incomplete snapshot.

## Configuration

| Setting | Default | Purpose |
|---|---:|---|
| `simpleDb.maxRows` | `0` | Optional limit per result set; `0` = unlimited |
| `simpleDb.resultPageSize` | `500` | Rows per temporary storage/display page |
| `simpleDb.maxCellCharacters` | `10000` | Maximum characters retained per cell in results |
| `simpleDb.confirmDestructiveQueries` | `true` | Confirm `DROP`/`TRUNCATE` |
| `simpleDb.warnUnsafeDml` | `true` | Warn about `UPDATE`/`DELETE` without `WHERE` |
| `simpleDb.csvDelimiter` | `;` | CSV export delimiter |
| `simpleDb.csvProtectFormulaInjection` | `true` | Neutralize potential spreadsheet formulas in CSV export |

Connection timeout and maximum query timeout are configured per connection profile. A query timeout of `0` means no timeout.

## Development

Requirements:

- Visual Studio Code `1.95.0` or later.
- Node.js `20` or later for development.
- npm.

```bash
npm ci
npm run check
```

Then open the repository in VS Code and press `F5` with the **Run Simple DB** launch configuration. The `preLaunchTask` runs ESLint and the Extension Host loads `src/extension.js` directly.

Project commands:

| Command | Purpose |
|---|---|
| `npm run lint` | Run ESLint on JavaScript sources |
| `npm test` | Run JavaScript Vitest tests |
| `npm run test:live-navigation` | Run read-only metadata/source smoke checks against real server profiles plus a temporary real SQLite database |
| `npm run check` | Run lint + tests |
| `npm run package` | Validate and build the VSIX |
| `npm run package:win32` | Build a `win32-x64` VSIX |
| `npm run package:linux` | Build a `linux-x64` VSIX |

The normal test suite covers parsing, safety rules, DDL, storage, mocked `SecretStorage`, advanced SQL navigation, and a real SQLite integration. External PostgreSQL, MySQL, SQL Server, and Oracle servers require their own credentials/infrastructure for live verification.

`npm run test:live-navigation` intentionally does not use mocks. Before running all five engines, define JSON profiles in `SIMPLE_DB_LIVE_POSTGRESQL_PROFILE`, `SIMPLE_DB_LIVE_MYSQL_PROFILE`, `SIMPLE_DB_LIVE_SQLSERVER_PROFILE`, and `SIMPLE_DB_LIVE_ORACLE_PROFILE`, with the matching passwords in `SIMPLE_DB_LIVE_<ENGINE>_PASSWORD`. An optional `navigationTestSchema` property selects the schema to inspect. `SIMPLE_DB_LIVE_ENGINES=sqlite` can be used to run only the self-contained SQLite live check. The live check only reads catalogs/source on the server engines; its SQLite database is created in a temporary directory.

## Project structure

```text
src/
  adapters/      # five adapters and the SQLite Worker
  core/          # errors and value normalization
  managers/      # connections and editor sessions
  services/      # execution and export
  sql/           # dialect-aware splitter, safety rules, and DDL
  storage/       # connection profiles, editor bindings, and paged results
  test/          # JavaScript tests
  ui/            # connection form
  views/         # trees and lower result grid
  extension.js   # activate/deactivate
```

## License

MIT. See `LICENSE`.
