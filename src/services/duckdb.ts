import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

// ============================================================================
// TYPES
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
 * Result from a single statement (now with cache)
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
 * Result from executing multiple statements (metadata only)
 */
export interface MultiQueryCacheMeta {
  statements: StatementCacheMeta[];
  totalExecutionTime: number;
}

/**
 * Combined result sent to webview: metadata + first page
 */
export interface QueryResultWithPage {
  meta: QueryCacheMeta;
  page: PageData;
}

export interface MultiQueryResultWithPages {
  statements: Array<{
    meta: StatementCacheMeta;
    page: PageData;
  }>;
  totalExecutionTime: number;
}

/**
 * Column statistics returned by getCacheColumnStats
 */
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
    q50?: number;
    q75?: number;
    q95?: number;
  };
  histogram?: Array<{ bucket: string; count: number }>;
  // String-specific
  topValues?: Array<{ value: string; count: number; type: "top_n" | "other" }>;
  // Date/Timestamp-specific
  timeseries?: {
    bins: Array<{ date: string; count: number }>;
    minDate: string;
    maxDate: string;
    granularity: "day" | "week" | "month" | "quarter" | "year";
    totalCount: number;
  };
}

// ============================================================================
// SQL BUILDERS
// ============================================================================

/**
 * Build SQL to summarize a table or view (data statistics)
 * Wrapped in SELECT to work with caching mechanisms
 */
export function buildSummarizeSql(
  database: string,
  schema: string,
  tableName: string
): string {
  const qualifiedName = `"${database}"."${schema}"."${tableName}"`;
  return `SELECT * FROM (SUMMARIZE ${qualifiedName})`;
}

/**
 * Build SQL to summarize a file (data statistics)
 * Wrapped in SELECT to work with caching mechanisms
 */
export function buildSummarizeFileSql(filePath: string): string {
  const escapedPath = filePath.replace(/'/g, "''");
  return `SELECT * FROM (SUMMARIZE '${escapedPath}')`;
}

/**
 * Build SQL to select all from a file
 */
export function buildQueryFileSql(filePath: string): string {
  const escapedPath = filePath.replace(/'/g, "''");
  return `SELECT * FROM '${escapedPath}'`;
}

// ============================================================================
// ERROR TYPES AND PARSING
// ============================================================================

/**
 * Parsed DuckDB error with location information
 */
export interface DuckDBError {
  type: string; // "Parser", "Catalog", "Binder", etc.
  message: string; // Human-readable error message
  subtype?: string; // "SYNTAX_ERROR", "ENTRY_ALREADY_EXISTS", etc.
  position?: number; // Character offset in SQL (for parser errors)
  name?: string; // Object name (for catalog errors)
  // Computed location
  line?: number; // 1-indexed line number
  column?: number; // 0-indexed column number
  // Context
  sql?: string; // The SQL that caused the error
  statementIndex?: number; // Which statement (0-indexed) in multi-statement
}

/**
 * Parse a DuckDB JSON error from an error message.
 * DuckDB returns errors as JSON when `SET errors_as_json='true'` is enabled.
 */
export function parseDuckDBError(
  errorMessage: string,
  sql?: string,
  statementIndex?: number
): DuckDBError {
  console.log("🦆 Parsing error message:", errorMessage);

  // Try to extract JSON from the error message
  const jsonMatch = errorMessage.match(/\{[^{}]*"exception_type"[^{}]*\}/);

  if (jsonMatch) {
    console.log("🦆 Found JSON in error:", jsonMatch[0]);
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log("🦆 Parsed JSON:", parsed);

      const error: DuckDBError = {
        type: parsed.exception_type || "Unknown",
        message: parsed.exception_message || errorMessage,
        subtype: parsed.error_subtype,
        name: parsed.name,
        sql,
        statementIndex,
      };

      // Parse position for parser errors
      if (parsed.position) {
        error.position = parseInt(parsed.position, 10);
        console.log("🦆 Position from error:", error.position);

        // Convert character offset to line/column
        if (sql && !isNaN(error.position)) {
          const location = offsetToLineColumn(sql, error.position);
          error.line = location.line;
          error.column = location.column;
          console.log("🦆 Computed location:", location);
        }
      }

      return error;
    } catch (e) {
      console.log("🦆 JSON parsing failed:", e);
      // JSON parsing failed, fall through to default
    }
  } else {
    console.log("🦆 No JSON found in error message");
  }

  // Fallback: try to parse old-style "LINE X:" format
  const lineMatch = errorMessage.match(/LINE\s+(\d+):/);
  const error: DuckDBError = {
    type: "Error",
    message: errorMessage,
    sql,
    statementIndex,
  };

  if (lineMatch) {
    error.line = parseInt(lineMatch[1], 10);
    console.log("🦆 Found LINE format, line:", error.line);
  }

  return error;
}

/**
 * Convert a character offset to line and column numbers.
 * @param text The full text
 * @param offset 0-indexed character offset
 * @returns { line: 1-indexed, column: 0-indexed }
 */
export function offsetToLineColumn(
  text: string,
  offset: number
): { line: number; column: number } {
  let line = 1;
  let lastNewline = -1;

  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      lastNewline = i;
    }
  }

  const column = offset - lastNewline - 1;
  return { line, column: Math.max(0, column) };
}

/**
 * Custom error class for DuckDB errors with location info
 */
export class DuckDBQueryError extends Error {
  public readonly duckdbError: DuckDBError;
  /** Statements that completed successfully before the error (for multi-statement batches) */
  public readonly partialResults?: MultiQueryResultWithPages;

  constructor(error: DuckDBError, partialResults?: MultiQueryResultWithPages) {
    super(error.message);
    this.name = "DuckDBQueryError";
    this.duckdbError = error;
    this.partialResults = partialResults;
  }
}

// ============================================================================
// STATEMENT TYPE DETECTION
// ============================================================================

/**
 * Statement types for determining execution strategy:
 * - 'select': Can be cached in temp table (SELECT, WITH, VALUES, etc.)
 * - 'utility': Returns results but can't be wrapped (SHOW, DESCRIBE, EXPLAIN, etc.)
 * - 'command': DDL/DML that doesn't return tabular results (CREATE, DROP, INSERT, etc.)
 */
export type StatementType = "select" | "utility" | "command";

/**
 * Determine the type of SQL statement for execution strategy.
 * This affects whether we can cache results in a temp table.
 */
export function getStatementType(sql: string): StatementType {
  // Remove comments and normalize whitespace
  const normalized = sql
    .replace(/--.*$/gm, "") // Remove single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, "") // Remove multi-line comments
    .trim()
    .toUpperCase();

  // SELECT-like statements that can be cached in temp tables
  // These produce result sets that can be wrapped in CREATE TABLE AS
  if (/^(SELECT|WITH|VALUES|TABLE|FROM)\s/.test(normalized)) {
    return "select";
  }

  // Utility statements that return results but can't be wrapped in CREATE TABLE AS
  // These return metadata/system info, typically small result sets
  if (/^(SHOW|DESCRIBE|EXPLAIN|PRAGMA|CALL|SUMMARIZE)\s/.test(normalized)) {
    return "utility";
  }

  // Everything else: DDL (CREATE, DROP, ALTER) and DML (INSERT, UPDATE, DELETE)
  // Also includes: ATTACH, DETACH, INSTALL, LOAD, SET, COPY, EXPORT, IMPORT, etc.
  return "command";
}

// ============================================================================
// DUCKDB SERVICE
// ============================================================================

/**
 * DuckDB Service - manages database connections, query execution, and result caching.
 * Uses temp tables to cache results for pagination, sorting, and export.
 */
export class DuckDBService {
  private instance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;
  private cacheCounter = 0;
  private activeCaches: Set<string> = new Set();

  /**
   * Initialize an in-memory DuckDB database
   */
  async initialize(options?: {
    memoryLimit?: string;
    maxTempDirectorySize?: string;
    tempDirectory?: string;
  }): Promise<void> {
    if (this.instance) {
      return;
    }

    console.log("🦆 Initializing DuckDB...");

    this.instance = await DuckDBInstance.create(":memory:");
    this.connection = await this.instance.connect();

    // Enable JSON error format for easier parsing
    await this.connection.run("SET errors_as_json = true");

    // Cap DuckDB memory so it spills to disk instead of crashing the
    // VS Code extension host process (~1.5 GB heap limit).
    const memoryLimit = options?.memoryLimit || "1.5GB";
    await this.connection.run(`SET memory_limit = '${memoryLimit}'`);

    // Use OS temp directory so spill files don't pollute the user's
    // project and get cleaned up by the OS if the process crashes.
    const tempDir =
      options?.tempDirectory || path.join(os.tmpdir(), "duckdb-vscode");
    fs.mkdirSync(tempDir, { recursive: true });
    await this.connection.run(`SET temp_directory = '${tempDir}'`);

    // Allow DuckDB to spill to disk when memory_limit is exceeded
    const maxTempSize = options?.maxTempDirectorySize || "15GB";
    await this.connection.run(`SET max_temp_directory_size = '${maxTempSize}'`);

    console.log(
      `🦆 DuckDB initialized (memory_limit=${memoryLimit}, temp_directory=${tempDir}, max_temp_directory_size=${maxTempSize})`
    );
  }

  /**
   * Generate a unique cache ID
   */
  private generateCacheId(): string {
    return `_cache_${Date.now()}_${++this.cacheCounter}`;
  }

  /**
   * Execute SQL (one or more statements) with intelligent caching.
   *
   * Statement handling by type:
   * - SELECT-like: Cached in temp table for pagination/sorting/export
   * - Utility (SHOW, DESCRIBE, etc.): Returns all results, no caching
   * - Commands (CREATE, DROP, etc.): Executes and returns success
   */
  async executeQuery(
    sql: string,
    pageSize: number
  ): Promise<MultiQueryResultWithPages> {
    await this.initialize();

    if (!this.connection) {
      throw new Error("DuckDB connection not available");
    }

    const totalStartTime = performance.now();
    const results: Array<{ meta: StatementCacheMeta; page: PageData }> = [];

    // Extract statements - this can fail with parser errors
    let statementCount: number;
    let sqlStatements: string[];
    try {
      const extracted = await this.connection.extractStatements(sql);
      statementCount = extracted.count;
      sqlStatements = splitSqlStatements(sql, statementCount);
    } catch (extractErr) {
      // extractStatements does full parsing and may reject the batch if any
      // statement has a syntax error. Fall back to our own semicolon-based
      // splitter so we can still execute the valid statements before the error.
      sqlStatements = splitSqlStatements(sql, -1);
      statementCount = sqlStatements.length;

      if (statementCount === 0) {
        // Nothing to execute — surface the original parser error
        const originalMsg = (extractErr as Error).message || "Syntax Error";
        const parsed = parseDuckDBError(originalMsg, sql, 0);
        throw new DuckDBQueryError(parsed);
      }
    }

    // Track cumulative offset for multi-statement error mapping
    let cumulativeOffset = 0;

    for (let i = 0; i < statementCount; i++) {
      const stmtStartTime = performance.now();
      const stmtSql = sqlStatements[i] || `Statement ${i + 1}`;
      const stmtType = getStatementType(stmtSql);

      try {
        if (stmtType === "select") {
          // SELECT-like: Cache in temp table for pagination
          const result = await this.executeSelectStatement(
            stmtSql,
            i,
            pageSize,
            stmtStartTime
          );
          results.push(result);
        } else if (stmtType === "utility") {
          // Utility: Run and return all results (no pagination)
          const result = await this.executeUtilityStatement(
            stmtSql,
            i,
            pageSize,
            stmtStartTime
          );
          results.push(result);
        } else {
          // Command: Execute and return success
          const result = await this.executeCommandStatement(
            stmtSql,
            i,
            pageSize,
            stmtStartTime
          );
          results.push(result);
        }
      } catch (err) {
        const error = err as Error;
        // Parse error and adjust position for multi-statement offset
        const parsed = parseDuckDBError(error.message, stmtSql, i);

        // Adjust position to be relative to full SQL document
        if (parsed.position !== undefined) {
          parsed.position += cumulativeOffset;
          const location = offsetToLineColumn(sql, parsed.position);
          parsed.line = location.line;
          parsed.column = location.column;
        } else if (parsed.line !== undefined) {
          // Adjust line number for statement offset
          const stmtStartLocation = offsetToLineColumn(sql, cumulativeOffset);
          parsed.line += stmtStartLocation.line - 1;
        }

        parsed.sql = sql; // Full SQL for context

        // Attach any statements that completed before the error
        const partial =
          results.length > 0
            ? {
                statements: [...results],
                totalExecutionTime: performance.now() - totalStartTime,
              }
            : undefined;
        throw new DuckDBQueryError(parsed, partial);
      }

      // Update cumulative offset for next statement
      // Find where this statement ends in the original SQL
      const stmtEnd = sql.indexOf(stmtSql, cumulativeOffset) + stmtSql.length;
      cumulativeOffset = stmtEnd;
      // Skip past any semicolon and whitespace
      while (
        cumulativeOffset < sql.length &&
        /[\s;]/.test(sql[cumulativeOffset])
      ) {
        cumulativeOffset++;
      }
    }

    const totalExecutionTime = performance.now() - totalStartTime;

    return {
      statements: results,
      totalExecutionTime,
    };
  }

  /**
   * Execute a SELECT-like statement and cache results in temp table
   */
  private async executeSelectStatement(
    sql: string,
    statementIndex: number,
    pageSize: number,
    startTime: number
  ): Promise<{ meta: StatementCacheMeta; page: PageData }> {
    if (!this.connection) throw new Error("No connection");

    const cacheId = this.generateCacheId();

    try {
      // Create temp table with results
      const createSql = `CREATE TEMP TABLE "${cacheId}" AS (${sql})`;
      await this.connection.run(createSql);
      this.activeCaches.add(cacheId);

      // Get metadata
      const countResult = await this.connection.runAndReadAll(
        `SELECT COUNT(*) as cnt FROM "${cacheId}"`
      );
      const totalRows = Number(countResult.getRowObjectsJS()[0].cnt);

      // Get column info
      const schemaResult = await this.connection.runAndReadAll(
        `DESCRIBE "${cacheId}"`
      );
      const schemaRows = schemaResult.getRowObjectsJS();
      const columns = schemaRows.map((r) => String(r.column_name));
      const columnTypes = schemaRows.map((r) => String(r.column_type));

      const executionTime = performance.now() - startTime;

      const meta: StatementCacheMeta = {
        cacheId,
        sql,
        statementIndex,
        columns,
        columnTypes,
        totalRows,
        executionTime,
        hasResults: true,
      };

      const page = await this.fetchPage(cacheId, 0, pageSize);
      return { meta, page };
    } catch (err) {
      await this.dropCache(cacheId);
      throw err;
    }
  }

  /**
   * Execute a utility statement (SHOW, DESCRIBE, etc.) and return all results
   * These can't be wrapped in CREATE TABLE AS, so no caching/pagination
   */
  private async executeUtilityStatement(
    sql: string,
    statementIndex: number,
    pageSize: number,
    startTime: number
  ): Promise<{ meta: StatementCacheMeta; page: PageData }> {
    if (!this.connection) throw new Error("No connection");

    const reader = await this.connection.runAndReadAll(sql);
    const columns = reader.columnNames();
    const columnTypes = reader.columnTypes().map((t) => t.toString());
    const rawRows = reader.getRowObjectsJS();
    const rows = rawRows.map((row) =>
      serializeRow(row as Record<string, unknown>, columns)
    );

    const executionTime = performance.now() - startTime;

    const meta: StatementCacheMeta = {
      cacheId: "", // No cache for utility statements
      sql,
      statementIndex,
      columns,
      columnTypes,
      totalRows: rows.length,
      executionTime,
      hasResults: true,
    };

    const page: PageData = {
      cacheId: "",
      rows,
      offset: 0,
      pageSize: rows.length, // Return all rows
      totalRows: rows.length,
    };

    return { meta, page };
  }

  /**
   * Execute a command statement (CREATE, DROP, INSERT, etc.)
   * These don't return tabular results
   */
  private async executeCommandStatement(
    sql: string,
    statementIndex: number,
    pageSize: number,
    startTime: number
  ): Promise<{ meta: StatementCacheMeta; page: PageData }> {
    if (!this.connection) throw new Error("No connection");

    await this.connection.run(sql);

    const executionTime = performance.now() - startTime;

    const meta: StatementCacheMeta = {
      cacheId: "",
      sql,
      statementIndex,
      columns: [],
      columnTypes: [],
      totalRows: 0,
      executionTime,
      hasResults: false,
    };

    const page: PageData = {
      cacheId: "",
      rows: [],
      offset: 0,
      pageSize,
      totalRows: 0,
    };

    return { meta, page };
  }

  /**
   * Fetch a page of rows from a cached query.
   * Supports server-side sorting and filtering.
   */
  async fetchPage(
    cacheId: string,
    offset: number,
    pageSize: number,
    sortColumn?: string,
    sortDirection?: "asc" | "desc",
    whereClause?: string
  ): Promise<PageData> {
    await this.initialize();

    if (!this.connection) {
      throw new Error("DuckDB connection not available");
    }

    if (!cacheId) {
      return {
        cacheId: "",
        rows: [],
        offset: 0,
        pageSize,
        totalRows: 0,
      };
    }

    try {
      // Build query with optional filtering and sorting
      let sql = `SELECT * FROM "${cacheId}"`;
      if (whereClause && whereClause.trim()) {
        sql += ` WHERE ${whereClause}`;
      }
      if (sortColumn) {
        const dir = sortDirection === "desc" ? "DESC" : "ASC";
        sql += ` ORDER BY "${sortColumn}" ${dir} NULLS LAST`;
      }
      sql += ` LIMIT ${pageSize} OFFSET ${offset}`;

      const reader = await this.connection.runAndReadAll(sql);
      const columns = reader.columnNames();
      const rawRows = reader.getRowObjectsJS();
      const rows = rawRows.map((row) =>
        serializeRow(row as Record<string, unknown>, columns)
      );

      // Get total rows (with filter applied)
      let countSql = `SELECT COUNT(*) as cnt FROM "${cacheId}"`;
      if (whereClause && whereClause.trim()) {
        countSql += ` WHERE ${whereClause}`;
      }
      const countResult = await this.connection.runAndReadAll(countSql);
      const totalRows = Number(countResult.getRowObjectsJS()[0].cnt);

      return {
        cacheId,
        rows,
        offset,
        pageSize,
        totalRows,
        sortColumn,
        sortDirection,
      };
    } catch (err) {
      const error = err as Error;
      throw new Error(`Failed to fetch page: ${error.message}`);
    }
  }

  /**
   * Get distinct values for a column with their counts.
   * Used for filter dropdowns. Returns top values by count.
   */
  async getColumnDistinctValues(
    cacheId: string,
    column: string,
    limit: number = 100,
    searchTerm?: string
  ): Promise<{ value: string; count: number }[]> {
    await this.initialize();

    if (!this.connection) {
      throw new Error("DuckDB connection not available");
    }

    if (!cacheId) {
      return [];
    }

    try {
      const escapedCol = `"${column}"`;
      let sql = `
        SELECT 
          ${escapedCol}::VARCHAR as value,
          COUNT(*) as count
        FROM "${cacheId}"
        WHERE ${escapedCol} IS NOT NULL
      `;

      if (searchTerm && searchTerm.trim()) {
        const escaped = searchTerm.replace(/'/g, "''");
        sql += ` AND ${escapedCol}::VARCHAR ILIKE '%${escaped}%'`;
      }

      sql += `
        GROUP BY 1
        ORDER BY count DESC, value ASC
        LIMIT ${limit}
      `;

      const reader = await this.connection.runAndReadAll(sql);
      const rows = reader.getRowObjectsJS() as Record<string, unknown>[];

      return rows.map((row) => ({
        value: String(row.value),
        count: Number(row.count),
      }));
    } catch (err) {
      const error = err as Error;
      console.log("Failed to get distinct values:", error.message);
      return [];
    }
  }

  /**
   * Get column cardinality (approximate distinct count).
   * Used to determine which filter UI to show.
   */
  async getColumnCardinality(cacheId: string, column: string): Promise<number> {
    await this.initialize();

    if (!this.connection || !cacheId) {
      return 0;
    }

    try {
      const sql = `SELECT COUNT(DISTINCT "${column}") as cardinality FROM "${cacheId}"`;
      const reader = await this.connection.runAndReadAll(sql);
      return Number(
        (reader.getRowObjectsJS()[0] as Record<string, unknown>).cardinality
      );
    } catch {
      return 0;
    }
  }

  /**
   * Export cached results directly to a file using COPY.
   * Bypasses webview entirely for large exports.
   * Supports filtering via whereClause.
   */
  async exportCache(
    cacheId: string,
    format: "csv" | "parquet" | "json" | "jsonl",
    filePath: string,
    maxRows?: number,
    sortColumn?: string,
    sortDirection?: "asc" | "desc",
    whereClause?: string
  ): Promise<void> {
    await this.initialize();

    if (!this.connection) {
      throw new Error("DuckDB connection not available");
    }

    if (!cacheId) {
      throw new Error("No cache available for export");
    }

    try {
      // Build inner query with optional filter, sort and limit
      let innerSql = `SELECT * FROM "${cacheId}"`;
      if (whereClause && whereClause.trim()) {
        innerSql += ` WHERE ${whereClause}`;
      }
      if (sortColumn) {
        const dir = sortDirection === "desc" ? "DESC" : "ASC";
        innerSql += ` ORDER BY "${sortColumn}" ${dir} NULLS LAST`;
      }
      if (maxRows) {
        innerSql += ` LIMIT ${maxRows}`;
      }

      // Build COPY command based on format
      let copyOptions: string;
      switch (format) {
        case "csv":
          copyOptions = "FORMAT CSV, HEADER";
          break;
        case "parquet":
          copyOptions = "FORMAT PARQUET";
          break;
        case "json":
          copyOptions = "FORMAT JSON, ARRAY true";
          break;
        case "jsonl":
          copyOptions = "FORMAT JSON, ARRAY false";
          break;
        default:
          throw new Error(`Unsupported format: ${format}`);
      }

      const copySql = `COPY (${innerSql}) TO '${filePath.replace(
        /'/g,
        "''"
      )}' (${copyOptions})`;
      await this.connection.run(copySql);
    } catch (err) {
      const error = err as Error;
      throw new Error(`Export failed: ${error.message}`);
    }
  }

  /**
   * Get data for copy to clipboard (limited rows, serialized)
   */
  async getCopyData(
    cacheId: string,
    maxRows: number,
    sortColumn?: string,
    sortDirection?: "asc" | "desc"
  ): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
    await this.initialize();

    if (!this.connection) {
      throw new Error("DuckDB connection not available");
    }

    if (!cacheId) {
      return { columns: [], rows: [] };
    }

    try {
      let sql = `SELECT * FROM "${cacheId}"`;
      if (sortColumn) {
        const dir = sortDirection === "desc" ? "DESC" : "ASC";
        sql += ` ORDER BY "${sortColumn}" ${dir} NULLS LAST`;
      }
      sql += ` LIMIT ${maxRows}`;

      const reader = await this.connection.runAndReadAll(sql);
      const columns = reader.columnNames();
      const rawRows = reader.getRowObjectsJS();
      const rows = rawRows.map((row) =>
        serializeRow(row as Record<string, unknown>, columns)
      );

      return { columns, rows };
    } catch (err) {
      const error = err as Error;
      throw new Error(`Failed to get copy data: ${error.message}`);
    }
  }

  /**
   * Compute column statistics against cached data
   * @param whereClause Optional WHERE clause to filter the data (without the WHERE keyword)
   */
  async getCacheColumnStats(
    cacheId: string,
    column: string,
    whereClause?: string
  ): Promise<ColumnStats> {
    await this.initialize();

    if (!this.connection) {
      throw new Error("DuckDB connection not available");
    }

    if (!cacheId) {
      throw new Error("No cache available for stats");
    }

    const escapedCol = `"${column}"`;
    const whereFilter = whereClause ? `WHERE ${whereClause}` : "";

    // Basic stats query
    const basicSql = `
      SELECT 
        COUNT(*) as total,
        COUNT(${escapedCol}) as non_null,
        COUNT(*) - COUNT(${escapedCol}) as null_count,
        COUNT(DISTINCT ${escapedCol}) as unique_count,
        MIN(${escapedCol})::VARCHAR as min_val,
        MAX(${escapedCol})::VARCHAR as max_val
      FROM "${cacheId}"
      ${whereFilter}
    `;

    const basicReader = await this.connection.runAndReadAll(basicSql);
    const basicRow = basicReader.getRowObjectsJS()[0] as Record<
      string,
      unknown
    >;

    // Determine column type: boolean, date/timestamp, numeric, or string
    // Boolean check must come before numeric since booleans cast to numbers
    const typeCheckSql = `
      SELECT 
        CASE 
          WHEN TRY_CAST(${escapedCol} AS BOOLEAN) IS NOT NULL 
            AND ${escapedCol}::VARCHAR IN ('true', 'false', 'TRUE', 'FALSE', '1', '0') THEN 'boolean'
          WHEN TRY_CAST(${escapedCol} AS DATE) IS NOT NULL 
            OR TRY_CAST(${escapedCol} AS TIMESTAMP) IS NOT NULL THEN 'date'
          WHEN TRY_CAST(${escapedCol} AS DOUBLE) IS NOT NULL THEN 'numeric'
          ELSE 'string'
        END as col_type
      FROM "${cacheId}" 
      WHERE ${escapedCol} IS NOT NULL ${
      whereClause ? `AND (${whereClause})` : ""
    }
      LIMIT 1
    `;
    const typeCheckReader = await this.connection.runAndReadAll(typeCheckSql);
    const typeCheckRows = typeCheckReader.getRowObjectsJS() as Record<
      string,
      unknown
    >[];
    const detectedType =
      typeCheckRows.length > 0 ? String(typeCheckRows[0].col_type) : "string";

    const isBoolean = detectedType === "boolean";
    const isDate = detectedType === "date";
    const isNumeric = detectedType === "numeric" && !isBoolean;

    // Build the base stats object
    const stats: ColumnStats = {
      column,
      type: isDate ? "date" : isNumeric ? "numeric" : "string",
      total: Number(basicRow.total) || 0,
      nonNull: Number(basicRow.non_null) || 0,
      nullCount: Number(basicRow.null_count) || 0,
      unique: Number(basicRow.unique_count) || 0,
      min: basicRow.min_val as string | null,
      max: basicRow.max_val as string | null,
    };

    if (isDate) {
      await this.addTimeseriesStats(stats, cacheId, escapedCol, whereClause);
    } else if (isNumeric) {
      await this.addNumericStats(stats, cacheId, escapedCol, whereClause);
    } else {
      // Booleans and strings get categorical stats (top values)
      await this.addCategoricalStats(stats, cacheId, escapedCol, whereClause);
    }

    return stats;
  }

  /**
   * Add numeric-specific stats (mean, stddev, quantiles, histogram)
   */
  private async addNumericStats(
    stats: ColumnStats,
    cacheId: string,
    escapedCol: string,
    whereClause?: string
  ): Promise<void> {
    if (!this.connection) return;

    const baseFilter = `${escapedCol} IS NOT NULL`;
    const fullFilter = whereClause
      ? `${baseFilter} AND (${whereClause})`
      : baseFilter;

    // Get descriptive statistics
    const numericSql = `
      SELECT 
        AVG(${escapedCol}) as mean_val,
        STDDEV(${escapedCol}) as stddev_val,
        approx_quantile(${escapedCol}, [0.05, 0.25, 0.5, 0.75, 0.95]) as quantiles
      FROM "${cacheId}"
      WHERE ${fullFilter}
    `;

    try {
      const numericReader = await this.connection.runAndReadAll(numericSql);
      const numRow = numericReader.getRowObjectsJS()[0] as Record<
        string,
        unknown
      >;

      if (numRow.mean_val != null) {
        stats.mean = Number(numRow.mean_val);
      }
      if (numRow.stddev_val != null) {
        stats.stddev = Number(numRow.stddev_val);
      }
      if (numRow.quantiles && Array.isArray(numRow.quantiles)) {
        const q = numRow.quantiles as number[];
        stats.quantiles = {
          q05: q[0] != null ? Number(q[0]) : undefined,
          q25: q[1] != null ? Number(q[1]) : undefined,
          q50: q[2] != null ? Number(q[2]) : undefined,
          q75: q[3] != null ? Number(q[3]) : undefined,
          q95: q[4] != null ? Number(q[4]) : undefined,
        };
      }
    } catch (e) {
      console.log("Numeric stats query failed:", e);
    }

    // Get binned histogram (20 bins)
    const numBins = 20;
    const histogramSql = `
      WITH filtered_data AS (
        SELECT ${escapedCol} FROM "${cacheId}" WHERE ${fullFilter}
      ),
      bounds AS (
        SELECT 
          MIN(${escapedCol})::DOUBLE as min_val,
          MAX(${escapedCol})::DOUBLE as max_val
        FROM filtered_data
      ),
      bin_ranges AS (
        SELECT 
          generate_series as bin_idx,
          (SELECT min_val FROM bounds) + 
            generate_series * ((SELECT max_val - min_val FROM bounds) / ${numBins}.0) as bin_start,
          (SELECT min_val FROM bounds) + 
            (generate_series + 1) * ((SELECT max_val - min_val FROM bounds) / ${numBins}.0) as bin_end
        FROM generate_series(0, ${numBins - 1})
      ),
      binned_data AS (
        SELECT 
          CASE 
            WHEN (SELECT max_val - min_val FROM bounds) = 0 THEN 0
            ELSE LEAST(
              FLOOR((${escapedCol}::DOUBLE - (SELECT min_val FROM bounds)) / 
                    NULLIF((SELECT max_val - min_val FROM bounds) / ${numBins}.0, 0)),
              ${numBins - 1}
            )::INTEGER
          END as bin_idx
        FROM filtered_data
      ),
      bin_counts AS (
        SELECT bin_idx, COUNT(*) as count
        FROM binned_data
        GROUP BY bin_idx
      )
      SELECT 
        COALESCE(bc.count, 0) as count,
        br.bin_start,
        br.bin_end
      FROM bin_ranges br
      LEFT JOIN bin_counts bc ON br.bin_idx = bc.bin_idx
      ORDER BY br.bin_idx
    `;

    try {
      const histReader = await this.connection.runAndReadAll(histogramSql);
      const histRows = histReader.getRowObjectsJS() as Record<
        string,
        unknown
      >[];
      stats.histogram = histRows.map((row) => ({
        bucket: formatHistogramBucket(
          Number(row.bin_start),
          Number(row.bin_end)
        ),
        count: Number(row.count),
      }));
    } catch (e) {
      console.log("Histogram query failed:", e);
    }
  }

  /**
   * Add categorical stats (top values)
   */
  private async addCategoricalStats(
    stats: ColumnStats,
    cacheId: string,
    escapedCol: string,
    whereClause?: string
  ): Promise<void> {
    if (!this.connection) return;

    const baseFilter = `${escapedCol} IS NOT NULL`;
    const fullFilter = whereClause
      ? `${baseFilter} AND (${whereClause})`
      : baseFilter;

    const topValuesSql = `
      WITH filtered_data AS (
        SELECT ${escapedCol} FROM "${cacheId}" WHERE ${fullFilter}
      ),
      top_values AS (
        SELECT
          COUNT(*) AS count,
          ${escapedCol}::VARCHAR AS value,
          'top_n' AS type
        FROM filtered_data
        GROUP BY 2
        ORDER BY count DESC
      ),
      top_n AS (
        SELECT * FROM top_values ORDER BY count DESC LIMIT 10
      ),
      others AS (
        SELECT
          COUNT(*) AS count,
          'Other' AS value,
          'other' AS type
        FROM filtered_data 
        WHERE ${escapedCol}::VARCHAR NOT IN (SELECT value FROM top_n)
      )
      SELECT * FROM top_n 
      UNION ALL 
      SELECT * FROM others WHERE count > 0
    `;

    try {
      const topReader = await this.connection.runAndReadAll(topValuesSql);
      const topRows = topReader.getRowObjectsJS() as Record<string, unknown>[];
      stats.topValues = topRows.map((row) => ({
        value: String(row.value),
        count: Number(row.count),
        type: row.type as "top_n" | "other",
      }));
    } catch (e) {
      console.log("Top values query failed:", e);
    }
  }

  /**
   * Add timeseries stats for date/timestamp columns
   */
  private async addTimeseriesStats(
    stats: ColumnStats,
    cacheId: string,
    escapedCol: string,
    whereClause?: string
  ): Promise<void> {
    if (!this.connection) return;

    const baseFilter = `${escapedCol} IS NOT NULL`;
    const fullFilter = whereClause
      ? `${baseFilter} AND (${whereClause})`
      : baseFilter;

    try {
      // Get date range first
      const rangeSql = `
        SELECT 
          MIN(${escapedCol})::DATE as min_date,
          MAX(${escapedCol})::DATE as max_date,
          COUNT(*) as total_count
        FROM "${cacheId}"
        WHERE ${fullFilter}
      `;
      const rangeReader = await this.connection.runAndReadAll(rangeSql);
      const rangeRow = rangeReader.getRowObjectsJS()[0] as Record<
        string,
        unknown
      >;

      if (!rangeRow.min_date || !rangeRow.max_date) return;

      const minDate = new Date(String(rangeRow.min_date));
      const maxDate = new Date(String(rangeRow.max_date));
      const totalCount = Number(rangeRow.total_count);

      // Calculate span in days
      const spanDays = Math.max(
        1,
        (maxDate.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24)
      );

      // Determine appropriate granularity based on span
      let granularity: "day" | "week" | "month" | "quarter" | "year";
      let truncFunc: string;
      let maxBins: number;

      if (spanDays <= 60) {
        // Up to 2 months: daily
        granularity = "day";
        truncFunc = "DATE_TRUNC('day', " + escapedCol + ")";
        maxBins = 60;
      } else if (spanDays <= 365) {
        // Up to 1 year: weekly
        granularity = "week";
        truncFunc = "DATE_TRUNC('week', " + escapedCol + ")";
        maxBins = 52;
      } else if (spanDays <= 365 * 5) {
        // Up to 5 years: monthly
        granularity = "month";
        truncFunc = "DATE_TRUNC('month', " + escapedCol + ")";
        maxBins = 60;
      } else if (spanDays <= 365 * 20) {
        // Up to 20 years: quarterly
        granularity = "quarter";
        truncFunc = "DATE_TRUNC('quarter', " + escapedCol + ")";
        maxBins = 80;
      } else {
        // Over 20 years: yearly
        granularity = "year";
        truncFunc = "DATE_TRUNC('year', " + escapedCol + ")";
        maxBins = 100;
      }

      // Get bucketed counts
      const bucketSql = `
        SELECT 
          ${truncFunc}::DATE::VARCHAR as bucket_date,
          COUNT(*) as count
        FROM "${cacheId}"
        WHERE ${fullFilter}
        GROUP BY 1
        ORDER BY 1
        LIMIT ${maxBins}
      `;

      const bucketReader = await this.connection.runAndReadAll(bucketSql);
      const bucketRows = bucketReader.getRowObjectsJS() as Record<
        string,
        unknown
      >[];

      stats.timeseries = {
        bins: bucketRows.map((row) => ({
          date: String(row.bucket_date),
          count: Number(row.count),
        })),
        minDate: String(rangeRow.min_date),
        maxDate: String(rangeRow.max_date),
        granularity,
        totalCount,
      };
    } catch (e) {
      console.log("Timeseries stats query failed:", e);
    }
  }

  /**
   * Get column summaries for all columns in a cache table using DuckDB's SUMMARIZE.
   * Returns distinct count, null percentage, and column type for each column.
   */
  async getCacheColumnSummaries(
    cacheId: string
  ): Promise<Record<string, unknown>[]> {
    await this.initialize();

    if (!this.connection) {
      throw new Error("DuckDB connection not available");
    }

    if (!cacheId) {
      return [];
    }

    // Use DuckDB's built-in SUMMARIZE for efficient stats computation
    const sql = `SUMMARIZE "${cacheId}"`;

    try {
      const reader = await this.connection.runAndReadAll(sql);
      const rows = reader.getRowObjectsJS() as Record<string, unknown>[];

      return rows.map((row) => ({
        name: row.column_name as string,
        distinctCount: Number(row.approx_unique) || 0,
        nullPercent: Number(row.null_percentage) || 0,
        inferredType: row.column_type as string,
      }));
    } catch (e) {
      console.error("SUMMARIZE query failed:", e);
      return [];
    }
  }

  /**
   * Drop a cached query result
   */
  async dropCache(cacheId: string): Promise<void> {
    if (!this.connection || !cacheId) {
      return;
    }

    try {
      await this.connection.run(`DROP TABLE IF EXISTS "${cacheId}"`);
      this.activeCaches.delete(cacheId);
    } catch {
      // Ignore errors when dropping cache
    }
  }

  /**
   * Drop all active caches
   */
  async dropAllCaches(): Promise<void> {
    const caches = Array.from(this.activeCaches);
    for (const cacheId of caches) {
      await this.dropCache(cacheId);
    }
  }

  /**
   * Execute a SQL statement without returning results (for CREATE, INSERT, etc.)
   */
  async run(sql: string): Promise<void> {
    await this.initialize();

    if (!this.connection) {
      throw new Error("DuckDB connection not available");
    }

    try {
      await this.connection.run(sql);
    } catch (err) {
      const error = err as Error;
      throw new Error(`Statement failed: ${error.message}`);
    }
  }

  /**
   * Execute a simple query and return all rows (for small results like metadata queries)
   */
  async query(sql: string): Promise<Record<string, unknown>[]> {
    await this.initialize();

    if (!this.connection) {
      throw new Error("DuckDB connection not available");
    }

    const reader = await this.connection.runAndReadAll(sql);
    const columns = reader.columnNames();
    const rawRows = reader.getRowObjectsJS();
    return rawRows.map((row) =>
      serializeRow(row as Record<string, unknown>, columns)
    );
  }

  /**
   * Get lightweight metadata for a data file (DESCRIBE + COUNT).
   * Cheap for parquet (reads footer metadata), fast for CSV/JSON.
   */
  async getFileMetadata(
    filePath: string
  ): Promise<{ columns: { name: string; type: string }[]; rowCount: number }> {
    await this.initialize();

    if (!this.connection) {
      throw new Error("DuckDB connection not available");
    }

    const escaped = filePath.replace(/'/g, "''");
    const [describeResult, countResult] = await Promise.all([
      this.connection.runAndReadAll(`DESCRIBE SELECT * FROM '${escaped}'`),
      this.connection.runAndReadAll(`SELECT COUNT(*) as cnt FROM '${escaped}'`),
    ]);

    const describeRows = describeResult.getRowObjectsJS();
    const columns = describeRows.map((r) => ({
      name: String(r.column_name),
      type: String(r.column_type),
    }));

    const rowCount = Number(countResult.getRowObjectsJS()[0].cnt);

    return { columns, rowCount };
  }

  /**
   * Get column summaries for a file using SUMMARIZE (no cache needed).
   * Returns distinct count, null percentage, and column type for each column.
   * Cheap for Parquet (reads footer metadata), requires full scan for CSV/JSON.
   */
  async getFileSummaries(filePath: string): Promise<
    Array<{
      name: string;
      distinctCount: number;
      nullPercent: number;
      inferredType: string;
    }>
  > {
    await this.initialize();
    if (!this.connection) {
      throw new Error("DuckDB connection not available");
    }

    const escaped = filePath.replace(/'/g, "''");
    const sql = `SUMMARIZE SELECT * FROM '${escaped}'`;

    try {
      const reader = await this.connection.runAndReadAll(sql);
      const rows = reader.getRowObjectsJS() as Record<string, unknown>[];
      return rows.map((row) => ({
        name: row.column_name as string,
        distinctCount: Number(row.approx_unique) || 0,
        nullPercent: Number(row.null_percentage) || 0,
        inferredType: row.column_type as string,
      }));
    } catch (e) {
      console.error("SUMMARIZE file query failed:", e);
      return [];
    }
  }

  /**
   * Get detailed column statistics for a single column in a file (no cache needed).
   * Same stats as getCacheColumnStats but queries the file directly.
   */
  async getFileColumnStats(
    filePath: string,
    column: string
  ): Promise<ColumnStats> {
    await this.initialize();
    if (!this.connection) {
      throw new Error("DuckDB connection not available");
    }

    const escaped = filePath.replace(/'/g, "''");
    const source = `'${escaped}'`;
    const escapedCol = `"${column}"`;

    // Basic stats
    const basicSql = `
      SELECT 
        COUNT(*) as total,
        COUNT(${escapedCol}) as non_null,
        COUNT(*) - COUNT(${escapedCol}) as null_count,
        COUNT(DISTINCT ${escapedCol}) as unique_count,
        MIN(${escapedCol})::VARCHAR as min_val,
        MAX(${escapedCol})::VARCHAR as max_val
      FROM ${source}
    `;

    const basicReader = await this.connection.runAndReadAll(basicSql);
    const basicRow = basicReader.getRowObjectsJS()[0] as Record<
      string,
      unknown
    >;

    // Detect column type
    const typeCheckSql = `
      SELECT 
        CASE 
          WHEN TRY_CAST(${escapedCol} AS BOOLEAN) IS NOT NULL 
            AND ${escapedCol}::VARCHAR IN ('true', 'false', 'TRUE', 'FALSE', '1', '0') THEN 'boolean'
          WHEN TRY_CAST(${escapedCol} AS DATE) IS NOT NULL 
            OR TRY_CAST(${escapedCol} AS TIMESTAMP) IS NOT NULL THEN 'date'
          WHEN TRY_CAST(${escapedCol} AS DOUBLE) IS NOT NULL THEN 'numeric'
          ELSE 'string'
        END as col_type
      FROM ${source} 
      WHERE ${escapedCol} IS NOT NULL
      LIMIT 1
    `;
    const typeCheckReader = await this.connection.runAndReadAll(typeCheckSql);
    const typeCheckRows = typeCheckReader.getRowObjectsJS() as Record<
      string,
      unknown
    >[];
    const detectedType =
      typeCheckRows.length > 0 ? String(typeCheckRows[0].col_type) : "string";

    const isBoolean = detectedType === "boolean";
    const isDate = detectedType === "date";
    const isNumeric = detectedType === "numeric" && !isBoolean;

    const stats: ColumnStats = {
      column,
      type: isDate ? "date" : isNumeric ? "numeric" : "string",
      total: Number(basicRow.total) || 0,
      nonNull: Number(basicRow.non_null) || 0,
      nullCount: Number(basicRow.null_count) || 0,
      unique: Number(basicRow.unique_count) || 0,
      min: basicRow.min_val as string | null,
      max: basicRow.max_val as string | null,
    };

    // Use the same helpers — they take a source identifier
    // We need to create a temp view so the helpers can reference it
    const tempView = `__file_stats_${Date.now()}`;
    await this.connection.run(
      `CREATE OR REPLACE TEMP VIEW "${tempView}" AS SELECT * FROM ${source}`
    );

    try {
      if (isDate) {
        await this.addTimeseriesStats(stats, tempView, escapedCol);
      } else if (isNumeric) {
        await this.addNumericStats(stats, tempView, escapedCol);
      } else {
        await this.addCategoricalStats(stats, tempView, escapedCol);
      }
    } finally {
      this.connection.run(`DROP VIEW IF EXISTS "${tempView}"`).catch(() => {});
    }

    return stats;
  }

  // ============================================================================
  // TABLE METADATA (for database table/view overview)
  // ============================================================================

  /**
   * Get lightweight metadata for a database table or view.
   * Runs DESCRIBE + COUNT(*) against the qualified table name.
   */
  async getTableMetadata(
    database: string,
    schema: string,
    tableName: string
  ): Promise<{ columns: { name: string; type: string }[]; rowCount: number }> {
    await this.initialize();
    if (!this.connection) {
      throw new Error("DuckDB connection not available");
    }

    const qualifiedName = `"${database}"."${schema}"."${tableName}"`;
    const [describeResult, countResult] = await Promise.all([
      this.connection.runAndReadAll(`DESCRIBE ${qualifiedName}`),
      this.connection.runAndReadAll(
        `SELECT COUNT(*) as cnt FROM ${qualifiedName}`
      ),
    ]);

    const describeRows = describeResult.getRowObjectsJS();
    const columns = describeRows.map((r) => ({
      name: String(r.column_name),
      type: String(r.column_type),
    }));

    const rowCount = Number(countResult.getRowObjectsJS()[0].cnt);
    return { columns, rowCount };
  }

  /**
   * Get column summaries for a database table using SUMMARIZE.
   * Returns distinct count, null percentage, and column type for each column.
   */
  async getTableSummaries(
    database: string,
    schema: string,
    tableName: string
  ): Promise<
    Array<{
      name: string;
      distinctCount: number;
      nullPercent: number;
      inferredType: string;
    }>
  > {
    await this.initialize();
    if (!this.connection) {
      throw new Error("DuckDB connection not available");
    }

    const qualifiedName = `"${database}"."${schema}"."${tableName}"`;
    const sql = `SUMMARIZE ${qualifiedName}`;

    try {
      const reader = await this.connection.runAndReadAll(sql);
      const rows = reader.getRowObjectsJS() as Record<string, unknown>[];
      return rows.map((row) => ({
        name: row.column_name as string,
        distinctCount: Number(row.approx_unique) || 0,
        nullPercent: Number(row.null_percentage) || 0,
        inferredType: row.column_type as string,
      }));
    } catch (e) {
      console.error("SUMMARIZE table query failed:", e);
      return [];
    }
  }

  /**
   * Get detailed column statistics for a single column in a database table.
   * Same stats as getCacheColumnStats but queries the table directly.
   */
  async getTableColumnStats(
    database: string,
    schema: string,
    tableName: string,
    column: string
  ): Promise<ColumnStats> {
    await this.initialize();
    if (!this.connection) {
      throw new Error("DuckDB connection not available");
    }

    const qualifiedName = `"${database}"."${schema}"."${tableName}"`;
    const escapedCol = `"${column}"`;

    // Basic stats
    const basicSql = `
      SELECT 
        COUNT(*) as total,
        COUNT(${escapedCol}) as non_null,
        COUNT(*) - COUNT(${escapedCol}) as null_count,
        COUNT(DISTINCT ${escapedCol}) as unique_count,
        MIN(${escapedCol})::VARCHAR as min_val,
        MAX(${escapedCol})::VARCHAR as max_val
      FROM ${qualifiedName}
    `;

    const basicReader = await this.connection.runAndReadAll(basicSql);
    const basicRow = basicReader.getRowObjectsJS()[0] as Record<
      string,
      unknown
    >;

    // Detect column type
    const typeCheckSql = `
      SELECT 
        CASE 
          WHEN TRY_CAST(${escapedCol} AS BOOLEAN) IS NOT NULL 
            AND ${escapedCol}::VARCHAR IN ('true', 'false', 'TRUE', 'FALSE', '1', '0') THEN 'boolean'
          WHEN TRY_CAST(${escapedCol} AS DATE) IS NOT NULL 
            OR TRY_CAST(${escapedCol} AS TIMESTAMP) IS NOT NULL THEN 'date'
          WHEN TRY_CAST(${escapedCol} AS DOUBLE) IS NOT NULL THEN 'numeric'
          ELSE 'string'
        END as col_type
      FROM ${qualifiedName} 
      WHERE ${escapedCol} IS NOT NULL
      LIMIT 1
    `;
    const typeCheckReader = await this.connection.runAndReadAll(typeCheckSql);
    const typeCheckRows = typeCheckReader.getRowObjectsJS() as Record<
      string,
      unknown
    >[];
    const detectedType =
      typeCheckRows.length > 0 ? String(typeCheckRows[0].col_type) : "string";

    const isBoolean = detectedType === "boolean";
    const isDate = detectedType === "date";
    const isNumeric = detectedType === "numeric" && !isBoolean;

    const stats: ColumnStats = {
      column,
      type: isDate ? "date" : isNumeric ? "numeric" : "string",
      total: Number(basicRow.total) || 0,
      nonNull: Number(basicRow.non_null) || 0,
      nullCount: Number(basicRow.null_count) || 0,
      unique: Number(basicRow.unique_count) || 0,
      min: basicRow.min_val as string | null,
      max: basicRow.max_val as string | null,
    };

    // Use a temp view so the shared stat helpers can reference it
    const tempView = `__table_stats_${Date.now()}`;
    await this.connection.run(
      `CREATE OR REPLACE TEMP VIEW "${tempView}" AS SELECT * FROM ${qualifiedName}`
    );

    try {
      if (isDate) {
        await this.addTimeseriesStats(stats, tempView, escapedCol);
      } else if (isNumeric) {
        await this.addNumericStats(stats, tempView, escapedCol);
      } else {
        await this.addCategoricalStats(stats, tempView, escapedCol);
      }
    } finally {
      this.connection.run(`DROP VIEW IF EXISTS "${tempView}"`).catch(() => {});
    }

    return stats;
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    await this.dropAllCaches();

    if (this.connection) {
      this.connection.closeSync();
      this.connection = null;
    }
    this.instance = null;
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Collect all cache IDs from a multi-statement result for cleanup.
 */
export function collectCacheIds(result: MultiQueryResultWithPages): string[] {
  return result.statements.map((s) => s.meta.cacheId).filter((id) => id);
}

/**
 * Format histogram bucket label from bin bounds
 */
function formatHistogramBucket(binStart: number, binEnd: number): string {
  const formatNum = (n: number) => {
    if (Number.isInteger(n) && Math.abs(n) < 10000) return n.toString();
    return n.toFixed(1);
  };
  return `${formatNum(binStart)}-${formatNum(binEnd)}`;
}

export function splitSqlStatements(
  sql: string,
  expectedCount: number
): string[] {
  const statements: string[] = [];
  let i = 0;
  let currentStart = 0;

  while (i < sql.length) {
    const char = sql[i];

    // Skip single-line comments
    if (char === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") {
        i++;
      }
      continue;
    }

    // Skip multi-line comments
    if (char === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length - 1 && !(sql[i] === "*" && sql[i + 1] === "/")) {
        i++;
      }
      i += 2;
      continue;
    }

    // Skip string literals (single quotes)
    if (char === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Skip string literals (double quotes)
    if (char === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Skip dollar-quoted strings
    if (char === "$") {
      const dollarMatch = sql.slice(i).match(/^(\$[^$]*\$)/);
      if (dollarMatch) {
        const tag = dollarMatch[1];
        i += tag.length;
        const endIdx = sql.indexOf(tag, i);
        if (endIdx !== -1) {
          i = endIdx + tag.length;
          continue;
        }
      }
    }

    // Statement terminator
    if (char === ";") {
      const stmt = sql.slice(currentStart, i).trim();
      // Only add if it contains non-comment content
      const withoutComments = stmt
        .replace(/--.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .trim();
      if (withoutComments.length > 0) {
        statements.push(stmt);
      }
      currentStart = i + 1;
    }

    i++;
  }

  // Handle final statement without trailing semicolon
  const finalStmt = sql.slice(currentStart).trim();
  const finalWithoutComments = finalStmt
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();
  if (finalWithoutComments.length > 0) {
    statements.push(finalStmt);
  }

  // If expectedCount < 0, caller wants all statements (fallback mode)
  if (expectedCount < 0) {
    return statements;
  }

  // Fallback if parsing doesn't match expected count
  if (statements.length === expectedCount) {
    return statements;
  }

  // If we got more, truncate; if fewer, pad with placeholders
  while (statements.length < expectedCount) {
    statements.push(`Statement ${statements.length + 1}`);
  }

  return statements.slice(0, expectedCount);
}

/**
 * Serialize a row to ensure all values are JSON-safe.
 */
function serializeRow(
  row: Record<string, unknown>,
  columns: string[]
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const col of columns) {
    result[col] = serializeValue(row[col]);
  }

  return result;
}

/**
 * Serialize a single value to be JSON-safe
 */
function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "bigint") {
    if (value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER) {
      return Number(value);
    }
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `<BLOB ${value.length} bytes>`;
  }

  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }

  if (typeof value === "object" && value !== null) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      obj[k] = serializeValue(v);
    }
    return obj;
  }

  return value;
}

// ============================================================================
// SINGLETON
// ============================================================================

let serviceInstance: DuckDBService | null = null;

export function getDuckDBService(): DuckDBService {
  if (!serviceInstance) {
    serviceInstance = new DuckDBService();
  }
  return serviceInstance;
}

export async function disposeDuckDBService(): Promise<void> {
  if (serviceInstance) {
    await serviceInstance.close();
    serviceInstance = null;
  }
}
