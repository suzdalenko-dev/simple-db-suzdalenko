# Changelog

All notable changes to Simple DB are documented in this file.

## 0.1.2 - 2026-08-08

### Added

- One readable JSON file per database connection, stored locally by Simple DB.
- Automatic migration of existing 0.1.1 connection profiles to JSON files.
- `Open Connection JSON`, `Set Password`, and `Open Connections Folder` actions.
- A native `Simple DB` editor context submenu containing the six main database actions.
- A resizable `Simple DB` Results view in the lower VS Code Panel, with a SQL Developer-style data grid and row numbers.

### Changed

- Simplified connection creation: choose the engine and name, optionally enter a secure network password, then edit all non-secret connection parameters together in JSON.
- Passwords remain in VS Code `SecretStorage` and are explicitly rejected from connection JSON files.
- Query results now open below the SQL editor instead of in a separate editor tab, keeping the SQL document visible while results are inspected.

### Fixed

- Fixed the Results webview script error that could leave successful `SELECT` queries stuck on `Loading results…`.

## 0.1.1 - 2026-08-07

### Added

- SQLite as the fifth database engine, running with `sql.js` in a cancellable Worker.
- Full adapters for SQLite, PostgreSQL, MySQL, SQL Server, and Oracle.
- Multiple profiles, connection testing, connect/disconnect actions, and passwords stored in `SecretStorage`.
- Exploration of databases, schemas, and engine-specific objects: tables, views, materialized views, routines, Oracle packages, indexes, triggers, sequences, types, synonyms, and MySQL events where supported.
- SQL editor sessions with database/schema context.
- Dialect-aware parsing for PostgreSQL `$$`, MySQL `DELIMITER`, SQL Server `GO`, Oracle PL/SQL `/`, and SQLite triggers.
- Selection, current-statement, and document execution for DML, DDL, and arbitrary SQL.
- DDL inspection/templates with actions to show definitions and prepare `CREATE`, `ALTER`, and `DROP` scripts.
- Per-editor transactions, `COMMIT`, `ROLLBACK`, cancellation, and timeouts.
- Disk-backed paged results, multiple result sets, cell/row/selection copy actions, and CSV/JSON/XLSX export.
- Configurable history with duration, retrieved rows, and affected rows.
- Configurable confirmations for destructive operations and DML without `WHERE`.
- Automated tests written entirely in JavaScript, including real SQLite adapter integration.
- SQLite protection against external file changes and active WAL files, plus exact 64-bit integer reads.
- Engine-specific DDL for indexes/triggers and correct removal of constraint-backed indexes when the catalog provides the required information.
- Protection for transaction-start statements written as SQL so PostgreSQL/MySQL remain on a reserved physical connection, including `START TRANSACTION` variants.
- CSV formula-injection protection and exact Oracle `NUMBER` preservation as text.

### Changed

- Standardized the README, project documentation, commands, settings, UI messages, generated-template guidance, comments, and test descriptions in English.
- Improved Marketplace discovery with a database-focused display name, expanded search keywords, an English description, and a dedicated Simple DB Marketplace icon.
- Migrated the project completely from TypeScript to JavaScript: no `.ts`, `tsconfig.json`, or TypeScript compilation remains.
- `F5` loads `src/extension.js` directly.
- `simpleDb.maxRows` now defaults to `0`, meaning **no row limit**. Users can configure a limit if needed.
- Result pagination is a storage/display mechanism and does not alter SQL with `TOP`, `LIMIT`, or `FETCH`.
- CI validates JavaScript with linting, tests, and VSIX packaging.
- Dependencies are locked through the lockfile and production dependency auditing is integrated into CI.

## 0.0.1 - 2026-08-05

### Added

- Initial extension skeleton.
