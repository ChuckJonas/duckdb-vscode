# Change Log

All notable changes to the "duckdb" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

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
