# 🦆 DuckDB for VS Code

> An unofficial DuckDB extension for Visual Studio Code. Query CSV, Parquet and JSON files directly. Connect to `.duckdb`, S3, Postgres, Google Sheets and more.

![Query CSV files directly](https://raw.githubusercontent.com/ChuckJonas/duckdb-vscode/main/resources/query-csv.gif)

![Database Explorer](https://raw.githubusercontent.com/ChuckJonas/duckdb-vscode/main/resources/database-explorer.gif)

## Overview

This extension brings DuckDB directly into VS Code with a focus on creating a productive "DuckDB workspace". Write and execute SQL queries, view results with column statistics, explore database schemas, and manage multiple database connections.

### How It Works

All queries execute using the [DuckDB Node API](https://www.npmjs.com/package/@duckdb/node-api) embedded in VS Code. By default, queries run against an in-memory database that resets when VS Code closes. You can attach persistent `.duckdb` files or connect to remote sources like Postgres, S3, or Google Sheets.

## Features

### SQL Execution

- **Execute queries** — `Cmd+Enter` (Mac) / `Ctrl+Enter` (Windows/Linux)
- **Run individual statements** — CodeLens "Run" buttons above each SQL statement
- **SQL autocomplete** — Table names, columns, functions, and keywords (experimental, off by default)
- **Inline error diagnostics** — Syntax errors shown directly in the editor

### File Integration

- **Right-click to query** — Select files in Explorer → "DuckDB: Query File". CSV, Parquet, JSON, JSONL, TSV supported.
- **Summarize files** — Quick data profiling with SUMMARIZE

### Results Table

- **Server-side pagination** — Handle millions of rows efficiently via cached temp tables
- **Quick Column sorting** — Click headers to sort ASC/DESC
- **Quick Column filtering** — Filter by values, ranges, or patterns
- **Cell selection** — Click, Shift+click for ranges, copy to clipboard
- **Cell expansion** — Double-click to view full values (JSON syntax highlighted)
- **Export options** — CSV, Parquet, JSON, JSONL, or open in new tab

### Column Statistics

- **Top values** — Most frequent values for string columns
- **Descriptive stats** — Min, max, mean, percentiles, null counts
- **Distribution histograms** — Visual distribution for numeric columns

### Database Explorer

- **Manage databases** — Create, attach, and switch between databases
- **Status bar selector** — Quick database switching
- **Schema browser** — Databases → Schemas → Tables/Views → Columns
- **Quick actions** — SELECT TOP 100, DESCRIBE, SUMMARIZE, View Definition, Drop Table

### Extensions

- **Managed extensions** — View, add, and remove extensions
- **Auto-load on startup** — Configured extensions load automatically

### Query History

- **Automatic tracking** — All queries saved with metadata
- **Re-run queries** — Click to execute again
- **Open in editor** — Edit and modify past queries
- **Optional persistence** — Save to `.vscode/duckdb-history.db`

---

## Settings

Configure in `.vscode/settings.json` or VS Code Settings UI:

### Database Configuration

#### `duckdb.databases`

Databases to auto-attach on startup.

```json
{
  "duckdb.databases": [
    {
      "alias": "analytics",
      "type": "file",
      "path": "./data/analytics.duckdb",
      "readOnly": false,
      "attached": true
    },
    {
      "alias": "s3_data",
      "type": "file",
      "path": "s3://bucket/path/to/data.duckdb",
      "readOnly": true,
      "attached": true
    },
    {
      "alias": "postgres_mirror",
      "type": "manual",
      "sql": "ATTACH 'postgres://user:pass@host/db' AS postgres_mirror (TYPE postgres, READ_ONLY)"
    }
  ]
}
```

| Property   | Type                                 | Description                                        |
| ---------- | ------------------------------------ | -------------------------------------------------- |
| `alias`    | string                               | Database name to use in queries                    |
| `type`     | `"memory"` \| `"file"` \| `"manual"` | Database type                                      |
| `path`     | string                               | Path to .duckdb file (for `file` type)             |
| `readOnly` | boolean                              | Open in read-only mode (default: `false`)          |
| `attached` | boolean                              | Auto-attach on startup (default: `true`)           |
| `sql`      | string                               | Raw ATTACH statement (for `manual` type)           |

#### `duckdb.defaultDatabase`

Database to USE after attaching (default: `"memory"`).

#### `duckdb.extensions`

Extensions to auto-load on startup.

```json
{
  "duckdb.extensions": ["httpfs", "parquet", "json", "postgres"]
}
```

### Results Display

#### `duckdb.resultsLocation`

Where to open query results (default: `"active"`).

| Value    | Description                                      |
| -------- | ------------------------------------------------ |
| `beside` | Open in a new editor group beside the SQL file   |
| `active` | Open in the same editor group as the SQL file    |

**Tip:** To open results below your SQL file instead of beside it, set VS Code's `workbench.editor.openSideBySideDirection` to `"down"`.

#### `duckdb.pageSize`

Rows per page in results table (default: `1000`, range: 100–10,000).

#### `duckdb.maxCopyRows`

Maximum rows for copy/export operations (default: `50000`, range: 1,000–1,000,000).

### Experimental

#### `duckdb.autocomplete.enabled`

Enable SQL autocomplete suggestions (default: `false`). This feature is experimental and may have bugs.

### Query History

#### `duckdb.history.persist`

Save query history to `.vscode/duckdb-history.db` (default: `false`).

#### `duckdb.history.maxEntries`

Maximum history entries to keep (default: `1000`).

---

## Commands

| Command                    | Keybinding  | Description                     |
| -------------------------- | ----------- | ------------------------------- |
| DuckDB: Execute Query      | `Cmd+Enter` | Run SQL in active editor        |
| DuckDB: Select Database    | —           | Switch active database          |
| DuckDB: Manage Extensions  | —           | Install/remove extensions       |
| DuckDB: Query File         | —           | Query a data file (right-click) |
| DuckDB: Summarize File     | —           | Profile a data file             |
| DuckDB: Copy Query         | —           | Copy SELECT statement for file  |

---

## Requirements

- VS Code 1.74.0 or later
- macOS, Linux, or Windows

---

## License

MIT

---

_Not affiliated with DuckDB Labs. DuckDB is a trademark of DuckDB Labs._
