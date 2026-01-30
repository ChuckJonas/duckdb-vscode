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
  sortDirection?: 'asc' | 'desc';
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
// COLUMN STATS
// ============================================================================

export interface ColumnStats {
  column: string;
  type: 'numeric' | 'string' | 'date';
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
    q50?: number;  // median
    q75?: number;
    q95?: number;
  };
  histogram?: { bucket: string; count: number }[];
  // String-specific
  topValues?: { value: string; count: number; type: 'top_n' | 'other' }[];
  // Date/Timestamp-specific
  timeseries?: {
    bins: { date: string; count: number }[];
    minDate: string;
    maxDate: string;
    granularity: 'day' | 'week' | 'month' | 'quarter' | 'year';
    totalCount: number;
  };
}

// ============================================================================
// LEGACY TYPES (For backward compatibility during transition)
// ============================================================================

export interface QueryResult {
  sql: string;
  columns: string[];
  columnTypes: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  executionTime: number;
}

export interface StatementResult {
  sql: string;
  statementIndex: number;
  columns: string[];
  columnTypes: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  executionTime: number;
  hasResults: boolean;
}

export interface MultiQueryResult {
  statements: StatementResult[];
  totalExecutionTime: number;
}
