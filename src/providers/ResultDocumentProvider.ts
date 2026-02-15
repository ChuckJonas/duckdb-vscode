/**
 * Result Document Provider
 *
 * A TextDocumentContentProvider that serves virtual documents for the
 * "duckdb-results" URI scheme. Each document contains a formatted ASCII
 * table of query results, displayed in VS Code's Peek View widget.
 *
 * Results are stored directly in the provider (keyed by a stable ID)
 * to avoid any URI encoding/decoding issues.
 */

import * as vscode from "vscode";
import { CachedResult } from "../services/resultCacheService";

// ============================================================================
// URI scheme
// ============================================================================

export const RESULTS_SCHEME = "duckdb-results";

// ============================================================================
// Provider
// ============================================================================

export class ResultDocumentProvider
  implements vscode.TextDocumentContentProvider
{
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  /** Content stored by a simple numeric key (result or error text) */
  private _content = new Map<string, CachedResult | string>();

  /** Stable key map: "docUri::offset" → numeric key */
  private _keyMap = new Map<string, string>();
  private _nextKey = 0;

  /**
   * Get or create a stable key for a (docUri, startOffset) pair.
   */
  private _getKey(docUri: string, startOffset: number): string {
    const cacheKey = `${docUri}::${startOffset}`;
    let key = this._keyMap.get(cacheKey);
    if (!key) {
      key = String(this._nextKey++);
      this._keyMap.set(cacheKey, key);
    }
    return key;
  }

  private _buildUri(key: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: RESULTS_SCHEME,
      path: `/${key}`,
    });
  }

  /**
   * Store a result in the provider and return the URI to access it.
   * Reuses the same URI for the same (docUri, startOffset) pair.
   */
  setResult(
    docUri: string,
    startOffset: number,
    result: CachedResult
  ): vscode.Uri {
    const key = this._getKey(docUri, startOffset);
    this._content.set(key, result);
    const uri = this._buildUri(key);
    this._onDidChange.fire(uri);
    return uri;
  }

  /**
   * Store an error message for display in the peek view.
   */
  setError(docUri: string, startOffset: number, errorMessage: string): void {
    const key = this._getKey(docUri, startOffset);
    this._content.set(key, errorMessage);
    const uri = this._buildUri(key);
    this._onDidChange.fire(uri);
  }

  /**
   * Get the URI for a (docUri, startOffset) pair, if it exists.
   */
  getUri(docUri: string, startOffset: number): vscode.Uri | undefined {
    const cacheKey = `${docUri}::${startOffset}`;
    const key = this._keyMap.get(cacheKey);
    if (!key) return undefined;
    return this._buildUri(key);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const key = uri.path.replace(/^\//, "");
    const content = this._content.get(key);
    if (!content) return "No result data available.";

    // Error string
    if (typeof content === "string") {
      return `  Error\n${"─".repeat(40)}\n${content}`;
    }

    const maxRows = getMaxPeekRows();
    return formatResultAsText(content, maxRows);
  }

  dispose(): void {
    this._onDidChange.dispose();
    this._content.clear();
    this._keyMap.clear();
  }
}

// ============================================================================
// Configuration
// ============================================================================

function getMaxPeekRows(): number {
  return vscode.workspace
    .getConfiguration("duckdb")
    .get<number>("peekResults.maxRows", 50);
}

// ============================================================================
// ASCII Table Formatter
// ============================================================================

/**
 * Format a cached query result as a readable ASCII table.
 */
export function formatResultAsText(
  cached: CachedResult,
  maxRows: number
): string {
  const { meta, page } = cached;

  // Header: SQL preview + stats
  const sqlPreview = meta.sql.split("\n")[0].trim();
  const sqlLine =
    sqlPreview.length > 60 ? sqlPreview.slice(0, 57) + "..." : sqlPreview;

  const lines: string[] = [];

  // Non-result statements (DDL/DML)
  if (!meta.hasResults || meta.columns.length === 0) {
    lines.push(`  ${sqlLine}`);
    lines.push(`  executed in ${meta.executionTime.toFixed(1)}ms`);
    return lines.join("\n");
  }

  const columns = meta.columns;
  const rows = page.rows.slice(0, maxRows);
  const truncated = meta.totalRows > maxRows;

  // Calculate column widths
  const maxColWidth = 30;
  const colWidths = columns.map((col) => {
    let width = col.length;
    for (const row of rows) {
      const val = formatCellValue(row[col]);
      width = Math.max(width, val.length);
    }
    return Math.min(width, maxColWidth);
  });

  // Build header
  const headerCells = columns.map((col, i) => padOrTruncate(col, colWidths[i]));
  const headerLine = " " + headerCells.join(" │ ");

  // Build separator
  const separatorCells = colWidths.map((w) => "─".repeat(w));
  const separatorLine = "─" + separatorCells.join("─┼─") + "─";

  // Title line
  const totalWidth = headerLine.length;
  const titleSeparator = "─".repeat(Math.max(totalWidth, 40));
  lines.push(
    ` ${sqlLine}  (${meta.totalRows} rows, ${
      columns.length
    } cols, ${meta.executionTime.toFixed(1)}ms)`
  );
  lines.push(titleSeparator);

  // Header + separator
  lines.push(headerLine);
  lines.push(separatorLine);

  // Data rows
  for (const row of rows) {
    const cells = columns.map((col, i) => {
      const val = formatCellValue(row[col]);
      return padOrTruncate(val, colWidths[i]);
    });
    lines.push(" " + cells.join(" │ "));
  }

  // Footer
  lines.push(titleSeparator);
  if (truncated) {
    lines.push(
      ` Showing ${maxRows} of ${meta.totalRows} rows  ·  Open full results for pagination, sorting, and filtering`
    );
  } else {
    lines.push(` ${meta.totalRows} rows × ${columns.length} columns`);
  }

  return lines.join("\n");
}

// ============================================================================
// Helpers
// ============================================================================

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function padOrTruncate(str: string, width: number): string {
  if (str.length > width) {
    return str.slice(0, width - 1) + "…";
  }
  return str.padEnd(width);
}
