# Simple DB

Simple DB `0.1.1` es una extensión de Visual Studio Code, escrita íntegramente en JavaScript, para trabajar con **SQLite, PostgreSQL, MySQL, SQL Server y Oracle** desde una interfaz común.

La extensión abre documentos SQL normales de VS Code. `F5` inicia directamente `src/extension.js`: no hay TypeScript, `tsconfig.json`, carpeta `dist` ni paso de compilación.

## Funciones principales

- Crear, editar, probar y eliminar múltiples conexiones por motor.
- Contraseñas en `SecretStorage`; nunca dentro de los perfiles ni del repositorio.
- Conectar varios motores simultáneamente y desconectarlos de forma explícita.
- Explorar bases de datos, esquemas y los objetos propios de cada motor.
- Abrir editores SQL vinculados a una conexión, base de datos y esquema.
- Ejecutar la selección, la sentencia del cursor o el documento completo.
- Ejecutar SQL libre: `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `CREATE`, `ALTER`, `DROP`, `TRUNCATE` y demás sintaxis que acepte el servidor.
- Crear scripts `CREATE`, `ALTER` y `DROP` desde el explorador y consultar la definición/DDL de objetos.
- Transacciones explícitas por editor con `BEGIN`, `COMMIT` y `ROLLBACK`.
- Cancelar consultas y aplicar timeout configurable por conexión.
- Resultados con varias tablas, tipos, `NULL`, filas afectadas, duración y copia de celda/fila/selección.
- Conservación de enteros de 64 bits/`NUMBER` de alta precisión como valores exactos antes de mostrarlos o exportarlos.
- Exportar el resultado ya recuperado a CSV, JSON o XLSX sin volver a ejecutar el SQL.
- Historial local configurable con reapertura, copia y reejecución.

## Cinco motores

| Motor | Driver | Dialecto y exploración destacada |
|---|---|---|
| SQLite | `sql.js` en Worker | tablas, vistas, índices, triggers, PRAGMA, transacciones |
| PostgreSQL | `pg` + `pg-cursor` | bases, esquemas, tablas, vistas/materializadas, rutinas, índices, triggers, secuencias, tipos, `$$` |
| MySQL | `mysql2` | bases/esquemas, tablas, vistas, rutinas, índices, triggers, eventos, `DELIMITER` |
| SQL Server | `mssql` | bases, esquemas, tablas, vistas, procedimientos/funciones, índices, triggers, secuencias, tipos, sinónimos, `GO` |
| Oracle | `oracledb` Thin | esquemas, tablas, vistas/materializadas, procedimientos/funciones, packages, índices, triggers, secuencias, tipos, sinónimos, PL/SQL |

Oracle utiliza el modo Thin predeterminado de `node-oracledb`, por lo que las conexiones habituales no requieren instalar Oracle Client. SQL Server `0.1.1` utiliza autenticación SQL con usuario y contraseña.

## Resultados sin límite impuesto por defecto

`simpleDb.maxRows` vale **`0` por defecto: sin límite de filas**.

Simple DB no añade automáticamente `TOP`, `LIMIT` ni `FETCH` a una consulta. Los drivers consumen los resultados mediante cursor, result set o streaming y el almacenamiento temporal se divide en páginas para no enviar todas las filas de golpe al webview.

`simpleDb.resultPageSize` (500 por defecto) es únicamente el tamaño de página de almacenamiento/visualización; **no es un límite de filas**. Si el usuario quiere un límite, puede asignar a `simpleDb.maxRows` un valor mayor que cero.

## Explorador y DDL

Los grupos visibles dependen del motor. Desde un objeto se puede:

- abrir `SELECT *` para tablas, vistas y vistas materializadas, sin límite SQL añadido;
- mostrar su definición cuando el catálogo del servidor la ofrece;
- preparar un script `ALTER`;
- preparar un script `DROP`;
- copiar su nombre cualificado.

Desde una base, esquema o grupo se puede preparar un `CREATE` del tipo correspondiente. Los scripts se abren primero en un editor: el usuario los revisa y decide si los ejecuta.

Los `DROP`/`TRUNCATE` solicitan confirmación por defecto. También se avisa antes de `UPDATE` o `DELETE` sin `WHERE`. Ambos comportamientos son configurables.

## Ejecución por dialecto

El documento no se divide con un `split(';')`. El parser entiende:

- PostgreSQL: strings, comentarios y bloques dollar-quoted como `$$ ... $$`;
- MySQL: `DELIMITER`, strings, comentarios `--`, `/* ... */` y `#`;
- SQL Server: batches `GO` y `GO n`;
- Oracle: bloques `DECLARE`/`BEGIN`, procedimientos, funciones, packages, tipos, triggers, terminador `/` y literales `q'[...]'`;
- SQLite: `CREATE TRIGGER ... BEGIN ... END` con sentencias internas.

La ejecución de un documento se detiene en el primer error y selecciona el bloque que falló. La selección explícita se procesa dentro de sus límites y los separadores de cliente (`GO`, `DELIMITER`, `/`) no se envían al servidor.

## Transacciones

Cada editor SQL tiene un identificador de sesión independiente. Una transacción reserva su conexión física hasta `COMMIT` o `ROLLBACK`.

- Cerrar un editor con una transacción activa provoca `ROLLBACK` y muestra un aviso.
- Desconectar una conexión con transacciones abiertas requiere confirmación y realiza `ROLLBACK`.
- Tras un error/cancelación dentro de una transacción, la barra de estado puede exigir `ROLLBACK`.
- SQLite impide que otra pestaña utilice el mismo adaptador mientras un editor tiene una transacción abierta.

## Resultados, copia y exportación

El panel de resultados permite navegar por páginas, cambiar entre múltiples result sets, distinguir `NULL`, seleccionar una celda o un rango con `Shift` y copiar celda, fila o selección.

CSV, JSON y XLSX se generan en streaming a partir de las páginas temporales recuperadas. No se reejecuta la consulta. Los valores de celda muy grandes se acotan para la vista mediante `simpleDb.maxCellCharacters`; el texto indica explícitamente cuando una celda fue recortada.

La exportación CSV protege por defecto valores que podrían interpretarse como fórmulas al abrirlos en una hoja de cálculo. Puede desactivarse si se necesita una exportación CSV literal.

## Conexiones y seguridad

- Los perfiles no contienen contraseñas.
- Las contraseñas se guardan con la API `SecretStorage` de VS Code.
- SSL/TLS, cifrado y confianza del certificado son opciones explícitas según el motor.
- `simpleDb.confirmDestructiveQueries` está activado por defecto.
- `simpleDb.warnUnsafeDml` está activado por defecto.
- El historial puede contener literales escritos en SQL. Puede desactivarse con `simpleDb.history.enabled` o vaciarse desde la vista **Historial**.

### Nota SQLite

SQLite se ejecuta en un Worker dedicado mediante WebAssembly para que consultas largas no bloqueen la interfaz y puedan cancelarse terminando el Worker. El archivo se mantiene como una instantánea cargada durante la conexión. Antes de cada operación, Simple DB comprueba que el archivo principal/WAL/journal no haya cambiado externamente; ante un conflicto se niega a continuar y pide reconectar. Si al abrir existe un WAL activo, la conexión se rechaza hasta que el proceso propietario haga checkpoint/cierre el WAL, evitando cargar o sobrescribir una instantánea incompleta.

## Configuración

| Ajuste | Predeterminado | Función |
|---|---:|---|
| `simpleDb.maxRows` | `0` | Límite opcional por result set; `0` = ilimitado |
| `simpleDb.resultPageSize` | `500` | Filas por página temporal/visual |
| `simpleDb.maxCellCharacters` | `10000` | Máximo conservado por celda en resultados |
| `simpleDb.history.enabled` | `true` | Guardar historial local |
| `simpleDb.history.maxEntries` | `500` | Entradas máximas de historial |
| `simpleDb.confirmDestructiveQueries` | `true` | Confirmar `DROP`/`TRUNCATE` |
| `simpleDb.warnUnsafeDml` | `true` | Avisar de `UPDATE`/`DELETE` sin `WHERE` |
| `simpleDb.csvDelimiter` | `;` | Delimitador de exportación CSV |
| `simpleDb.csvProtectFormulaInjection` | `true` | Neutralizar posibles fórmulas al exportar CSV |

El timeout de conexión y el timeout máximo de consulta se configuran por perfil. `0` en el timeout de consulta significa sin timeout.

## Desarrollo

Requisitos:

- Visual Studio Code `1.95.0` o posterior.
- Node.js `20` o posterior para desarrollo.
- npm.

```bash
npm ci
npm run check
```

Después abre el repositorio en VS Code y pulsa `F5` con la configuración **Ejecutar Simple DB**. El `preLaunchTask` ejecuta ESLint y el Extension Host carga `src/extension.js` directamente.

Comandos del proyecto:

| Comando | Función |
|---|---|
| `npm run lint` | ESLint sobre JavaScript |
| `npm test` | Pruebas Vitest escritas en JavaScript |
| `npm run check` | Lint + tests |
| `npm run package` | Verificación y creación del VSIX |
| `npm run package:win32` | VSIX objetivo `win32-x64` |
| `npm run package:linux` | VSIX objetivo `linux-x64` |

Las pruebas incluyen parser/safety/DDL/almacenamiento/SecretStorage simulado y una integración SQLite real. Los servidores PostgreSQL, MySQL, SQL Server y Oracle externos requieren sus credenciales/infraestructura para pruebas de integración contra una instancia real.

## Estructura

```text
src/
  adapters/      # cinco adaptadores y Worker SQLite
  core/          # errores y normalización de valores
  managers/      # conexiones y sesiones de editor
  services/      # ejecución y exportación
  sql/           # splitter por dialecto, safety y DDL
  storage/       # perfiles, historial y resultados paginados
  test/          # tests JavaScript
  ui/            # formulario de conexión
  views/         # árboles y panel de resultados
  extension.js   # activate/deactivate
```

## Licencia

MIT. Consulta `LICENSE`.
