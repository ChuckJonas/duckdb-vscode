// ============================================================================
// CACHE-BASED TYPES (New Architecture)
// ============================================================================

/**
 * Metadata about a cached query result (no rows - those are fetched on demand)
 */
export interface QueryCacheMeta {
  cacheId: string;
  sql: string;
  columns: string[];
  columnTypes: string[];
  totalRows: number;
  executionTime: number;
  hasResults: boolean;
}

/**
 * A page of rows from a cached query
 */
export interface PageData {
  cacheId: string;
  rows: Record<string, unknown>[];
  offset: number;
  pageSize: number;
  totalRows: number;
  sortColumn?: string;
  sortDirection?: "asc" | "desc";
}

/**
 * Metadata for a single statement in a multi-statement query
 */
export interface StatementCacheMeta {
  cacheId: string;
  sql: string;
  statementIndex: number;
  columns: string[];
  columnTypes: string[];
  totalRows: number;
  executionTime: number;
  hasResults: boolean;
}

/**
 * Combined result sent to webview: metadata + first page
 */
export interface QueryResultWithPage {
  meta: QueryCacheMeta;
  page: PageData;
}

/**
 * Multi-statement result with metadata + first pages
 */
export interface MultiQueryResultWithPages {
  statements: Array<{
    meta: StatementCacheMeta;
    page: PageData;
  }>;
  totalExecutionTime: number;
}

// ============================================================================
// DATA OVERVIEW METADATA (for file and table overview)
// ============================================================================

/**
 * Common metadata shared by both file and table overviews
 */
interface BaseOverviewMetadata {
  displayName: string;
  rowCount: number;
  columns: { name: string; type: string }[];
}

/**
 * Metadata for a data file (parquet, CSV, JSON, etc.)
 */
export interface FileSourceMetadata extends BaseOverviewMetadata {
  sourceKind: "file";
  fileType: string; // "parquet" | "csv" | "tsv" | "json" | "jsonl" | "ndjson"
  fileSize: number; // bytes
}

/**
 * Metadata for a database table or view
 */
export interface TableSourceMetadata extends BaseOverviewMetadata {
  sourceKind: "table";
  database: string;
  schema: string;
  tableName: string;
  isView: boolean;
}

/**
 * Discriminated union for all data overview sources
 */
export type DataOverviewMetadata = FileSourceMetadata | TableSourceMetadata;

// ============================================================================
// COLUMN SUMMARIES (from SUMMARIZE)
// ============================================================================

/**
 * Per-column summary returned by DuckDB's SUMMARIZE command.
 * Used by ColumnsPanel and FileOverview.
 */
export interface ColumnSummary {
  name: string;
  distinctCount: number;
  nullPercent: number;
  inferredType: string;
}

// ============================================================================
// COLUMN STATS
// ============================================================================

export interface ColumnStats {
  column: string;
  type: "numeric" | "string" | "date";
  total: number;
  nonNull: number;
  nullCount: number;
  unique: number;
  min: string | null;
  max: string | null;
  // Numeric-specific
  mean?: number;
  stddev?: number;
  quantiles?: {
    q05?: number;
    q25?: number;
    q50?: number; // median
    q75?: number;
    q95?: number;
  };
  histogram?: { bucket: string; count: number }[];
  // String-specific
  topValues?: { value: string; count: number; type: "top_n" | "other" }[];
  // Date/Timestamp-specific
  timeseries?: {
    bins: { date: string; count: number }[];
    minDate: string;
    maxDate: string;
    granularity: "day" | "week" | "month" | "quarter" | "year";
    totalCount: number;
  };
}
