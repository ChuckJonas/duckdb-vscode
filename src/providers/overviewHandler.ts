/**
 * Shared webview handler for data overview providers.
 *
 * Both DataFileEditorProvider and TableEditorProvider display the same
 * metadata-first overview UI. This module extracts the common webview
 * setup, message routing, cache management, and HTML generation so
 * each provider only needs to supply a thin DataSource adapter.
 */
import * as vscode from "vscode";
import {
  getDuckDBService,
  collectCacheIds,
  type MultiQueryResultWithPages,
} from "../services/duckdb";
import {
  handleExport,
  linkAdHocEditor,
  unlinkAdHocEditor,
} from "../services/webviewService";
import type {
  DataOverviewMetadata,
  ContainerOverviewMetadata,
} from "../webview/types";

// Re-export for convenience
export type { DataOverviewMetadata, ContainerOverviewMetadata };

// ============================================================================
// DataSource interface
// ============================================================================

/** Persistent target for in-place edits. Returned by sources that can be
 * safely overwritten via DuckDB's COPY (parquet, csv, tsv, json, jsonl). */
export interface WriteBackTarget {
  path: string;
  format: "parquet" | "csv" | "tsv" | "json" | "jsonl" | "ndjson";
}

/**
 * Abstraction over the data source (file or table).
 * Each provider implements this to plug into the shared handler.
 */
export interface OverviewDataSource {
  /** Fetch lightweight metadata (DESCRIBE + COUNT). */
  getMetadata(): Promise<DataOverviewMetadata>;

  /** Fetch column summaries (SUMMARIZE). */
  getSummaries(): Promise<
    Array<{
      name: string;
      distinctCount: number;
      nullPercent: number;
      inferredType: string;
    }>
  >;

  /** Fetch detailed stats for a single column. */
  getColumnStats(column: string): Promise<unknown>;

  /** Build a SELECT SQL with optional column selection and limit. */
  buildSelectSql(columns?: string[], limit?: number): string;

  /**
   * Where (and in what format) cell edits get persisted. Returning null
   * disables editing for this source (e.g. xlsx, virtual tables, derived
   * results that can't be safely overwritten).
   */
  getWriteBackTarget?(): WriteBackTarget | null;
}

// ============================================================================
// Shared webview setup
// ============================================================================

/** Options that customize the initial webview behaviour. */
export interface OverviewWebviewOptions {
  /**
   * If present, the panel auto-runs `SELECT * FROM <source>` after sending
   * metadata, landing the user directly on the results view instead of the
   * schema overview.
   *
   * - `limit` undefined or `0` → no LIMIT; the full result set is materialized
   *   into the temp cache and rows stream into the table via infinite scroll.
   * - `limit` > 0 → applies `LIMIT N`, useful for sampling huge files.
   */
  autoLoad?: { limit?: number };
}

/**
 * Configure a webview panel for the overview UI and wire up all message
 * handlers. Returns a Disposable that cleans up DuckDB caches.
 */
export function setupOverviewWebview(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  source: OverviewDataSource,
  options: OverviewWebviewOptions = {}
): void {
  const config = vscode.workspace.getConfiguration("duckdb");
  const pageSize = config.get<number>("pageSize", 100);
  const maxCopyRows = config.get<number>("maxCopyRows", 50000);
  const db = getDuckDBService();
  const autoLoad = options.autoLoad;

  // Mutable state shared across message handlers
  let cacheIds: string[] = [];
  let sortColumn: string | undefined;
  let sortDirection: "asc" | "desc" | undefined;
  // The most recently executed query (default top-N or queryFile).
  // Used so "refresh" re-runs the last query rather than dropping back to
  // the schema overview.
  let lastQuerySql: string | undefined;
  /**
   * Whether the current cache reflects the *full, unmodified* source — only
   * then is it safe to write cell edits back to the source file. Set true
   * when the auto-load runs `SELECT *` with no LIMIT; false for column
   * projections, LIMITed samples, and ad-hoc SQL.
   */
  let cacheIsFullSource = false;
  // Docs spawned via "Open in Editor"; running them routes results here.
  const linkedDocs = new Set<string>();
  let closeListener: vscode.Disposable | undefined;

  // Set up webview options and content
  panel.webview.options = {
    enableScripts: true,
    localResourceRoots: [
      vscode.Uri.joinPath(context.extensionUri, "out", "webview"),
    ],
  };

  panel.iconPath = vscode.Uri.joinPath(
    context.extensionUri,
    "resources",
    "duckdb-icon.svg"
  );

  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "out", "webview", "results.js")
  );
  panel.webview.html = getWebviewHtml(scriptUri);

  // Clean up DuckDB caches and any ad-hoc editor links when the editor closes
  panel.onDidDispose(() => {
    for (const id of cacheIds) {
      db.dropCache(id).catch(() => {});
    }
    for (const docUri of linkedDocs) {
      unlinkAdHocEditor(docUri);
    }
    linkedDocs.clear();
    closeListener?.dispose();
  });

  // ------------------------------------------------------------------
  // Helper to send a loading status to the webview
  // ------------------------------------------------------------------
  function sendLoadingStatus(message: string): void {
    panel.webview.postMessage({ type: "loadingStatus", message });
  }

  // ------------------------------------------------------------------
  // Helper to send metadata to the webview
  // ------------------------------------------------------------------
  async function sendMetadata(opts: { silent?: boolean } = {}): Promise<void> {
    try {
      if (!opts.silent) sendLoadingStatus("Fetching schema…");
      const metadata = await source.getMetadata();
      panel.webview.postMessage({
        type: "fileMetadata",
        data: metadata,
        pageSize,
        maxCopyRows,
        // When silent, the webview stores metadata in state but does not
        // switch the visible view — used so the "Back to Overview" button
        // works while the user lands directly on the data results.
        silent: opts.silent ?? false,
      });
    } catch (error) {
      panel.webview.postMessage({
        type: "queryError",
        error: String(error),
      });
    }
  }

  // ------------------------------------------------------------------
  // Run an arbitrary SQL, post results, and remember it for refresh.
  // `editable` controls whether cell edits get persisted back to the
  // source — only true for unbounded SELECT * loads where the cache
  // is a faithful copy of the source.
  // ------------------------------------------------------------------
  async function runQuery(
    querySql: string,
    status: string,
    opts: { editable?: boolean } = {}
  ): Promise<void> {
    try {
      sendLoadingStatus(status);
      resetCaches();
      lastQuerySql = querySql;
      cacheIsFullSource = !!opts.editable;
      const result = await db.executeQuery(querySql, pageSize);
      cacheIds = collectCacheIds(result);
      const writeTarget = source.getWriteBackTarget?.() ?? null;
      panel.webview.postMessage({
        type: "queryResult",
        data: result,
        pageSize,
        maxCopyRows,
        editable: cacheIsFullSource && writeTarget !== null,
      });
    } catch (error) {
      panel.webview.postMessage({
        type: "queryError",
        error: String(error),
      });
    }
  }

  // ------------------------------------------------------------------
  // Helper to drop current caches and reset sort state
  // ------------------------------------------------------------------
  function resetCaches(): void {
    for (const id of cacheIds) {
      db.dropCache(id).catch(() => {});
    }
    cacheIds = [];
    sortColumn = undefined;
    sortDirection = undefined;
  }

  // ------------------------------------------------------------------
  // Display a pre-computed result (run from a linked "Open in Editor"
  // doc) inside this panel, adopting its caches rather than re-running.
  // ------------------------------------------------------------------
  function displayExternalResult(
    result: MultiQueryResultWithPages,
    resultPageSize: number,
    resultMaxCopyRows: number
  ): void {
    resetCaches();
    cacheIds = collectCacheIds(result);
    // So the panel's "Refresh" re-runs the edited query, not the source view.
    lastQuerySql = result.statements.map((s) => s.meta.sql).join(";\n");
    // Ad-hoc / derived results are never safe to write back to the source.
    cacheIsFullSource = false;
    // Surface the panel but keep focus on the editor the user ran from.
    panel.reveal(undefined, true);
    panel.webview.postMessage({
      type: "queryResult",
      data: result,
      pageSize: resultPageSize,
      maxCopyRows: resultMaxCopyRows,
      editable: false,
    });
  }

  function linkEditorDoc(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    linkedDocs.add(key);
    linkAdHocEditor(key, { panel, display: displayExternalResult });
    // Lazily wire a close listener so reused untitled URIs don't leak links.
    if (!closeListener) {
      closeListener = vscode.workspace.onDidCloseTextDocument((closed) => {
        const closedKey = closed.uri.toString();
        if (linkedDocs.delete(closedKey)) {
          unlinkAdHocEditor(closedKey);
        }
      });
    }
  }

  // ------------------------------------------------------------------
  // Message handler
  // ------------------------------------------------------------------
  panel.webview.onDidReceiveMessage(async (message) => {
    switch (message.type) {
      // ---- Overview-specific (delegated to DataSource) ----

      case "ready":
        if (autoLoad) {
          // Pre-fetch metadata silently so the Back-to-Overview button works,
          // then jump straight into the data view.
          await sendMetadata({ silent: true });
          const limit =
            autoLoad.limit && autoLoad.limit > 0 ? autoLoad.limit : undefined;
          const status = limit
            ? `Loading first ${limit.toLocaleString()} rows…`
            : "Materializing results…";
          // Editable only when the cache is the full unbounded source.
          await runQuery(source.buildSelectSql(undefined, limit), status, {
            editable: !limit,
          });
        } else {
          await sendMetadata();
        }
        break;

      case "queryFile": {
        const querySql = source.buildSelectSql(message.columns, message.limit);
        // Editable only when the user picks "All rows" with no projection.
        const editable =
          (!message.columns || message.columns.length === 0) && !message.limit;
        await runQuery(querySql, "Running query…", { editable });
        break;
      }

      case "openAsSql": {
        const sql =
          typeof message.sql === "string" && message.sql.trim().length > 0
            ? message.sql
            : source.buildSelectSql(message.columns);
        const doc = await vscode.workspace.openTextDocument({
          content: sql,
          language: "sql",
        });
        await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.Beside,
        });
        linkEditorDoc(doc);
        break;
      }

      case "updateCell": {
        const { rowId, column, columnType, newValue } = message;
        const target = source.getWriteBackTarget?.() ?? null;
        try {
          if (!cacheIsFullSource) {
            throw new Error(
              "Editing is disabled for derived or limited results. Reload the file with the default view to edit."
            );
          }
          if (!target) {
            throw new Error("This file format does not support write-back.");
          }
          if (cacheIds.length === 0) throw new Error("No cache to edit");
          const cacheId = cacheIds[0];
          const stored = await db.updateCacheCell(
            cacheId,
            Number(rowId),
            column,
            columnType,
            newValue ?? null
          );
          await db.writeCacheToFile(cacheId, target.path, target.format);
          panel.webview.postMessage({
            type: "cellUpdated",
            cacheId,
            rowId,
            column,
            newValue: stored,
          });
        } catch (error) {
          panel.webview.postMessage({
            type: "cellUpdated",
            rowId,
            column,
            error: String(error instanceof Error ? error.message : error),
          });
        }
        break;
      }

      case "requestFileSummaries":
        try {
          const summaries = await source.getSummaries();
          panel.webview.postMessage({
            type: "fileSummaries",
            data: summaries,
          });
        } catch (error) {
          panel.webview.postMessage({
            type: "fileSummaries",
            data: [],
            error: String(error),
          });
        }
        break;

      case "requestFileColumnStats":
        try {
          const stats = await source.getColumnStats(message.column);
          panel.webview.postMessage({
            type: "fileColumnStats",
            column: message.column,
            data: stats,
          });
        } catch (error) {
          panel.webview.postMessage({
            type: "fileColumnStats",
            column: message.column,
            data: null,
            error: String(error),
          });
        }
        break;

      case "refreshQuery":
        try {
          if (lastQuerySql) {
            await runQuery(lastQuerySql, "Refreshing…");
          } else {
            resetCaches();
            await sendMetadata();
          }
        } catch (error) {
          panel.webview.postMessage({
            type: "refreshError",
            error: String(error),
          });
        }
        break;

      // ---- Navigate to schema overview from results view ----

      case "showOverview":
        await sendMetadata();
        break;

      // ---- Cache-based handlers (identical for all sources) ----

      case "requestPage":
        try {
          const pageData = await db.fetchPage(
            message.cacheId,
            message.offset,
            pageSize,
            message.sortColumn,
            message.sortDirection,
            message.whereClause
          );
          sortColumn = message.sortColumn;
          sortDirection = message.sortDirection;
          panel.webview.postMessage({
            type: "pageData",
            data: pageData,
            requestVersion: message.requestVersion,
          });
        } catch (error) {
          panel.webview.postMessage({
            type: "filterError",
            cacheId: message.cacheId,
            requestVersion: message.requestVersion,
            error: String(error),
          });
        }
        break;

      case "requestColumnStats":
        try {
          const cacheStats = await db.getCacheColumnStats(
            message.cacheId,
            message.column,
            message.whereClause
          );
          panel.webview.postMessage({
            type: "columnStats",
            cacheId: message.cacheId,
            data: cacheStats,
          });
        } catch (error) {
          panel.webview.postMessage({
            type: "columnStats",
            cacheId: message.cacheId,
            column: message.column,
            data: null,
            error: String(error),
          });
        }
        break;

      case "requestColumnSummaries":
        try {
          const cacheSummaries = await db.getCacheColumnSummaries(
            message.cacheId
          );
          panel.webview.postMessage({
            type: "columnSummaries",
            cacheId: message.cacheId,
            data: cacheSummaries,
          });
        } catch (error) {
          panel.webview.postMessage({
            type: "columnSummaries",
            cacheId: message.cacheId,
            data: [],
            error: String(error),
          });
        }
        break;

      case "requestDistinctValues":
        try {
          const [distinctValues, cardinality] = await Promise.all([
            db.getColumnDistinctValues(
              message.cacheId,
              message.column,
              100,
              message.searchTerm
            ),
            db.getColumnCardinality(message.cacheId, message.column),
          ]);
          panel.webview.postMessage({
            type: "distinctValues",
            cacheId: message.cacheId,
            column: message.column,
            data: distinctValues,
            cardinality,
          });
        } catch (error) {
          panel.webview.postMessage({
            type: "distinctValues",
            cacheId: message.cacheId,
            column: message.column,
            data: [],
            cardinality: 0,
          });
        }
        break;

      case "export":
        await handleExport(
          db,
          message.cacheId,
          message.format,
          maxCopyRows,
          sortColumn,
          sortDirection
        );
        break;

      case "requestCopyData":
        try {
          const { columns, rows } = await db.getCopyData(
            message.cacheId,
            maxCopyRows,
            sortColumn,
            sortDirection
          );
          panel.webview.postMessage({
            type: "copyData",
            data: { columns, rows, maxCopyRows },
          });
        } catch (error) {
          panel.webview.postMessage({
            type: "copyData",
            error: String(error),
          });
        }
        break;

      case "goToSource": {
        // File-overview panels have no source .sql file. The webview's
        // "Open in Editor" affordance still hands the user off here for
        // the source-query view of the modal; treat that as "open the
        // current query as an untitled .sql doc."
        const sql = lastQuerySql ?? source.buildSelectSql();
        const doc = await vscode.workspace.openTextDocument({
          content: sql,
          language: "sql",
        });
        await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.Beside,
        });
        linkEditorDoc(doc);
        break;
      }
    }
  });
}

// ============================================================================
// Multi-table data source (for xlsx, .db files with multiple sheets/tables)
// ============================================================================

/**
 * Abstraction over a file that contains multiple tables/sheets.
 * The provider implements this to supply container-level metadata
 * and per-table OverviewDataSource instances.
 */
export interface MultiTableDataSource {
  /** Fetch container-level metadata (sheet list with columns/row counts). */
  getContainerMetadata(): Promise<ContainerOverviewMetadata>;

  /** Get an OverviewDataSource for a specific table/sheet by ID. */
  getTableSource(tableId: string): OverviewDataSource;
}

/**
 * Configure a webview panel for a multi-table container (e.g. xlsx workbook).
 * Shows the container overview first; when the user opens a specific table,
 * switches to the standard single-table overview flow.
 */
export function setupMultiTableOverviewWebview(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  multiSource: MultiTableDataSource
): void {
  const config = vscode.workspace.getConfiguration("duckdb");
  const pageSize = config.get<number>("pageSize", 1000);
  const maxCopyRows = config.get<number>("maxCopyRows", 50000);
  const db = getDuckDBService();

  let cacheIds: string[] = [];
  let sortColumn: string | undefined;
  let sortDirection: "asc" | "desc" | undefined;
  let activeSource: OverviewDataSource | null = null;
  let containerMeta: ContainerOverviewMetadata | null = null;
  // Docs spawned via "Open in Editor"; running them routes results here.
  const linkedDocs = new Set<string>();
  let closeListener: vscode.Disposable | undefined;

  panel.webview.options = {
    enableScripts: true,
    localResourceRoots: [
      vscode.Uri.joinPath(context.extensionUri, "out", "webview"),
    ],
  };

  panel.iconPath = vscode.Uri.joinPath(
    context.extensionUri,
    "resources",
    "duckdb-icon.svg"
  );

  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "out", "webview", "results.js")
  );
  panel.webview.html = getWebviewHtml(scriptUri);

  panel.onDidDispose(() => {
    for (const id of cacheIds) {
      db.dropCache(id).catch(() => {});
    }
    for (const docUri of linkedDocs) {
      unlinkAdHocEditor(docUri);
    }
    linkedDocs.clear();
    closeListener?.dispose();
  });

  function sendLoadingStatus(message: string): void {
    panel.webview.postMessage({ type: "loadingStatus", message });
  }

  // Display a pre-computed result (run from a linked "Open in Editor" doc)
  // inside this panel. Multi-table sources (xlsx) are never write-back.
  function displayExternalResult(
    result: MultiQueryResultWithPages,
    resultPageSize: number,
    resultMaxCopyRows: number
  ): void {
    resetCaches();
    cacheIds = collectCacheIds(result);
    panel.reveal(undefined, true);
    panel.webview.postMessage({
      type: "queryResult",
      data: result,
      pageSize: resultPageSize,
      maxCopyRows: resultMaxCopyRows,
      editable: false,
    });
  }

  function linkEditorDoc(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    linkedDocs.add(key);
    linkAdHocEditor(key, { panel, display: displayExternalResult });
    if (!closeListener) {
      closeListener = vscode.workspace.onDidCloseTextDocument((closed) => {
        const closedKey = closed.uri.toString();
        if (linkedDocs.delete(closedKey)) {
          unlinkAdHocEditor(closedKey);
        }
      });
    }
  }

  async function sendContainerMetadata(): Promise<void> {
    try {
      sendLoadingStatus("Discovering sheets…");
      containerMeta = await multiSource.getContainerMetadata();
      panel.webview.postMessage({
        type: "containerMetadata",
        data: containerMeta,
      });
    } catch (error) {
      panel.webview.postMessage({
        type: "queryError",
        error: String(error),
      });
    }
  }

  async function sendTableMetadata(): Promise<void> {
    if (!activeSource) return;
    try {
      sendLoadingStatus("Fetching schema…");
      const metadata = await activeSource.getMetadata();
      panel.webview.postMessage({
        type: "fileMetadata",
        data: metadata,
        pageSize,
        maxCopyRows,
      });
    } catch (error) {
      panel.webview.postMessage({
        type: "queryError",
        error: String(error),
      });
    }
  }

  function resetCaches(): void {
    for (const id of cacheIds) {
      db.dropCache(id).catch(() => {});
    }
    cacheIds = [];
    sortColumn = undefined;
    sortDirection = undefined;
  }

  panel.webview.onDidReceiveMessage(async (message) => {
    switch (message.type) {
      case "ready":
        await sendContainerMetadata();
        break;

      case "openTable": {
        resetCaches();
        activeSource = multiSource.getTableSource(message.tableId);
        await sendTableMetadata();
        break;
      }

      case "backToContainer":
        resetCaches();
        activeSource = null;
        if (containerMeta) {
          panel.webview.postMessage({
            type: "containerMetadata",
            data: containerMeta,
          });
        } else {
          await sendContainerMetadata();
        }
        break;

      // ---- Single-table handlers (only active when a table is selected) ----

      case "queryFile": {
        if (!activeSource) break;
        try {
          sendLoadingStatus("Running query…");
          resetCaches();
          const querySql = activeSource.buildSelectSql(
            message.columns,
            message.limit
          );
          const result = await db.executeQuery(querySql, pageSize);
          cacheIds = collectCacheIds(result);
          panel.webview.postMessage({
            type: "queryResult",
            data: result,
            pageSize,
            maxCopyRows,
            // Multi-table sources (xlsx) never support write-back.
            editable: false,
          });
        } catch (error) {
          panel.webview.postMessage({
            type: "queryError",
            error: String(error),
          });
        }
        break;
      }

      case "openAsSql": {
        const sql =
          typeof message.sql === "string" && message.sql.trim().length > 0
            ? message.sql
            : activeSource?.buildSelectSql(message.columns);
        if (!sql) break;
        const doc = await vscode.workspace.openTextDocument({
          content: sql,
          language: "sql",
        });
        await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.Beside,
        });
        linkEditorDoc(doc);
        break;
      }

      case "requestFileSummaries":
        if (!activeSource) break;
        try {
          const summaries = await activeSource.getSummaries();
          panel.webview.postMessage({
            type: "fileSummaries",
            data: summaries,
          });
        } catch (error) {
          panel.webview.postMessage({
            type: "fileSummaries",
            data: [],
            error: String(error),
          });
        }
        break;

      case "requestFileColumnStats":
        if (!activeSource) break;
        try {
          const stats = await activeSource.getColumnStats(message.column);
          panel.webview.postMessage({
            type: "fileColumnStats",
            column: message.column,
            data: stats,
          });
        } catch (error) {
          panel.webview.postMessage({
            type: "fileColumnStats",
            column: message.column,
            data: null,
            error: String(error),
          });
        }
        break;

      case "refreshQuery":
        if (activeSource) {
          try {
            resetCaches();
            await sendTableMetadata();
          } catch (error) {
            panel.webview.postMessage({
              type: "refreshError",
              error: String(error),
            });
          }
        } else {
          await sendContainerMetadata();
        }
        break;

      // ---- Cache-based handlers (identical for all sources) ----

      case "requestPage":
        try {
          const pageData = await db.fetchPage(
            message.cacheId,
            message.offset,
            pageSize,
            message.sortColumn,
            message.sortDirection,
            message.whereClause
          );
          sortColumn = message.sortColumn;
          sortDirection = message.sortDirection;
          panel.webview.postMessage({
            type: "pageData",
            data: pageData,
            requestVersion: message.requestVersion,
          });
        } catch (error) {
          panel.webview.postMessage({
            type: "filterError",
            cacheId: message.cacheId,
            requestVersion: message.requestVersion,
            error: String(error),
          });
        }
        break;

      case "requestColumnStats":
        try {
          const cacheStats = await db.getCacheColumnStats(
            message.cacheId,
            message.column,
            message.whereClause
          );
          panel.webview.postMessage({
            type: "columnStats",
            cacheId: message.cacheId,
            data: cacheStats,
          });
        } catch (error) {
          panel.webview.postMessage({
            type: "columnStats",
            cacheId: message.cacheId,
            column: message.column,
            data: null,
            error: String(error),
          });
        }
        break;

      case "requestColumnSummaries":
        try {
          const cacheSummaries = await db.getCacheColumnSummaries(
            message.cacheId
          );
          panel.webview.postMessage({
            type: "columnSummaries",
            cacheId: message.cacheId,
            data: cacheSummaries,
          });
        } catch (error) {
          panel.webview.postMessage({
            type: "columnSummaries",
            cacheId: message.cacheId,
            data: [],
            error: String(error),
          });
        }
        break;

      case "requestDistinctValues":
        try {
          const [distinctValues, cardinality] = await Promise.all([
            db.getColumnDistinctValues(
              message.cacheId,
              message.column,
              100,
              message.searchTerm
            ),
            db.getColumnCardinality(message.cacheId, message.column),
          ]);
          panel.webview.postMessage({
            type: "distinctValues",
            cacheId: message.cacheId,
            column: message.column,
            data: distinctValues,
            cardinality,
          });
        } catch (error) {
          panel.webview.postMessage({
            type: "distinctValues",
            cacheId: message.cacheId,
            column: message.column,
            data: [],
            cardinality: 0,
          });
        }
        break;

      case "export":
        await handleExport(
          db,
          message.cacheId,
          message.format,
          maxCopyRows,
          sortColumn,
          sortDirection
        );
        break;

      case "requestCopyData":
        try {
          const { columns, rows } = await db.getCopyData(
            message.cacheId,
            maxCopyRows,
            sortColumn,
            sortDirection
          );
          panel.webview.postMessage({
            type: "copyData",
            data: { columns, rows, maxCopyRows },
          });
        } catch (error) {
          panel.webview.postMessage({
            type: "copyData",
            error: String(error),
          });
        }
        break;

      case "goToSource": {
        // Multi-table panels (xlsx etc.) have no source .sql file.
        // Treat the webview's "Open in Editor" hand-off as "open the
        // current sheet's default SELECT as an untitled .sql doc."
        if (!activeSource) {
          break;
        }
        const sql = activeSource.buildSelectSql();
        const doc = await vscode.workspace.openTextDocument({
          content: sql,
          language: "sql",
        });
        await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.Beside,
        });
        linkEditorDoc(doc);
        break;
      }
    }
  });
}

// ============================================================================
// Shared helpers
// ============================================================================

export function getWebviewHtml(scriptUri: vscode.Uri): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src ${scriptUri.scheme}:;">
  <title>DuckDB Data Viewer</title>
</head>
<body>
  <div id="root"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
