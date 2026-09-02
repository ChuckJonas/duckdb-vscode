/**
 * Shared column-reference helpers used by both the extension host (SQL
 * generation against the DuckDB cache) and the webview (filter clauses).
 *
 * A column reference is either a plain top-level column name or a path
 * into a STRUCT column, e.g. `["s", "x"]` for `s.x`. Both must be quoted
 * segment-by-segment — `"s.x"` would ask DuckDB for a column literally
 * named `s.x`, which is a different (and usually nonexistent) column.
 */

/** A top-level column name, or a path into a STRUCT column. */
export type ColumnRef = string | string[];

/**
 * A DuckDB cell value after JSON-safe serialization: scalars, ISO date
 * strings, BLOB placeholders, LISTs, or plain objects (STRUCT/MAP values).
 */
export type CellValue =
 | string
 | number
 | boolean
 | null
 | CellValue[]
 | { [key: string]: CellValue };

/** Normalize a ColumnRef to its path form. */
export function toColumnPath(ref: ColumnRef): string[] {
 return Array.isArray(ref) ? ref : [ref];
}

/**
 * Quote a column reference for use in SQL.
 *
 * `"a"` → `"a"`; `["s", "x"]` → `"s"."x"`. Embedded double quotes are
 * doubled, so identifiers with quotes or dots are handled correctly.
 */
export function quoteColumnRef(ref: ColumnRef): string {
 return toColumnPath(ref)
  .map((seg) => `"${seg.replace(/"/g, '""')}"`)
  .join(".");
}

/**
 * Human-readable dotted label for a column reference, used in the UI and
 * as the `column` field of stats payloads.
 */
export function columnRefLabel(ref: ColumnRef): string {
 return toColumnPath(ref).join(".");
}
