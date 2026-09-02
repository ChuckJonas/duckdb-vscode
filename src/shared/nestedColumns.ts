/**
 * Nested-column support: expand DuckDB STRUCT columns into grouped
 * sub-columns in the results table, up to a configurable depth.
 *
 * Pure functions (no React / no VS Code imports) so they can be unit
 * tested with `npx tsx --test`.
 */

/** A single field parsed out of a DuckDB STRUCT(...) type string. */
export interface StructField {
  name: string;
  type: string;
}

/**
 * Parse a DuckDB STRUCT type string (as returned by DESCRIBE, e.g.
 * `STRUCT(a INTEGER, "b c" STRUCT(d VARCHAR))`) into its fields.
 *
 * Returns null when the type is not a plain STRUCT — including
 * `STRUCT(...)[]` (a LIST of structs), MAP, UNION, and empty structs —
 * so callers fall back to rendering the value as-is.
 */
export function parseStructFields(type: string): StructField[] | null {
  const t = type.trim();
  if (!/^STRUCT\s*\(/i.test(t) || !t.endsWith(")")) {
    return null;
  }

  const open = t.indexOf("(");
  const fields: StructField[] = [];
  let depth = 0;
  let inQuote = false;
  let segStart = open + 1;

  for (let i = open; i < t.length; i++) {
    const ch = t[i];
    if (inQuote) {
      if (ch === '"') {
        if (t[i + 1] === '"') {
          i++;
        } // escaped quote inside identifier
        else {
          inQuote = false;
        }
      }
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth--;
      if (depth === 0) {
        // Closing paren must be the last character; otherwise this is
        // something like STRUCT(...)[] which we do not expand.
        if (i !== t.length - 1) {
          return null;
        }
        const seg = t.slice(segStart, i).trim();
        if (seg) {
          const f = parseStructField(seg);
          if (!f) {
            return null;
          }
          fields.push(f);
        }
      }
      continue;
    }
    if (ch === "," && depth === 1) {
      const seg = t.slice(segStart, i).trim();
      const f = parseStructField(seg);
      if (!f) {
        return null;
      }
      fields.push(f);
      segStart = i + 1;
    }
  }

  if (inQuote || depth !== 0) {
    return null;
  }
  return fields.length > 0 ? fields : null;
}

/** Parse one `name TYPE` segment; the name may be a quoted identifier. */
function parseStructField(seg: string): StructField | null {
  if (seg.startsWith('"')) {
    let i = 1;
    let name = "";
    while (i < seg.length) {
      if (seg[i] === '"') {
        if (seg[i + 1] === '"') {
          name += '"';
          i += 2;
          continue;
        }
        break;
      }
      name += seg[i];
      i++;
    }
    if (i >= seg.length) {
      return null;
    } // unterminated quote
    const type = seg.slice(i + 1).trim();
    if (!type) {
      return null;
    }
    return { name, type };
  }
  const sp = seg.search(/\s/);
  if (sp <= 0) {
    return null;
  }
  return { name: seg.slice(0, sp), type: seg.slice(sp + 1).trim() };
}

/**
 * A renderable leaf column. For a non-struct column this is the column
 * itself (path.length === 1); for expanded structs the path walks from
 * the top-level column down to the struct field.
 */
export interface LeafColumn {
  /** Stable key for width maps / React keys. Equals the column name for top-level leaves. */
  key: string;
  /** Display label (the last path segment). */
  label: string;
  /** [topLevelColumn, field, subField, ...] */
  path: string[];
  /** DuckDB type of this leaf. */
  type: string;
  /** Index of the owning top-level column in the original columns array. */
  topIndex: number;
  /** True when this leaf lives inside a struct (path.length > 1). */
  isNested: boolean;
}

/** A cell in the (possibly multi-row) table header. */
export interface HeaderCell {
  key: string;
  label: string;
  colSpan: number;
  rowSpan: number;
  /** True when this cell groups sub-columns (a struct with children). */
  isGroup: boolean;
  /** For leaves: index into leaves. For groups: index of the first spanned leaf. */
  leafIndex: number;
  /** Number of leaves spanned (1 for leaf cells). */
  leafCount: number;
  topIndex: number;
  type: string;
  path: string[];
}

export interface NestedColumnModel {
  leaves: LeafColumn[];
  /** headerRows[r] = ordered cells of header row r. */
  headerRows: HeaderCell[][];
  /** Number of header rows (1 when nothing is expanded). */
  headerDepth: number;
  /** True when at least one struct column was expanded. */
  hasNesting: boolean;
}

/** Separator for leaf keys; unlikely to appear in identifiers. */
const KEY_SEP = "\u001f";

interface Node {
  name: string;
  type: string;
  path: string[];
  topIndex: number;
  level: number;
  children: Node[] | null;
}

/**
 * Build the leaf columns and grouped header rows for a result set.
 *
 * @param maxDepth Maximum number of struct levels to expand into
 *   sub-columns. 0 disables expansion entirely (flat table).
 */
export function buildNestedColumns(
  columns: string[],
  columnTypes: string[],
  maxDepth: number,
): NestedColumnModel {
  const buildNode = (
    name: string,
    type: string,
    path: string[],
    topIndex: number,
    level: number,
  ): Node => {
    let children: Node[] | null = null;
    if (level < maxDepth) {
      const fields = parseStructFields(type);
      if (fields) {
        children = fields.map((f) =>
          buildNode(f.name, f.type, [...path, f.name], topIndex, level + 1),
        );
      }
    }
    return { name, type, path, topIndex, level, children };
  };

  const roots = columns.map((c, i) =>
    buildNode(c, columnTypes[i] || "VARCHAR", [c], i, 0),
  );

  // Header depth = deepest leaf level + 1.
  let headerDepth = 1;
  const measure = (n: Node): void => {
    if (!n.children) {
      headerDepth = Math.max(headerDepth, n.level + 1);
      return;
    }
    n.children.forEach(measure);
  };
  roots.forEach(measure);

  const leaves: LeafColumn[] = [];
  const headerRows: HeaderCell[][] = Array.from(
    { length: headerDepth },
    () => [],
  );

  const walk = (n: Node): { first: number; count: number } => {
    const key = n.path.length === 1 ? n.path[0] : n.path.join(KEY_SEP);
    if (!n.children) {
      const leafIndex = leaves.length;
      leaves.push({
        key,
        label: n.name,
        path: n.path,
        type: n.type,
        topIndex: n.topIndex,
        isNested: n.path.length > 1,
      });
      headerRows[n.level].push({
        key,
        label: n.name,
        colSpan: 1,
        rowSpan: headerDepth - n.level,
        isGroup: false,
        leafIndex,
        leafCount: 1,
        topIndex: n.topIndex,
        type: n.type,
        path: n.path,
      });
      return { first: leafIndex, count: 1 };
    }
    let first = -1;
    let count = 0;
    for (const child of n.children) {
      const r = walk(child);
      if (first < 0) {
        first = r.first;
      }
      count += r.count;
    }
    headerRows[n.level].push({
      key,
      label: n.name,
      colSpan: count,
      rowSpan: 1,
      isGroup: true,
      leafIndex: first,
      leafCount: count,
      topIndex: n.topIndex,
      type: n.type,
      path: n.path,
    });
    return { first, count };
  };
  roots.forEach(walk);

  return {
    leaves,
    headerRows,
    headerDepth,
    hasNesting: headerDepth > 1,
  };
}

/**
 * A serialized DuckDB cell value as it arrives in the webview: scalars,
 * ISO strings, arrays, or plain objects (serialized STRUCT/MAP values).
 */
export type CellValue =
  | string
  | number
  | boolean
  | null
  | CellValue[]
  | { [key: string]: CellValue };

/**
 * Extract a leaf value from a row by walking the path. Missing keys and
 * non-object intermediates yield null (rendered as NULL).
 */
export function getValueAtPath(
  row: Record<string, unknown>,
  path: string[],
): CellValue {
  let v = row[path[0]] as CellValue | undefined;
  for (let i = 1; i < path.length; i++) {
    if (v === null || v === undefined) {
      return null;
    }
    if (typeof v !== "object" || Array.isArray(v)) {
      return null;
    }
    v = v[path[i]];
  }
  return v === undefined ? null : v;
}
