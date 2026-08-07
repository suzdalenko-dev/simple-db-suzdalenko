# Changelog

Todos los cambios relevantes de Simple DB se documentan en este archivo.

## 0.1.1 - 2026-08-07

### Añadido

- SQLite como quinto motor, ejecutado con `sql.js` en un Worker cancelable.
- Adaptadores completos para SQLite, PostgreSQL, MySQL, SQL Server y Oracle.
- Perfiles múltiples, prueba de conexión, conexión/desconexión y contraseñas en `SecretStorage`.
- Exploración de bases, esquemas y objetos específicos: tablas, vistas, vistas materializadas, rutinas, packages Oracle, índices, triggers, secuencias, tipos, sinónimos y eventos MySQL según el motor.
- Editor SQL por sesión y contexto de base/esquema.
- Parser de dialecto para PostgreSQL `$$`, MySQL `DELIMITER`, SQL Server `GO`, Oracle PL/SQL `/` y triggers SQLite.
- Ejecución de selección, sentencia actual o documento; DML, DDL y SQL arbitrario.
- Lectura/plantillas de DDL con acciones para mostrar definición, preparar `CREATE`, `ALTER` y `DROP`.
- Transacciones por editor, `COMMIT`, `ROLLBACK`, cancelación y timeouts.
- Resultados paginados en disco, múltiples result sets, copia de celda/fila/selección y exportación CSV/JSON/XLSX.
- Historial configurable, duración, filas recuperadas y filas afectadas.
- Confirmaciones configurables para operaciones destructivas y DML sin `WHERE`.
- Pruebas automatizadas íntegramente en JavaScript, incluida integración real del adaptador SQLite.
- Protección SQLite frente a cambios externos y WAL activo, además de lectura exacta de enteros de 64 bits.
- DDL específico por motor para índices/triggers y eliminación correcta de índices respaldados por constraints cuando el catálogo aporta esa información.
- Protección de inicios de transacción escritos como SQL para mantener PostgreSQL/MySQL sobre una conexión física reservada, incluidas variantes de `START TRANSACTION`.
- Protección frente a inyección de fórmulas al exportar CSV y preservación de `NUMBER` Oracle como texto exacto.

### Cambiado

- Proyecto migrado completamente de TypeScript a JavaScript: no quedan `.ts`, `tsconfig.json` ni compilación TypeScript.
- `F5` carga directamente `src/extension.js`.
- `simpleDb.maxRows` pasa a `0` por defecto, es decir, **sin límite de filas**. El usuario puede configurar uno si lo necesita.
- La paginación de resultados es almacenamiento/visualización y no altera el SQL con `TOP`, `LIMIT` o `FETCH`.
- CI verifica JavaScript mediante lint, tests y empaquetado VSIX.
- Dependencias bloqueadas por lockfile y auditoría npm integrada en CI.

## 0.0.1 - 2026-08-05

### Añadido

- Esqueleto inicial de la extensión.
