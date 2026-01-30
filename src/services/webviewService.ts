/**
 * Webview Service - Manages the results panel webview
 * Handles panel creation, caching, message passing, and export operations
 */
import * as vscode from "vscode";
import * as path from "path";
import { getDuckDBService, MultiQueryResultWithPages } from "./duckdb";

// Track result panels by source document
interface PanelState {
  panel: vscode.WebviewPanel;
  cacheIds: string[]; // Cache IDs for cleanup
  currentResult: MultiQueryResultWithPages;
  sortColumn?: string;
  sortDirection?: "asc" | "desc";
  sourceUri?: vscode.Uri; // URI of the source document for "Go to Source"
}

const resultPanels = new Map<string, PanelState>();

// Track the currently active results panel for "Go to Source" command
let activeResultsSourceUri: vscode.Uri | undefined;

// ============================================================================
// Public API
// ============================================================================

/**
 * Parse sourceId into a URI if possible
 */
function parseSourceUri(sourceId: string | undefined): vscode.Uri | undefined {
  if (!sourceId) return undefined;
  try {
    // sourceId can be a full URI string like "file:///path/to/file.sql"
    // or a prefixed string like "file:///path/to/file.sql:statement:123"
    const uriPart = sourceId.split(":statement:")[0];
    return vscode.Uri.parse(uriPart);
  } catch {
    return undefined;
  }
}

/**
 * Show query results in a webview panel
 * Reuses existing panel for same source document
 */
export function showResultsPanel(
  result: MultiQueryResultWithPages,
  context: vscode.ExtensionContext,
  sourceId: string | undefined,
  pageSize: number,
  maxCopyRows: number,
): void {
  const db = getDuckDBService();
  const title = buildPanelTitle(result);
  const cacheIds = collectCacheIds(result);
  const sourceUri = parseSourceUri(sourceId);

  // Try to reuse existing panel
  if (
    sourceId &&
    tryReuseExistingPanel(
      sourceId,
      title,
      cacheIds,
      result,
      pageSize,
      maxCopyRows,
      db,
    )
  ) {
    // Update the active source URI when reusing panel
    activeResultsSourceUri = sourceUri;
    return;
  }

  // Create new panel
  const panel = createWebviewPanel(context, title);
  const state = createPanelState(panel, cacheIds, result, sourceUri);

  // Track active source URI when panel becomes active
  panel.onDidChangeViewState((e) => {
    if (e.webviewPanel.active) {
      activeResultsSourceUri = state.sourceUri;
    }
  });

  // Set initial active source
  activeResultsSourceUri = sourceUri;

  // Track panel if we have a sourceId
  if (sourceId) {
    registerPanel(sourceId, state, db);
  }

  // Set up webview content and messaging
  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "out", "webview", "results.js"),
  );
  panel.webview.html = getWebviewHtml(scriptUri);

  setupMessageHandler(
    panel,
    sourceId,
    result,
    pageSize,
    maxCopyRows,
    db,
    context,
  );
}

/**
 * Clean up all result panels and their caches
 * Should be called during extension deactivation
 */
export function disposeAllPanels(): void {
  const db = getDuckDBService();
  for (const [, state] of resultPanels) {
    for (const cacheId of state.cacheIds) {
      db.dropCache(cacheId).catch(() => {});
    }
    state.panel.dispose();
  }
  resultPanels.clear();
}

/**
 * Get panel state for a source ID (for testing/debugging)
 */
export function getPanelState(sourceId: string): PanelState | undefined {
  return resultPanels.get(sourceId);
}

/**
 * Get the source URI of the currently active results panel
 * Used by the "Go to Source" command
 */
export function getActiveResultsSourceUri(): vscode.Uri | undefined {
  return activeResultsSourceUri;
}

// ============================================================================
// Panel Management
// ============================================================================

/**
 * Build the panel title based on result type
 */
function buildPanelTitle(result: MultiQueryResultWithPages): string {
  const statementsWithResults = result.statements.filter(
    (s) => s.meta.hasResults,
  );
  const lastStmt = result.statements[result.statements.length - 1];
  const displayRowCount = lastStmt?.meta.totalRows || 0;

  return statementsWithResults.length > 1
    ? `🦆 Results (${statementsWithResults.length} queries)`
    : `🦆 Results (${displayRowCount.toLocaleString()} rows)`;
}

/**
 * Collect all cache IDs from result statements for cleanup
 */
function collectCacheIds(result: MultiQueryResultWithPages): string[] {
  return result.statements.map((s) => s.meta.cacheId).filter((id) => id);
}

/**
 * Try to reuse an existing panel for the same source
 * Returns true if panel was reused, false if new panel needed
 */
function tryReuseExistingPanel(
  sourceId: string,
  title: string,
  cacheIds: string[],
  result: MultiQueryResultWithPages,
  pageSize: number,
  maxCopyRows: number,
  db: ReturnType<typeof getDuckDBService>,
): boolean {
  if (!resultPanels.has(sourceId)) {
    return false;
  }

  const state = resultPanels.get(sourceId)!;

  try {
    // Clean up old caches
    for (const cacheId of state.cacheIds) {
      db.dropCache(cacheId).catch(() => {});
    }

    // Update state
    state.panel.title = title;
    state.cacheIds = cacheIds;
    state.currentResult = result;
    state.sortColumn = undefined;
    state.sortDirection = undefined;

    // Reveal in current location (don't move the panel)
    state.panel.reveal();
    state.panel.webview.postMessage({
      type: "queryResult",
      data: result,
      pageSize,
      maxCopyRows,
    });

    return true;
  } catch {
    // Panel was disposed, remove from map
    resultPanels.delete(sourceId);
    return false;
  }
}

/**
 * Get the configured ViewColumn for results panels
 */
function getResultsViewColumn(): vscode.ViewColumn {
  const config = vscode.workspace.getConfiguration("duckdb");
  const location = config.get<string>("resultsLocation", "beside");
  return location === "active"
    ? vscode.ViewColumn.Active
    : vscode.ViewColumn.Beside;
}

/**
 * Create a new webview panel
 */
function createWebviewPanel(
  context: vscode.ExtensionContext,
  title: string,
): vscode.WebviewPanel {
  return vscode.window.createWebviewPanel(
    "duckdbResults",
    title,
    getResultsViewColumn(),
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, "out", "webview"),
      ],
    },
  );
}

/**
 * Create initial panel state
 */
function createPanelState(
  panel: vscode.WebviewPanel,
  cacheIds: string[],
  result: MultiQueryResultWithPages,
  sourceUri?: vscode.Uri,
): PanelState {
  return {
    panel,
    cacheIds,
    currentResult: result,
    sourceUri,
  };
}

/**
 * Register panel for tracking and cleanup
 */
function registerPanel(
  sourceId: string,
  state: PanelState,
  db: ReturnType<typeof getDuckDBService>,
): void {
  resultPanels.set(sourceId, state);

  // Remove from map and cleanup caches when disposed
  state.panel.onDidDispose(() => {
    const panelState = resultPanels.get(sourceId);
    if (panelState) {
      for (const cacheId of panelState.cacheIds) {
        db.dropCache(cacheId).catch(() => {});
      }
    }
    resultPanels.delete(sourceId);
  });
}

// ============================================================================
// Message Handling
// ============================================================================

/**
 * Set up the message handler for webview communication
 */
function setupMessageHandler(
  panel: vscode.WebviewPanel,
  sourceId: string | undefined,
  result: MultiQueryResultWithPages,
  pageSize: number,
  maxCopyRows: number,
  db: ReturnType<typeof getDuckDBService>,
  context: vscode.ExtensionContext,
): void {
  panel.webview.onDidReceiveMessage(
    async (message) => {
      const currentState = sourceId
        ? (resultPanels.get(sourceId) ?? null)
        : null;

      switch (message.type) {
        case "ready":
          handleReady(panel, result, pageSize, maxCopyRows);
          break;

        case "requestPage":
          await handleRequestPage(panel, message, currentState, pageSize, db);
          break;

        case "requestColumnStats":
          await handleRequestColumnStats(panel, message, db);
          break;

        case "export":
          await handleExportMessage(message, currentState, maxCopyRows, db);
          break;

        case "requestCopyData":
          await handleRequestCopyData(
            panel,
            message,
            currentState,
            maxCopyRows,
            db,
          );
          break;

        case "requestColumnSummaries":
          await handleRequestColumnSummaries(panel, message, db);
          break;

        case "requestDistinctValues":
          await handleRequestDistinctValues(panel, message, db);
          break;
      }
    },
    undefined,
    context.subscriptions,
  );
}

/**
 * Handle 'ready' message - send initial data
 */
function handleReady(
  panel: vscode.WebviewPanel,
  result: MultiQueryResultWithPages,
  pageSize: number,
  maxCopyRows: number,
): void {
  panel.webview.postMessage({
    type: "queryResult",
    data: result,
    pageSize,
    maxCopyRows,
  });
}

/**
 * Handle 'requestPage' message - server-side pagination, sorting, and filtering
 */
async function handleRequestPage(
  panel: vscode.WebviewPanel,
  message: {
    cacheId: string;
    offset: number;
    sortColumn?: string;
    sortDirection?: "asc" | "desc";
    whereClause?: string;
  },
  currentState: PanelState | null,
  pageSize: number,
  db: ReturnType<typeof getDuckDBService>,
): Promise<void> {
  const { cacheId, offset, sortColumn, sortDirection, whereClause } = message;

  try {
    const pageData = await db.fetchPage(
      cacheId,
      offset,
      pageSize,
      sortColumn,
      sortDirection,
      whereClause,
    );

    // Update state sort info
    if (currentState) {
      currentState.sortColumn = sortColumn;
      currentState.sortDirection = sortDirection;
    }

    panel.webview.postMessage({
      type: "pageData",
      data: pageData,
    });
  } catch (error) {
    console.error("🦆 Failed to fetch page:", error);
    // Send filter error for better UI feedback
    panel.webview.postMessage({
      type: "filterError",
      cacheId,
      error: String(error),
    });
  }
}

/**
 * Handle 'requestDistinctValues' message - get distinct values for filter dropdowns
 */
async function handleRequestDistinctValues(
  panel: vscode.WebviewPanel,
  message: { cacheId: string; column: string; searchTerm?: string },
  db: ReturnType<typeof getDuckDBService>,
): Promise<void> {
  const { cacheId, column, searchTerm } = message;

  try {
    const [distinctValues, cardinality] = await Promise.all([
      db.getColumnDistinctValues(cacheId, column, 100, searchTerm),
      db.getColumnCardinality(cacheId, column),
    ]);

    panel.webview.postMessage({
      type: "distinctValues",
      cacheId,
      column,
      data: distinctValues,
      cardinality,
    });
  } catch (error) {
    console.error("🦆 Failed to get distinct values:", error);
    panel.webview.postMessage({
      type: "distinctValues",
      cacheId,
      column,
      data: [],
      cardinality: 0,
    });
  }
}

/**
 * Handle 'requestColumnStats' message - compute and return column statistics
 */
async function handleRequestColumnStats(
  panel: vscode.WebviewPanel,
  message: { cacheId: string; column: string; whereClause?: string },
  db: ReturnType<typeof getDuckDBService>,
): Promise<void> {
  const { cacheId, column, whereClause } = message;

  try {
    const stats = await db.getCacheColumnStats(cacheId, column, whereClause);
    panel.webview.postMessage({
      type: "columnStats",
      cacheId,
      data: stats,
    });
  } catch (error) {
    console.error("🦆 Failed to compute column stats:", error);
    panel.webview.postMessage({
      type: "columnStats",
      cacheId,
      column,
      data: null,
      error: String(error),
    });
  }
}

/**
 * Handle 'export' message - delegate to export handler
 */
async function handleExportMessage(
  message: {
    cacheId: string;
    format: "csv" | "parquet" | "json" | "jsonl" | "csv-tab" | "json-tab";
  },
  currentState: PanelState | null,
  maxCopyRows: number,
  db: ReturnType<typeof getDuckDBService>,
): Promise<void> {
  const { cacheId, format } = message;
  const sortColumn = currentState?.sortColumn;
  const sortDirection = currentState?.sortDirection;

  await handleExport(
    db,
    cacheId,
    format,
    maxCopyRows,
    sortColumn,
    sortDirection,
  );
}

/**
 * Handle 'requestCopyData' message - get data for clipboard
 */
async function handleRequestCopyData(
  panel: vscode.WebviewPanel,
  message: { cacheId: string },
  currentState: PanelState | null,
  maxCopyRows: number,
  db: ReturnType<typeof getDuckDBService>,
): Promise<void> {
  const { cacheId } = message;
  const sortColumn = currentState?.sortColumn;
  const sortDirection = currentState?.sortDirection;

  try {
    const { columns, rows } = await db.getCopyData(
      cacheId,
      maxCopyRows,
      sortColumn,
      sortDirection,
    );
    panel.webview.postMessage({
      type: "copyData",
      data: { columns, rows, maxCopyRows },
    });
  } catch (error) {
    console.error("🦆 Failed to get copy data:", error);
    panel.webview.postMessage({
      type: "copyData",
      error: String(error),
    });
  }
}

/**
 * Handle 'requestColumnSummaries' message - get SUMMARIZE data
 */
async function handleRequestColumnSummaries(
  panel: vscode.WebviewPanel,
  message: { cacheId: string },
  db: ReturnType<typeof getDuckDBService>,
): Promise<void> {
  const { cacheId } = message;

  try {
    const summaries = await db.getCacheColumnSummaries(cacheId);
    panel.webview.postMessage({
      type: "columnSummaries",
      cacheId,
      data: summaries,
    });
  } catch (error) {
    console.error("🦆 Failed to get column summaries:", error);
    panel.webview.postMessage({
      type: "columnSummaries",
      cacheId,
      data: [],
      error: String(error),
    });
  }
}

// ============================================================================
// Export Operations
// ============================================================================

/**
 * Handle export request - save cached query results to file using DuckDB COPY
 */
async function handleExport(
  db: ReturnType<typeof getDuckDBService>,
  cacheId: string,
  format: "csv" | "parquet" | "json" | "jsonl" | "csv-tab" | "json-tab",
  maxRows: number,
  sortColumn?: string,
  sortDirection?: "asc" | "desc",
): Promise<void> {
  // Handle "Open in Editor" formats (has row limit since it loads into memory)
  if (format === "csv-tab" || format === "json-tab") {
    await openInEditor(db, cacheId, format, maxRows, sortColumn, sortDirection);
    return;
  }

  // Handle file export formats (no row limit - exports all data)
  await exportToFile(db, cacheId, format, sortColumn, sortDirection);
}

/**
 * Open results in a new editor tab
 */
async function openInEditor(
  db: ReturnType<typeof getDuckDBService>,
  cacheId: string,
  format: "csv-tab" | "json-tab",
  maxRows: number,
  sortColumn?: string,
  sortDirection?: "asc" | "desc",
): Promise<void> {
  try {
    const { columns, rows } = await db.getCopyData(
      cacheId,
      maxRows,
      sortColumn,
      sortDirection,
    );
    const { content, language } = formatDataForEditor(columns, rows, format);

    const doc = await vscode.workspace.openTextDocument({ content, language });
    await vscode.window.showTextDocument(doc);

    if (rows.length >= maxRows) {
      vscode.window.showInformationMessage(
        `Opened first ${maxRows.toLocaleString()} rows (limit reached)`,
      );
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Export failed: ${error}`);
  }
}

/**
 * Format data for editor display
 */
function formatDataForEditor(
  columns: string[],
  rows: Record<string, unknown>[],
  format: "csv-tab" | "json-tab",
): { content: string; language: string } {
  if (format === "csv-tab") {
    const header = columns.join(",");
    const csvRows = rows.map((row) =>
      columns.map((col) => formatCsvCell(row[col])).join(","),
    );
    return {
      content: [header, ...csvRows].join("\n"),
      language: "csv",
    };
  } else {
    return {
      content: JSON.stringify(rows, null, 2),
      language: "json",
    };
  }
}

/**
 * Format a single cell value for CSV output
 */
function formatCsvCell(val: unknown): string {
  if (val === null || val === undefined) return "";
  const str = String(val);
  // Quote if contains comma, quote, or newline
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Export results to a file via save dialog (no row limit)
 */
async function exportToFile(
  db: ReturnType<typeof getDuckDBService>,
  cacheId: string,
  format: "csv" | "parquet" | "json" | "jsonl",
  sortColumn?: string,
  sortDirection?: "asc" | "desc",
): Promise<void> {
  const extensions: Record<string, { ext: string; name: string }> = {
    csv: { ext: "csv", name: "CSV Files" },
    parquet: { ext: "parquet", name: "Parquet Files" },
    json: { ext: "json", name: "JSON Files" },
    jsonl: { ext: "jsonl", name: "JSONL Files" },
  };

  const { ext, name } = extensions[format];

  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(process.cwd(), `export.${ext}`)),
    filters: { [name]: [ext] },
    title: `Export as ${format.toUpperCase()}`,
  });

  if (!uri) {
    return; // User cancelled
  }

  try {
    // No maxRows limit - export all data
    await db.exportCache(
      cacheId,
      format,
      uri.fsPath,
      undefined,
      sortColumn,
      sortDirection,
    );
    vscode.window.showInformationMessage(
      `Exported to ${path.basename(uri.fsPath)}`,
    );
  } catch (error) {
    vscode.window.showErrorMessage(`Export failed: ${error}`);
  }
}

// ============================================================================
// HTML Generation
// ============================================================================

/**
 * Generate the HTML shell for the React webview
 */
function getWebviewHtml(scriptUri: vscode.Uri): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src ${scriptUri.scheme}:;">
  <title>DuckDB Results</title>
</head>
<body>
  <div id="root"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
