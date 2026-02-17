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
import { handleExport } from "../services/webviewService";
import type { DataOverviewMetadata } from "../webview/types";

// Re-export for convenience
export type { DataOverviewMetadata };

// ============================================================================
// DataSource interface
// ============================================================================

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
}

// ============================================================================
// Shared webview setup
// ============================================================================

/**
 * Configure a webview panel for the overview UI and wire up all message
 * handlers. Returns a Disposable that cleans up DuckDB caches.
 */
export function setupOverviewWebview(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  source: OverviewDataSource
): void {
  const config = vscode.workspace.getConfiguration("duckdb");
  const pageSize = config.get<number>("pageSize", 1000);
  const maxCopyRows = config.get<number>("maxCopyRows", 50000);
  const db = getDuckDBService();

  // Mutable state shared across message handlers
  let cacheIds: string[] = [];
  let sortColumn: string | undefined;
  let sortDirection: "asc" | "desc" | undefined;

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

  // Clean up DuckDB caches when the editor is closed
  panel.onDidDispose(() => {
    for (const id of cacheIds) {
      db.dropCache(id).catch(() => {});
    }
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
  async function sendMetadata(): Promise<void> {
    try {
      sendLoadingStatus("Fetching schema…");
      const metadata = await source.getMetadata();
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
  // Message handler
  // ------------------------------------------------------------------
  panel.webview.onDidReceiveMessage(async (message) => {
    switch (message.type) {
      // ---- Overview-specific (delegated to DataSource) ----

      case "ready":
        await sendMetadata();
        break;

      case "queryFile": {
        try {
          sendLoadingStatus("Running query…");
          resetCaches();
          const querySql = source.buildSelectSql(
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
        const sql = source.buildSelectSql(message.columns);
        const doc = await vscode.workspace.openTextDocument({
          content: sql,
          language: "sql",
        });
        await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.Beside,
        });
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
          resetCaches();
          await sendMetadata();
        } catch (error) {
          panel.webview.postMessage({
            type: "refreshError",
            error: String(error),
          });
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
          });
        } catch (error) {
          panel.webview.postMessage({
            type: "filterError",
            cacheId: message.cacheId,
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

      case "goToSource":
        // No-op in overview mode — there is no source file to navigate to.
        break;
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
