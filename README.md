# Simple DB

Simple DB será una extensión de Visual Studio Code para trabajar desde una sola interfaz con PostgreSQL, MySQL, SQL Server y Oracle.

## Estado actual

La versión `0.0.1` contiene el esqueleto técnico del proyecto:

- Extensión escrita en TypeScript.
- Contenedor propio de **Simple DB** en la barra de actividad.
- Vista inicial **Conexiones** con los cuatro motores previstos.
- Compilación, análisis estático y pruebas automatizadas.
- Configuración para iniciar una ventana de desarrollo con `F5`.
- Empaquetado local en formato `.vsix`.
- Verificación automática mediante GitHub Actions.

La creación y el almacenamiento seguro de conexiones todavía no forman parte de esta versión. Se incorporarán en los pasos siguientes del plan.

## Requisitos para desarrollar

- Visual Studio Code `1.95.0` o posterior.
- Node.js `20` o posterior.
- npm.

## Puesta en marcha

1. Clona el repositorio.
2. Ejecuta `npm install`.
3. Abre la carpeta del proyecto en Visual Studio Code.
4. Pulsa `F5` y elige **Ejecutar Simple DB**.
5. En la nueva ventana de VS Code, abre el icono **Simple DB** de la barra lateral.

La vista **Conexiones** debe mostrar PostgreSQL, MySQL, SQL Server y Oracle.

## Comandos de desarrollo

| Comando | Función |
|---|---|
| `npm run compile` | Compila TypeScript en la carpeta `dist`. |
| `npm run watch` | Recompila al detectar cambios. |
| `npm run lint` | Revisa el código con ESLint. |
| `npm test` | Ejecuta las pruebas unitarias. |
| `npm run check` | Compila, revisa y prueba todo el proyecto. |
| `npm run package` | Verifica el proyecto y genera el archivo VSIX. |

## Estructura principal

- `src/extension.ts`: punto de activación de la extensión.
- `src/databaseEngines.ts`: catálogo inicial de motores.
- `src/views/`: proveedores de las vistas laterales.
- `src/test/`: pruebas unitarias.
- `resources/`: recursos visuales de la extensión.
- `.vscode/`: tareas y configuración de depuración.
- `.github/workflows/`: verificación automática.
- `plan.txt`: plan completo de desarrollo.

## Licencia

Este proyecto se distribuye bajo la licencia MIT.
