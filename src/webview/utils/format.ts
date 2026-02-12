/**
 * Shared formatting utilities for the webview.
 * Consolidates duplicated formatCount/formatNumber across components.
 */

/**
 * Format a count for compact display (e.g., 1500 -> "1.5K", 2000000 -> "2.0M").
 * No comma separators — avoids mangling IDs, years, etc.
 */
export function formatCount(count: number): string {
  if (count >= 1000000) {
    return (count / 1000000).toFixed(1) + "M";
  }
  if (count >= 1000) {
    return (count / 1000).toFixed(1) + "K";
  }
  return String(count);
}

/**
 * Format a number for axis labels (2 decimal places, with K/M suffixes).
 * Handles negative numbers via Math.abs for suffix thresholds.
 */
export function formatAxisNumber(num: number): string {
  if (Math.abs(num) >= 1000000) {
    return (num / 1000000).toFixed(2) + "M";
  }
  if (Math.abs(num) >= 1000) {
    return (num / 1000).toFixed(2) + "K";
  }
  return num.toFixed(2);
}

/**
 * Convert any value to a string representation for clipboard/text export.
 */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Format a table (columns + rows) as tab-separated text for clipboard.
 */
export function formatTableAsText(
  columns: string[],
  rows: Record<string, unknown>[]
): string {
  const header = columns.join("\t");
  const body = rows
    .map((row) => columns.map((col) => formatValue(row[col])).join("\t"))
    .join("\n");
  return `${header}\n${body}`;
}
