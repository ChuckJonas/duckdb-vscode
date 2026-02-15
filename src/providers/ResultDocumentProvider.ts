/**
 * Result Document Provider
 *
 * A TextDocumentContentProvider that serves a single virtual document for the
 * "duckdb-results" URI scheme, used by the Peek View widget to display inline
 * query result previews.
 *
 * The provider maintains one "active peek" slot. Every peek/live-refresh writes
 * to this same stable URI, so VS Code's onDidChange mechanism can refresh the
 * peek view in-place — even when the underlying statement moves or changes.
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

/** The single stable key used for the active peek view. */
const ACTIVE_KEY = "peek";

export class ResultDocumentProvider
  implements vscode.TextDocumentContentProvider
{
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  /** The current peek content — either a result to format or an error string. */
  private _content: CachedResult | string | undefined;

  private _uri = vscode.Uri.from({
    scheme: RESULTS_SCHEME,
    path: `/${ACTIVE_KEY}`,
  });

  // ── Public API ───────────────────────────────────────────────────────

  /**
   * Store a query result and notify the peek view to refresh.
   * Returns the stable virtual URI that the peek widget should display.
   */
  setActivePeekResult(result: CachedResult): vscode.Uri {
    this._content = result;
    this._onDidChange.fire(this._uri);
    return this._uri;
  }

  /**
   * Store an error message and notify the peek view to refresh.
   * Returns the stable virtual URI.
   */
  setActivePeekError(errorMessage: string): vscode.Uri {
    this._content = errorMessage;
    this._onDidChange.fire(this._uri);
    return this._uri;
  }

  // ── TextDocumentContentProvider ──────────────────────────────────────

  provideTextDocumentContent(_uri: vscode.Uri): string {
    if (!this._content) return "No result data available.";

    // Error string
    if (typeof this._content === "string") {
      return `  Error\n${"─".repeat(40)}\n${this._content}`;
    }

    const maxRows = getMaxPeekRows();
    return formatResultAsText(this._content, maxRows);
  }

  dispose(): void {
    this._onDidChange.dispose();
    this._content = undefined;
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
function formatResultAsText(cached: CachedResult, maxRows: number): string {
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
