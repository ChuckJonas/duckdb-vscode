# Change Log

All notable changes to the "duckdb" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.22] - 2026-02-17

### Added
- **Schema Overview**: data files and database tables/views now open to a landing page showing table metadata, column summaries (type, distinct count, null %), and a sample-data preview
- **Table/View Explorer**: browse database tables and views via "Open Table" in the explorer — opens a virtual file with the same overview + results experience as data files
- **Columns Panel**: fuzzy search across columns, expandable column details with type icons, copy column name, and click-to-filter
- "View SQL" modal showing the generated query for any overview
- `FileOverview` and `ColumnsPanel` components shared across data files and database tables

### Changed
- `DataFileEditorProvider` and new `TableEditorProvider` share common overview logic via `overviewHandler`

## [0.0.21] - 2026-02-17

### Added
- **Resource management settings**: `duckdb.maxMemory` and `duckdb.tempDirectory` for controlling DuckDB memory and disk usage
- **Inline loading indicator**: shows a spinner decoration on the executing statement while a query is running

## [0.0.20] - 2026-02-17

### Changed
- DuckDB in-process memory now capped to fit within VS Code extension host limits (prevents out-of-memory crashes)
- Updated marketplace keywords

## [0.0.19] - 2026-02-16

### Added
- **Data File Viewer**: open `.parquet`, `.csv`, `.tsv`, `.json`, `.jsonl`, and `.ndjson` files directly in the DuckDB results view — no more "binary file" errors for Parquet, and CSV files render as a rich data table out of the box
- Parquet and CSV/TSV auto-open with DuckDB by default; JSON/JSONL available via **Open With… → DuckDB Data Viewer**
- New settings to control auto-open behavior:
  - `duckdb.fileViewer.parquet` (default: on)
  - `duckdb.fileViewer.csv` (default: on)
  - `duckdb.fileViewer.json` (default: off — plain `.json` is never auto-opened to avoid disrupting config files)
- Full results experience for data files: pagination, sorting, filtering, column stats, export, and refresh all work the same as regular query results

## [0.0.18] - 2026-02-15

### Fixed
- Column number formatting bug in filter popovers and histograms

### Changed
- Added proper type-checking (`tsc --noEmit`) to the build process
- Updated README with new demo GIFs (live preview, Parquet querying)

## [0.0.17] - 2026-02-14

### Fixed
- Peek view edge case bugs

## [0.0.16] - 2026-02-14

### Added
- **Peek Results**: new "Peek" CodeLens action on every SQL statement — runs the query and shows results inline in a VS Code peek view as a formatted ASCII table
- **Live Preview**: while a peek view is open, editing the SQL document automatically re-executes and refreshes the preview (debounced, configurable via `duckdb.peekResults.debounceMs`)
- **Run Statement at Cursor** command (`Cmd+Shift+Enter` / `Ctrl+Shift+Enter`) — executes the single statement under the cursor without selecting it
- **Result summary in CodeLens**: after execution, each statement shows its row count and timing inline (e.g. `✓ 42 rows (12.3ms)`) — click to peek
- **Extension auto-load management**: "Add to Auto-load" and "Remove from Auto-load" context menu actions in the Extensions panel; new `duckdb.extensions.autoLoad` setting replaces the old `duckdb.extensions` array (auto-migrated)
- **Load Extension** context menu action for installed-but-not-loaded extensions
- **HTTP safety guard**: live preview detects HTTP/S3/cloud URLs and pauses execution if `cache_httpfs` is not loaded, offering a one-click install
- `cache_httpfs` added to the common extensions quick-pick list

### Changed
- **Theme-aware result panel**: all hardcoded colors replaced with VS Code CSS variables (`--vscode-*`), so the results webview adapts to any theme (light, dark, high contrast)
- Font family and size now inherit from the editor via `--vscode-editor-font-family` and `--vscode-editor-font-size`
- Extension installation now tries the core repository first, then automatically falls back to the community repository (no manual flag needed)
- "Add Extension…" renamed to "Install Extension…" in the Extensions panel
- Extensions explorer now shows auto-load status in the description and richer Markdown tooltips
- Autocomplete skips `DESCRIBE` for remote HTTP/S3 sources when `cache_httpfs` is not loaded, avoiding unwanted network requests during typing

### Internal
- New `ResultDocumentProvider` — virtual document provider for the `duckdb-results://` URI scheme used by peek views
- New `resultCacheService` — in-memory LRU cache (50 entries) storing recent query results keyed by document URI + statement offset
- `parseSqlStatements` and `getCachedResultsForDoc` exported from their respective modules for reuse
- `databaseManager` exposes `engineType` on `CombinedDatabaseInfo` for future use

## [0.0.15] - 2026-02-14

### Added
- Find Table/View search in database explorer (quick pick across all databases and schemas)
- Search History command with quick pick (Run Again, Open in Editor, Copy SQL actions)
- Expandable column stats in explorer tree (Type, Min, Max, Unique, Nulls via SUMMARIZE)
- "Copy as INSERT" and "Copy as CREATE TABLE" context menu actions on tables/views
- "Hide Schema" context menu action with `duckdb.explorer.ignoredSchemas` setting
- "Show Hidden Schemas..." command to restore hidden schemas
- Auto-refresh explorer after DDL/DML statements (CREATE, DROP, ALTER, etc.)

### Changed
- "Select Column" replaced with "Select Distinct Values" (GROUP BY + COUNT, sorted by frequency)
- "Select Top 100" renamed to "Select Top Rows" with configurable limit via `duckdb.explorer.defaultRowLimit` (default: 1000)
- Single-schema databases now skip the schema level in the explorer tree (fewer clicks)

## [0.0.14] - 2026-02-13

### Improved
- Enhanced auto-complete functionality
- CSS and component cleanup

### Fixed
- Code lens not loading in some cases

## [0.0.13] - 2026-02-12

(skipped - packaging issue)

## [0.0.12] - 2026-02-12

### Added
- Inline decorations showing success/failure status for executed statements

## [0.0.11] - 2026-02-12

### Added
- Refresh button in the query results panel
- SQL formatting support

## [0.0.10] - 2026-02-12

### Added
- Badges and performance notes in README

### Fixed
- Detach on current database now works correctly
- Debug build issues resolved

### Changed
- Code cleanup and refactors

## [0.0.9] - 2026-02-01

### Improved
- Better FROM clause autocomplete suggestions

## [0.0.8] - 2026-02-01

(skipped - version bump only)

## [0.0.7] - 2026-02-01

### Changed
- Replaced autocomplete extension with custom implementation

### Fixed
- Build platform target issue

## [0.0.6] - 2026-02-01

### Fixed
- Filters now persist correctly on refresh
- Comment parsing no longer breaks query execution

## [0.0.5] - 2026-01-30

### Added
- Published extension to Open VSX Registry

## [0.0.4] - 2026-01-30

### Added
- Demo GIFs in README showing CSV querying and database explorer

### Fixed
- Multi-statement execution now correctly reuses same results panel per file
- Column statistics display correctly when switching between statements
- Excluded large GIFs from extension bundle (reduces size from 65MB to 33MB)

## [0.0.3] - 2026-01-30

(skipped - packaging issue)

## [0.0.2] - 2026-01-29

### Added
- Custom DuckDB icon for results panel tab
- Third-party license attribution

### Changed
- Status bar moved to right side with database icon
- Removed duck emoji from panel titles
- Improved marketplace icon

### Fixed
- Results panel no longer moves when re-running queries
- Individual statements now reuse the same results panel per file
- Column stats now correctly display when switching between statements

## [0.0.1] - 2026-01-29

- Initial release
