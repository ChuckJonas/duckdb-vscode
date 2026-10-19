# Catalog discovery and performance testing

Catalog discovery reads schemas, object names, column types and native row
estimates. It does not execute `COUNT(*)`, evaluate views or run `SUMMARIZE`.
Tables and Views share one discovery query per database. Columns are discovered
on expansion. The explorer, Find Table and table-name autocomplete share the
catalog service; fully qualified column autocomplete also shares discovered
columns. Unqualified names retain DuckDB's `DESCRIBE` binding so temporary objects
and custom search paths continue to work.

## Persistent cache

Local DuckDB snapshots are stored in the extension's workspace storage directory,
under `catalog/`. Nothing is written to the project or source database. Snapshots
contain only discovered metadata, with explicit page keys so an undiscovered
column list is distinct from a discovered empty list. They do not contain table
data, SQL definitions or connection settings.

- `duckdb.catalog.persist` defaults to `true`. Disabling it removes existing
  workspace snapshots and keeps discovery in memory.
- `duckdb.catalog.maxCacheSizeMB` defaults to 16 MiB for the entire workspace.
  Older snapshots are evicted first; oversized catalogs remain usable in memory.
- Files are written to unique temporary paths and renamed atomically. Invalid,
  incompatible or oversized files are ignored; storage failures do not prevent
  live discovery.
- Attachment state is always read from the running DuckDB instance. File paths
  are canonicalized for snapshot identity, while runtime aliases are rebound on
  restore. Remote and in-memory catalogs are never persisted.
- Database and WAL file identity, size and timestamps are checked before using a
  snapshot. Matching snapshots render immediately and are validated in the
  background. Access also revalidates live metadata after 30 seconds. Returning
  focus to VS Code refreshes the tree so expanded nodes can check for changes.
- These file checks are best effort, rather than a schema-version guarantee.
  **Refresh Catalog** always bypasses cached metadata. The toolbar refreshes all
  databases; the attached database's context menu refreshes that database.
- Successful schema/data mutations invalidate metadata, including successful
  statements preceding a failed statement in a batch. Metadata discovered inside
  an explicit transaction is never persisted. Commit and rollback invalidate it.
  Attachment and current-database changes preserve local snapshots, but discard
  runtime caches and verify the new attachment identity.
- Generation/revision checks prevent older requests from publishing or persisting
  results after invalidation. Failed background validation retains the previous
  metadata and backs off instead of retrying on every tree redraw.

Native row estimates are marked with `~`. Views initially have no row count.
**Calculate exact count**, **Profile table** and the existing **Summarize** action
are explicit operations and may scan data. Expanding an explorer column displays
its type without automatically profiling the table.

## Automated checks

```sh
npm ci
npm run typecheck
npm run lint
npm run test:unit
npm test
```

On Linux CI, run `xvfb-run -a npm test` when no display server is available.
Unit tests generate small local DuckDB fixtures in the OS temporary directory.
They cover query counts, lazy column discovery, persistence across service
restarts, file/WAL changes, alias changes, forced-refresh races, transaction
boundaries, cache limits, failed storage and invalid snapshots. VS Code tests
exercise explorer nodes and verify that browsing and overview metadata do not
execute views or profile data. Large downloads are not part of CI.

For manual end-to-end validation, attach a local database in an Extension
Development Host, expand Tables, Views and a table's columns, then reload the
window. Verify that expanded nodes return, snapshots are used and then validated,
and Refresh Catalog reveals externally changed objects. Disable persistence and
verify that the workspace cache directory is removed. Repeat with a read-only
attachment, an explicit transaction followed by rollback, and an unavailable
remote attachment. Run the existing cross-platform CI matrix before merging.

## Opt-in benchmark

Run against any existing local database. The benchmark attaches it read-only and
stores disposable snapshots outside the project:

```sh
npm run benchmark:catalog -- /path/to/database.duckdb
npm run benchmark:catalog -- /path/to/database.duckdb schema_name
```

The JSON output includes the database size, DuckDB/Node versions, OS, per-run
query counts and timings, and median discovery, memory-cache, snapshot-restore
and column-expansion latency. Snapshot timing includes live attachment identity
verification and starts background validation. It is not a measurement of VS
Code activation or rendering, and filesystem caches are not cleared.

Use both large data and large catalogs: a multi-GB table alone does not exercise
per-object query overhead. Useful additional cases are thousands of small tables,
wide tables, many schemas, expensive aggregate views, and views over unavailable
remote sources. Avoid timing thresholds in ordinary unit tests; assert bounded
query counts and the absence of data scans there instead.

## Reproducing the taxi fixture

The [NYC TLC trip-record page](https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page)
publishes monthly Parquet files. The optional fixture generator downloads the
2025 Yellow Taxi files, imports monthly and annual tables, creates an aggregate
view, and adds 1,000 empty tables in the `many` schema:

```sh
# Install duckdb in a Python virtual environment outside the repository.
python -m pip install duckdb==1.5.3
python scripts/create_catalog_fixture.py /path/outside/project/taxi-fixture
npm run benchmark:catalog -- /path/outside/project/taxi-fixture/taxi-2025.duckdb many
```

The default downloads approximately 830 MB and creates a multi-GB database.
`--months 1 --empty-tables 10` creates a smaller fixture for a quick manual check.
Existing monthly downloads and tables are reused when rerunning the generator.
Use a fresh output directory when changing its options.

The annual table duplicates the monthly tables intentionally. The fixture used
for initial testing contained 48,722,602 source trip records, 97,445,204
stored rows across those tables, and a 2,672,832,512-byte database. The monthly
Parquet downloads totaled 829,973,299 bytes. Allow additional disk space for
imports, snapshots and DuckDB temporary files.

Initial WSL Linux measurements used DuckDB 1.5.3, four threads and a 1.5 GB memory
limit. Medians over five runs on the 1,000-table schema were approximately 582 ms
for the previous sequential per-object counting implementation, 12 ms for fresh
catalog-service discovery, 0.3 ms from memory and 2.4 ms to restore a snapshot.
These are local observations, not portable latency guarantees. End-to-end
startup, Windows mounted-drive performance and genuinely cold disk reads should
be measured separately.
