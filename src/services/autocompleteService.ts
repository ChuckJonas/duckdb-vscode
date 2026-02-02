/**
 * SQL Autocomplete Service
 *
 * Provides intelligent SQL completion suggestions by:
 * 1. Analyzing SQL context at cursor position (clause type, tables in scope)
 * 2. Using DESCRIBE to get column names for tables/files
 * 3. Providing file path completions for DuckDB's file query syntax
 * 4. Providing context-aware function and keyword completions
 */

import {
  analyzeSQLContext,
  type SQLContext,
  type TableReference,
} from "./sqlContextAnalyzer";

// ============================================================================
// Types
// ============================================================================

export interface AutocompleteSuggestion {
  suggestion: string;
  suggestionStart: number;
  kind:
    | "keyword"
    | "function"
    | "table"
    | "view"
    | "column"
    | "file"
    | "database"
    | "schema";
  detail?: string; // e.g., data type for columns
}

export interface FileInfo {
  name: string;
  isDirectory: boolean;
}

/** Function to list files in a directory */
export type ListFilesFn = (dirPath: string) => Promise<FileInfo[]>;

// Cache for DESCRIBE results to avoid repeated queries
interface ColumnInfo {
  name: string;
  type: string;
}

interface TableColumnsCache {
  columns: ColumnInfo[];
  timestamp: number;
}

const columnCache = new Map<string, TableColumnsCache>();
const CACHE_TTL_MS = 30000; // 30 seconds

// ============================================================================
// Main Autocomplete Function
// ============================================================================

/**
 * Get SQL autocomplete suggestions for the given text and cursor position
 *
 * @param queryFn Function to execute SQL queries
 * @param fullText The complete SQL text
 * @param cursorPosition The cursor position (character offset from start)
 * @param listFiles Optional function to list files in a directory (for file path completions)
 * @returns Array of suggestions with their start positions
 */
export async function getAutocompleteSuggestions(
  queryFn: (sql: string) => Promise<Record<string, unknown>[]>,
  fullText: string,
  cursorPosition: number,
  listFiles?: ListFilesFn,
): Promise<AutocompleteSuggestion[]> {
  // Skip if empty or just whitespace
  if (!fullText.trim()) {
    return [];
  }

  try {
    // Analyze SQL context
    const context = analyzeSQLContext(fullText, cursorPosition);

    // Get suggestions based on context
    const suggestions: AutocompleteSuggestion[] = [];

    // Determine what completions to provide based on clause
    if (needsColumnCompletions(context.clause)) {
      // Get column completions from tables in scope
      const columnSuggestions = await getColumnCompletions(
        queryFn,
        context,
        cursorPosition,
      );
      suggestions.push(...columnSuggestions);
    }

    if (needsTableCompletions(context.clause)) {
      // Get table completions (from information_schema + file paths)
      const tableSuggestions = await getTableCompletions(
        queryFn,
        context,
        cursorPosition,
        listFiles,
      );
      suggestions.push(...tableSuggestions);
    }

    // Include function and keyword completions if not inside a quoted string
    if (!context.quoteContext?.inQuote) {
      const keywordSuggestions = getKeywordCompletions(context, cursorPosition);
      suggestions.push(...keywordSuggestions);
    }

    // Filter by prefix and deduplicate
    return filterAndDedupe(suggestions, context.prefix);
  } catch (error) {
    console.error("🦆 Autocomplete error:", error);
    // Fall back to basic keyword completions
    const prefix = fullText.slice(0, cursorPosition).match(/\w*$/)?.[0] || "";
    return getFallbackCompletions(cursorPosition, prefix);
  }
}

// ============================================================================
// Clause-based Logic
// ============================================================================

/**
 * Clauses where we should suggest columns
 */
function needsColumnCompletions(clause: SQLContext["clause"]): boolean {
  return [
    "select",
    "where",
    "on",
    "group_by",
    "having",
    "order_by",
    "set",
  ].includes(clause);
}

/**
 * Clauses where we should suggest tables
 */
function needsTableCompletions(clause: SQLContext["clause"]): boolean {
  return ["from", "join", "insert_into", "update"].includes(clause);
}

// ============================================================================
// Column Completions (via DESCRIBE)
// ============================================================================

/**
 * Get column completions for tables in scope
 */
async function getColumnCompletions(
  queryFn: (sql: string) => Promise<Record<string, unknown>[]>,
  context: SQLContext,
  cursorPosition: number,
): Promise<AutocompleteSuggestion[]> {
  const suggestions: AutocompleteSuggestion[] = [];

  // If after a dot (e.g., "u."), only show columns for that alias/table
  if (context.isAfterDot && context.dotPrefix) {
    const table = findTableByAliasOrName(context.tables, context.dotPrefix);
    if (table) {
      const columns = await getColumnsForTable(queryFn, table);
      for (const col of columns) {
        suggestions.push({
          suggestion: col.name,
          suggestionStart: cursorPosition - context.prefix.length,
          kind: "column",
          detail: col.type,
        });
      }
    }
    return suggestions;
  }

  // Otherwise, show columns from all tables in scope
  for (const table of context.tables) {
    const columns = await getColumnsForTable(queryFn, table);
    const prefix = table.alias || table.name;

    for (const col of columns) {
      // Add unqualified column name
      suggestions.push({
        suggestion: col.name,
        suggestionStart: cursorPosition - context.prefix.length,
        kind: "column",
        detail: `${col.type} (${prefix})`,
      });

      // Add qualified column name (alias.column or table.column)
      if (context.tables.length > 1) {
        suggestions.push({
          suggestion: `${prefix}.${col.name}`,
          suggestionStart: cursorPosition - context.prefix.length,
          kind: "column",
          detail: col.type,
        });
      }
    }
  }

  // Also add CTE names as possible table references
  for (const cte of context.ctes) {
    suggestions.push({
      suggestion: cte.name,
      suggestionStart: cursorPosition - context.prefix.length,
      kind: "table",
      detail: "CTE",
    });
  }

  return suggestions;
}

/**
 * Find a table reference by alias or name
 */
function findTableByAliasOrName(
  tables: TableReference[],
  identifier: string,
): TableReference | undefined {
  const lower = identifier.toLowerCase();
  return tables.find(
    (t) =>
      t.alias?.toLowerCase() === lower ||
      t.name.toLowerCase() === lower ||
      t.name.split(".").pop()?.toLowerCase() === lower,
  );
}

/**
 * Get columns for a table using DESCRIBE
 */
async function getColumnsForTable(
  queryFn: (sql: string) => Promise<Record<string, unknown>[]>,
  table: TableReference,
): Promise<ColumnInfo[]> {
  // For subqueries, use the subquery text as cache key
  const cacheKey =
    table.type === "subquery" && table.subquery
      ? `subquery:${table.subquery}`
      : table.name;

  // Check cache first
  const cached = columnCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.columns;
  }

  try {
    let rows: Record<string, unknown>[];

    if (table.type === "subquery" && table.subquery) {
      // For subqueries, DESCRIBE the subquery directly
      // This gives us only the columns that were selected, not all source columns
      rows = await queryFn(`DESCRIBE (${table.subquery})`);
    } else if (table.type === "function") {
      // For function calls like read_csv(), we need to use a subquery
      // DESCRIBE (SELECT * FROM read_csv(...) LIMIT 0)
      rows = await queryFn(`DESCRIBE (SELECT * FROM ${table.name} LIMIT 0)`);
    } else {
      // Build DESCRIBE query based on table type
      const describeTarget = buildDescribeTarget(table);
      rows = await queryFn(`DESCRIBE ${describeTarget}`);
    }

    const columns: ColumnInfo[] = rows.map((row) => ({
      name: row.column_name as string,
      type: row.column_type as string,
    }));

    // Cache the result
    columnCache.set(cacheKey, {
      columns,
      timestamp: Date.now(),
    });

    return columns;
  } catch (error) {
    console.error(`🦆 DESCRIBE failed for ${table.name}:`, error);
    return [];
  }
}

/**
 * Build the target for DESCRIBE based on table type
 */
function buildDescribeTarget(table: TableReference): string {
  switch (table.type) {
    case "file":
      // File path needs to be quoted
      return `'${table.name}'`;
    case "function":
      // Function call is used as-is
      return table.name;
    case "table":
    default:
      // Table name - quote if contains special chars
      if (/^[a-zA-Z_]\w*$/.test(table.name)) {
        return table.name;
      }
      // Schema-qualified or special chars
      if (table.name.includes(".")) {
        return table.name; // Already qualified
      }
      return `"${table.name}"`;
  }
}

// ============================================================================
// Table Completions
// ============================================================================

/**
 * Parse a qualified prefix like "db." or "db.schema." into parts
 */
function parseQualifiedPrefix(prefix: string): {
  database?: string;
  schema?: string;
  tablePrefix: string;
  fullQualifier: string;
} {
  const parts = prefix.split(".");

  if (parts.length === 1) {
    // No dot - just a table prefix
    return { tablePrefix: parts[0], fullQualifier: "" };
  } else if (parts.length === 2) {
    // "db." or "schema." - one qualifier
    return {
      database: parts[0],
      tablePrefix: parts[1],
      fullQualifier: parts[0] + ".",
    };
  } else {
    // "db.schema." - two qualifiers
    return {
      database: parts[0],
      schema: parts[1],
      tablePrefix: parts.slice(2).join("."),
      fullQualifier: parts[0] + "." + parts[1] + ".",
    };
  }
}

/**
 * Get table completions from information_schema and file paths
 */
async function getTableCompletions(
  queryFn: (sql: string) => Promise<Record<string, unknown>[]>,
  context: SQLContext,
  cursorPosition: number,
  listFiles?: ListFilesFn,
): Promise<AutocompleteSuggestion[]> {
  const suggestions: AutocompleteSuggestion[] = [];

  // If inside a quoted string, provide file path completions
  if (context.quoteContext?.inQuote && listFiles) {
    const fileSuggestions = await getFilePathCompletions(
      context,
      cursorPosition,
      listFiles,
    );
    suggestions.push(...fileSuggestions);

    // Also include table names (DuckDB allows 'table_name' syntax too)
    try {
      const rows = await queryFn(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY table_name
        LIMIT 50
      `);

      for (const row of rows) {
        const tableName = row.table_name as string;
        // Filter by path prefix
        if (
          !context.quoteContext.pathPrefix ||
          tableName
            .toLowerCase()
            .startsWith(context.quoteContext.pathPrefix.toLowerCase())
        ) {
          suggestions.push({
            suggestion: tableName,
            suggestionStart:
              cursorPosition - context.quoteContext.pathPrefix.length,
            kind: "table",
            detail: "table",
          });
        }
      }
    } catch (error) {
      // Ignore errors for table lookup in quote context
    }

    return suggestions;
  }

  // Parse the prefix to check for qualified names (db.schema.table)
  // Use fullQualifiedPrefix which includes the full "db.schema." part
  const qualified = parseQualifiedPrefix(context.fullQualifiedPrefix);
  const lowerTablePrefix = qualified.tablePrefix.toLowerCase();

  // If we have a qualifier (could be database or schema)
  if (qualified.database) {
    try {
      if (qualified.schema) {
        // db.schema.table - show only tables from specific schema (no more qualifiers)
        const tableRows = await queryFn(`
          SELECT table_name, table_type
          FROM information_schema.tables
          WHERE table_catalog = '${qualified.database}'
            AND table_schema = '${qualified.schema}'
          ORDER BY table_name
          LIMIT 100
        `);

        for (const row of tableRows) {
          const tableName = row.table_name as string;
          const tableType = row.table_type as string;

          if (
            !lowerTablePrefix ||
            tableName.toLowerCase().startsWith(lowerTablePrefix)
          ) {
            suggestions.push({
              suggestion: qualified.fullQualifier + tableName,
              suggestionStart:
                cursorPosition - context.fullQualifiedPrefix.length,
              kind: tableType === "VIEW" ? "view" : "table",
              detail: tableType === "VIEW" ? "view" : "table",
            });
          }
        }
      } else {
        // Single qualifier: could be "database." or "schema." in current database
        // Try BOTH interpretations and merge results

        // 1. Try as database: get schemas and tables from that database
        const dbSchemaRows = await queryFn(`
          SELECT DISTINCT schema_name
          FROM information_schema.schemata
          WHERE catalog_name = '${qualified.database}'
            AND schema_name NOT IN ('pg_catalog', 'information_schema')
          ORDER BY schema_name
          LIMIT 50
        `);

        for (const row of dbSchemaRows) {
          const schemaName = row.schema_name as string;
          // Skip if schema name equals the qualifier (prevents db.db.)
          if (schemaName.toLowerCase() === qualified.database.toLowerCase()) {
            continue;
          }
          if (
            !lowerTablePrefix ||
            schemaName.toLowerCase().startsWith(lowerTablePrefix)
          ) {
            suggestions.push({
              suggestion: qualified.fullQualifier + schemaName + ".",
              suggestionStart:
                cursorPosition - context.fullQualifiedPrefix.length,
              kind: "schema",
              detail: "schema",
            });
          }
        }

        // Get tables from database (treating qualifier as database name)
        const dbTableRows = await queryFn(`
          SELECT table_name, table_type
          FROM information_schema.tables
          WHERE table_catalog = '${qualified.database}'
            AND table_schema NOT IN ('pg_catalog', 'information_schema')
          ORDER BY table_name
          LIMIT 100
        `);

        for (const row of dbTableRows) {
          const tableName = row.table_name as string;
          const tableType = row.table_type as string;

          if (
            !lowerTablePrefix ||
            tableName.toLowerCase().startsWith(lowerTablePrefix)
          ) {
            suggestions.push({
              suggestion: qualified.fullQualifier + tableName,
              suggestionStart:
                cursorPosition - context.fullQualifiedPrefix.length,
              kind: tableType === "VIEW" ? "view" : "table",
              detail: tableType === "VIEW" ? "view" : "table",
            });
          }
        }

        // 2. Also try as schema in current database
        const schemaTableRows = await queryFn(`
          SELECT table_name, table_type
          FROM information_schema.tables
          WHERE table_schema = '${qualified.database}'
            AND table_schema NOT IN ('pg_catalog', 'information_schema')
          ORDER BY table_name
          LIMIT 100
        `);

        for (const row of schemaTableRows) {
          const tableName = row.table_name as string;
          const tableType = row.table_type as string;

          // Avoid duplicates
          const fullSuggestion = qualified.fullQualifier + tableName;
          if (suggestions.some((s) => s.suggestion === fullSuggestion)) {
            continue;
          }

          if (
            !lowerTablePrefix ||
            tableName.toLowerCase().startsWith(lowerTablePrefix)
          ) {
            suggestions.push({
              suggestion: fullSuggestion,
              suggestionStart:
                cursorPosition - context.fullQualifiedPrefix.length,
              kind: tableType === "VIEW" ? "view" : "table",
              detail: tableType === "VIEW" ? "view" : "table",
            });
          }
        }
      }
    } catch (error) {
      console.error("🦆 Failed to get qualified tables:", error);
    }

    return suggestions;
  }

  // No qualifier - show databases, schemas, and tables from current context
  try {
    // Get attached databases
    const dbRows = await queryFn(`
      SELECT database_name
      FROM duckdb_databases()
      WHERE database_name != 'system'
      ORDER BY database_name
    `);

    for (const row of dbRows) {
      const dbName = row.database_name as string;
      if (
        !lowerTablePrefix ||
        dbName.toLowerCase().startsWith(lowerTablePrefix)
      ) {
        suggestions.push({
          suggestion: dbName + ".",
          suggestionStart: cursorPosition - context.prefix.length,
          kind: "database",
          detail: "database",
        });
      }
    }

    // Get schemas in the current database (excluding system schemas)
    const schemaRows = await queryFn(`
      SELECT DISTINCT schema_name
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'main')
      ORDER BY schema_name
      LIMIT 50
    `);

    for (const row of schemaRows) {
      const schemaName = row.schema_name as string;
      if (
        !lowerTablePrefix ||
        schemaName.toLowerCase().startsWith(lowerTablePrefix)
      ) {
        suggestions.push({
          suggestion: schemaName + ".",
          suggestionStart: cursorPosition - context.prefix.length,
          kind: "schema",
          detail: "schema",
        });
      }
    }

    // Get tables from current schema
    const tableRows = await queryFn(`
      SELECT table_name, table_type
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_name
      LIMIT 100
    `);

    for (const row of tableRows) {
      const tableName = row.table_name as string;
      const tableType = row.table_type as string;

      if (
        !lowerTablePrefix ||
        tableName.toLowerCase().startsWith(lowerTablePrefix)
      ) {
        suggestions.push({
          suggestion: tableName,
          suggestionStart: cursorPosition - context.prefix.length,
          kind: tableType === "VIEW" ? "view" : "table",
          detail: tableType === "VIEW" ? "view" : "table",
        });
      }
    }
  } catch (error) {
    console.error("🦆 Failed to get tables:", error);
  }

  // Add file reading functions
  const fileFunctions = [
    { name: "read_csv", detail: "Read CSV file" },
    { name: "read_parquet", detail: "Read Parquet file" },
    { name: "read_json", detail: "Read JSON file" },
  ];

  for (const fn of fileFunctions) {
    if (
      !lowerTablePrefix ||
      fn.name.toLowerCase().startsWith(lowerTablePrefix)
    ) {
      suggestions.push({
        suggestion: fn.name + "('')",
        suggestionStart: cursorPosition - context.prefix.length,
        kind: "function",
        detail: fn.detail,
      });
    }
  }

  return suggestions;
}

/**
 * Get file path completions for inside quoted strings
 */
async function getFilePathCompletions(
  context: SQLContext,
  cursorPosition: number,
  listFiles: ListFilesFn,
): Promise<AutocompleteSuggestion[]> {
  const suggestions: AutocompleteSuggestion[] = [];

  if (!context.quoteContext) return suggestions;

  const pathPrefix = context.quoteContext.pathPrefix;

  // Determine directory to list
  let dirPath = ".";
  let filePrefix = pathPrefix;

  if (pathPrefix.includes("/")) {
    const lastSlash = pathPrefix.lastIndexOf("/");
    dirPath = pathPrefix.slice(0, lastSlash) || "/";
    filePrefix = pathPrefix.slice(lastSlash + 1);
  }

  // Handle special cases
  if (pathPrefix === "") {
    dirPath = ".";
    filePrefix = "";
  } else if (pathPrefix === ".") {
    // User typed just "." - suggest "./"
    suggestions.push({
      suggestion: "./",
      suggestionStart: cursorPosition - pathPrefix.length,
      kind: "file",
      detail: "Current directory",
    });
    return suggestions;
  } else if (pathPrefix === "..") {
    suggestions.push({
      suggestion: "../",
      suggestionStart: cursorPosition - pathPrefix.length,
      kind: "file",
      detail: "Parent directory",
    });
    return suggestions;
  }

  try {
    const files = await listFiles(dirPath);

    // Filter by prefix and create suggestions
    for (const file of files) {
      if (
        filePrefix &&
        !file.name.toLowerCase().startsWith(filePrefix.toLowerCase())
      ) {
        continue;
      }

      // Only suggest data files and directories
      const isDataFile = /\.(csv|parquet|json|jsonl|tsv|txt|gz)$/i.test(
        file.name,
      );

      if (file.isDirectory || isDataFile) {
        const fullPath =
          dirPath === "."
            ? file.name
            : dirPath === "/"
              ? "/" + file.name
              : dirPath + "/" + file.name;

        suggestions.push({
          suggestion: file.isDirectory ? fullPath + "/" : fullPath,
          suggestionStart: cursorPosition - pathPrefix.length,
          kind: "file",
          detail: file.isDirectory ? "directory" : getFileType(file.name),
        });
      }
    }
  } catch (error) {
    console.error("🦆 Failed to list files:", error);
  }

  return suggestions;
}

/**
 * Get file type description from extension
 */
function getFileType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "csv":
      return "CSV file";
    case "parquet":
      return "Parquet file";
    case "json":
      return "JSON file";
    case "jsonl":
      return "JSON Lines file";
    case "tsv":
      return "TSV file";
    case "gz":
      return "Compressed file";
    default:
      return "file";
  }
}

// ============================================================================
// Function and Keyword Completions
// ============================================================================

/** SQL aggregate functions */
const AGGREGATE_FUNCTIONS = [
  { name: "COUNT", detail: "Count rows or non-null values" },
  { name: "SUM", detail: "Sum of values" },
  { name: "AVG", detail: "Average of values" },
  { name: "MIN", detail: "Minimum value" },
  { name: "MAX", detail: "Maximum value" },
  { name: "COUNT_DISTINCT", detail: "Count distinct values" },
  { name: "FIRST", detail: "First value" },
  { name: "LAST", detail: "Last value" },
  { name: "LIST", detail: "Aggregate into list" },
  { name: "STRING_AGG", detail: "Concatenate strings" },
  { name: "GROUP_CONCAT", detail: "Concatenate strings (alias)" },
  { name: "ARRAY_AGG", detail: "Aggregate into array" },
  { name: "MEDIAN", detail: "Median value" },
  { name: "MODE", detail: "Most frequent value" },
  { name: "STDDEV", detail: "Standard deviation" },
  { name: "VARIANCE", detail: "Variance" },
  { name: "COVAR_POP", detail: "Population covariance" },
  { name: "CORR", detail: "Correlation coefficient" },
  { name: "APPROX_COUNT_DISTINCT", detail: "Approximate distinct count" },
  { name: "QUANTILE", detail: "Quantile value" },
  { name: "QUANTILE_CONT", detail: "Continuous quantile" },
  { name: "PERCENTILE_CONT", detail: "Continuous percentile" },
];

/** SQL string functions */
const STRING_FUNCTIONS = [
  { name: "CONCAT", detail: "Concatenate strings" },
  { name: "LENGTH", detail: "String length" },
  { name: "LOWER", detail: "Convert to lowercase" },
  { name: "UPPER", detail: "Convert to uppercase" },
  { name: "TRIM", detail: "Remove whitespace" },
  { name: "LTRIM", detail: "Remove leading whitespace" },
  { name: "RTRIM", detail: "Remove trailing whitespace" },
  { name: "SUBSTRING", detail: "Extract substring" },
  { name: "SUBSTR", detail: "Extract substring (alias)" },
  { name: "REPLACE", detail: "Replace occurrences" },
  { name: "SPLIT_PART", detail: "Split and get part" },
  { name: "REGEXP_EXTRACT", detail: "Extract regex match" },
  { name: "REGEXP_REPLACE", detail: "Replace regex matches" },
  { name: "REGEXP_MATCHES", detail: "Check regex match" },
  { name: "LIKE", detail: "Pattern matching" },
  { name: "ILIKE", detail: "Case-insensitive pattern matching" },
  { name: "CONTAINS", detail: "Check if contains substring" },
  { name: "STARTS_WITH", detail: "Check prefix" },
  { name: "ENDS_WITH", detail: "Check suffix" },
  { name: "LEFT", detail: "Left characters" },
  { name: "RIGHT", detail: "Right characters" },
  { name: "REVERSE", detail: "Reverse string" },
  { name: "REPEAT", detail: "Repeat string" },
  { name: "LPAD", detail: "Left pad" },
  { name: "RPAD", detail: "Right pad" },
  { name: "INSTR", detail: "Find position" },
  { name: "POSITION", detail: "Find position" },
  { name: "STRPOS", detail: "Find position (alias)" },
  { name: "FORMAT", detail: "Format string" },
  { name: "PRINTF", detail: "Printf-style format" },
];

/** SQL date/time functions */
const DATE_FUNCTIONS = [
  { name: "NOW", detail: "Current timestamp" },
  { name: "CURRENT_DATE", detail: "Current date" },
  { name: "CURRENT_TIMESTAMP", detail: "Current timestamp" },
  { name: "TODAY", detail: "Current date (alias)" },
  { name: "DATE_PART", detail: "Extract date part" },
  { name: "EXTRACT", detail: "Extract date component" },
  { name: "DATE_TRUNC", detail: "Truncate to precision" },
  { name: "DATE_DIFF", detail: "Difference between dates" },
  { name: "DATEDIFF", detail: "Difference between dates (alias)" },
  { name: "DATE_ADD", detail: "Add interval to date" },
  { name: "DATE_SUB", detail: "Subtract interval from date" },
  { name: "AGE", detail: "Interval between dates" },
  { name: "YEAR", detail: "Extract year" },
  { name: "MONTH", detail: "Extract month" },
  { name: "DAY", detail: "Extract day" },
  { name: "HOUR", detail: "Extract hour" },
  { name: "MINUTE", detail: "Extract minute" },
  { name: "SECOND", detail: "Extract second" },
  { name: "DAYOFWEEK", detail: "Day of week (1-7)" },
  { name: "DAYOFYEAR", detail: "Day of year" },
  { name: "WEEK", detail: "Week number" },
  { name: "QUARTER", detail: "Quarter (1-4)" },
  { name: "EPOCH", detail: "Unix timestamp" },
  { name: "STRFTIME", detail: "Format timestamp" },
  { name: "STRPTIME", detail: "Parse timestamp" },
  { name: "MAKE_DATE", detail: "Create date" },
  { name: "MAKE_TIMESTAMP", detail: "Create timestamp" },
];

/** SQL numeric/math functions */
const NUMERIC_FUNCTIONS = [
  { name: "ABS", detail: "Absolute value" },
  { name: "ROUND", detail: "Round to precision" },
  { name: "FLOOR", detail: "Round down" },
  { name: "CEIL", detail: "Round up" },
  { name: "CEILING", detail: "Round up (alias)" },
  { name: "TRUNC", detail: "Truncate decimal" },
  { name: "MOD", detail: "Modulo" },
  { name: "POWER", detail: "Raise to power" },
  { name: "POW", detail: "Raise to power (alias)" },
  { name: "SQRT", detail: "Square root" },
  { name: "CBRT", detail: "Cube root" },
  { name: "EXP", detail: "Exponential" },
  { name: "LN", detail: "Natural logarithm" },
  { name: "LOG", detail: "Logarithm" },
  { name: "LOG10", detail: "Base-10 logarithm" },
  { name: "LOG2", detail: "Base-2 logarithm" },
  { name: "SIGN", detail: "Sign of number" },
  { name: "GREATEST", detail: "Maximum of values" },
  { name: "LEAST", detail: "Minimum of values" },
  { name: "RANDOM", detail: "Random number" },
  { name: "SETSEED", detail: "Set random seed" },
  { name: "PI", detail: "Pi constant" },
  { name: "DEGREES", detail: "Radians to degrees" },
  { name: "RADIANS", detail: "Degrees to radians" },
  { name: "SIN", detail: "Sine" },
  { name: "COS", detail: "Cosine" },
  { name: "TAN", detail: "Tangent" },
];

/** SQL conditional/null functions */
const CONDITIONAL_FUNCTIONS = [
  { name: "COALESCE", detail: "First non-null value" },
  { name: "NULLIF", detail: "Return null if equal" },
  { name: "IFNULL", detail: "Replace null with value" },
  { name: "NVL", detail: "Replace null with value (alias)" },
  { name: "IIF", detail: "Inline if-then-else" },
  { name: "IF", detail: "Conditional expression" },
  { name: "CASE", detail: "Case expression" },
  { name: "CAST", detail: "Convert type" },
  { name: "TRY_CAST", detail: "Convert type (returns null on error)" },
  { name: "TYPEOF", detail: "Get type name" },
];

/** SQL list/array functions */
const LIST_FUNCTIONS = [
  { name: "LIST_VALUE", detail: "Create list" },
  { name: "LIST_EXTRACT", detail: "Get element from list" },
  { name: "LIST_ELEMENT", detail: "Get element from list (alias)" },
  { name: "LEN", detail: "List length" },
  { name: "LIST_CONCAT", detail: "Concatenate lists" },
  { name: "LIST_CONTAINS", detail: "Check if list contains" },
  { name: "LIST_POSITION", detail: "Find position in list" },
  { name: "LIST_DISTINCT", detail: "Remove duplicates" },
  { name: "LIST_UNIQUE", detail: "Remove duplicates (alias)" },
  { name: "LIST_SORT", detail: "Sort list" },
  { name: "LIST_REVERSE", detail: "Reverse list" },
  { name: "LIST_SLICE", detail: "Slice list" },
  { name: "UNNEST", detail: "Expand list to rows" },
  { name: "GENERATE_SERIES", detail: "Generate sequence" },
  { name: "RANGE", detail: "Generate range" },
];

/** SQL struct/map functions */
const STRUCT_FUNCTIONS = [
  { name: "STRUCT_PACK", detail: "Create struct" },
  { name: "STRUCT_EXTRACT", detail: "Extract struct field" },
  { name: "ROW", detail: "Create row/struct" },
  { name: "MAP", detail: "Create map" },
  { name: "MAP_KEYS", detail: "Get map keys" },
  { name: "MAP_VALUES", detail: "Get map values" },
  { name: "MAP_EXTRACT", detail: "Get map value by key" },
  { name: "ELEMENT_AT", detail: "Get element at index/key" },
];

/** SQL window functions */
const WINDOW_FUNCTIONS = [
  { name: "ROW_NUMBER", detail: "Sequential row number" },
  { name: "RANK", detail: "Rank with gaps" },
  { name: "DENSE_RANK", detail: "Rank without gaps" },
  { name: "NTILE", detail: "Divide into buckets" },
  { name: "LAG", detail: "Previous row value" },
  { name: "LEAD", detail: "Next row value" },
  { name: "FIRST_VALUE", detail: "First value in window" },
  { name: "LAST_VALUE", detail: "Last value in window" },
  { name: "NTH_VALUE", detail: "Nth value in window" },
  { name: "PERCENT_RANK", detail: "Relative rank" },
  { name: "CUME_DIST", detail: "Cumulative distribution" },
];

/** SQL keywords by context */
const SELECT_KEYWORDS = [
  "DISTINCT",
  "ALL",
  "AS",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "OVER",
  "PARTITION",
  "BY",
  "ROWS",
  "BETWEEN",
  "UNBOUNDED",
  "PRECEDING",
  "FOLLOWING",
  "CURRENT",
  "ROW",
];
const FROM_KEYWORDS = [
  "FROM",
  "JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "OUTER",
  "CROSS",
  "FULL",
  "ON",
  "USING",
  "NATURAL",
  "LATERAL",
];
const WHERE_KEYWORDS = [
  "WHERE",
  "AND",
  "OR",
  "NOT",
  "IN",
  "EXISTS",
  "BETWEEN",
  "LIKE",
  "ILIKE",
  "IS",
  "NULL",
  "TRUE",
  "FALSE",
  "ANY",
  "ALL",
  "SOME",
];
const GROUP_KEYWORDS = [
  "GROUP",
  "BY",
  "HAVING",
  "ROLLUP",
  "CUBE",
  "GROUPING",
  "SETS",
];
const ORDER_KEYWORDS = [
  "ORDER",
  "BY",
  "ASC",
  "DESC",
  "NULLS",
  "FIRST",
  "LAST",
  "LIMIT",
  "OFFSET",
];
const OTHER_KEYWORDS = [
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "WITH",
  "RECURSIVE",
  "AS",
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "CREATE",
  "DROP",
  "ALTER",
  "TABLE",
  "VIEW",
  "INDEX",
];

/**
 * Get function and keyword completions based on SQL context
 */
function getKeywordCompletions(
  context: SQLContext,
  cursorPosition: number,
): AutocompleteSuggestion[] {
  const suggestions: AutocompleteSuggestion[] = [];
  const prefix = context.prefix.toLowerCase();

  // Get appropriate functions based on clause
  const functions: { name: string; detail: string }[] = [];

  if (context.clause === "select" || context.clause === "order_by") {
    // In SELECT clause, suggest all expression functions
    functions.push(
      ...AGGREGATE_FUNCTIONS,
      ...STRING_FUNCTIONS,
      ...DATE_FUNCTIONS,
      ...NUMERIC_FUNCTIONS,
      ...CONDITIONAL_FUNCTIONS,
      ...LIST_FUNCTIONS,
      ...STRUCT_FUNCTIONS,
      ...WINDOW_FUNCTIONS,
    );
  } else if (
    context.clause === "where" ||
    context.clause === "having" ||
    context.clause === "on"
  ) {
    // In WHERE/HAVING, suggest non-aggregate functions
    functions.push(
      ...STRING_FUNCTIONS,
      ...DATE_FUNCTIONS,
      ...NUMERIC_FUNCTIONS,
      ...CONDITIONAL_FUNCTIONS,
      ...LIST_FUNCTIONS,
      ...STRUCT_FUNCTIONS,
    );
  } else if (context.clause === "group_by") {
    // In GROUP BY, suggest expression functions (non-aggregate)
    functions.push(
      ...STRING_FUNCTIONS,
      ...DATE_FUNCTIONS,
      ...NUMERIC_FUNCTIONS,
      ...CONDITIONAL_FUNCTIONS,
    );
  }

  // Add functions to suggestions only when there's at least 1 character prefix
  // This prevents overwhelming the column suggestions with functions
  if (prefix.length >= 1) {
    for (const fn of functions) {
      if (fn.name.toLowerCase().startsWith(prefix)) {
        suggestions.push({
          suggestion: fn.name + "()",
          suggestionStart: cursorPosition - context.prefix.length,
          kind: "function",
          detail: fn.detail,
        });
      }
    }
  }

  // Add keywords to suggestions only when there's at least 1 character prefix
  // This prevents overwhelming the column suggestions with keywords
  if (prefix.length >= 1) {
    let keywords: string[] = [];

    switch (context.clause) {
      case "select":
        keywords = SELECT_KEYWORDS;
        break;
      case "from":
      case "join":
        keywords = FROM_KEYWORDS;
        break;
      case "where":
      case "on":
        keywords = WHERE_KEYWORDS;
        break;
      case "group_by":
      case "having":
        keywords = GROUP_KEYWORDS;
        break;
      case "order_by":
        keywords = ORDER_KEYWORDS;
        break;
      default:
        keywords = OTHER_KEYWORDS;
    }

    for (const kw of keywords) {
      if (kw.toLowerCase().startsWith(prefix)) {
        suggestions.push({
          suggestion: kw,
          suggestionStart: cursorPosition - context.prefix.length,
          kind: "keyword",
        });
      }
    }
  }

  return suggestions;
}

/**
 * Fallback completions when context analysis fails
 */
function getFallbackCompletions(
  cursorPosition: number,
  prefix: string,
): AutocompleteSuggestion[] {
  const suggestions: AutocompleteSuggestion[] = [];
  const lowerPrefix = prefix.toLowerCase();

  // Add common SQL keywords
  for (const kw of OTHER_KEYWORDS) {
    if (!prefix || kw.toLowerCase().startsWith(lowerPrefix)) {
      suggestions.push({
        suggestion: kw,
        suggestionStart: cursorPosition - prefix.length,
        kind: "keyword",
      });
    }
  }

  return suggestions;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Determine the completion kind based on the suggestion
 */
export function inferCompletionKind(
  suggestion: string,
): "keyword" | "function" | "table" | "column" | "file" {
  // All uppercase with only letters/underscores = keyword
  if (suggestion === suggestion.toUpperCase() && /^[A-Z_]+$/.test(suggestion)) {
    return "keyword";
  }
  // Contains parenthesis = function
  if (suggestion.includes("(")) {
    return "function";
  }
  // Default to column (tables are explicitly tagged)
  return "column";
}

/**
 * Filter suggestions by prefix and remove duplicates
 */
function filterAndDedupe(
  suggestions: AutocompleteSuggestion[],
  prefix: string,
): AutocompleteSuggestion[] {
  const seen = new Set<string>();
  const filtered: AutocompleteSuggestion[] = [];

  const lowerPrefix = prefix.toLowerCase();

  for (const s of suggestions) {
    // Filter by prefix (case-insensitive)
    if (lowerPrefix && !s.suggestion.toLowerCase().startsWith(lowerPrefix)) {
      continue;
    }

    // Deduplicate
    const key = s.suggestion.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    filtered.push(s);
  }

  // Sort: exact prefix matches first, then alphabetically
  filtered.sort((a, b) => {
    const aExact = a.suggestion.toLowerCase().startsWith(lowerPrefix);
    const bExact = b.suggestion.toLowerCase().startsWith(lowerPrefix);
    if (aExact && !bExact) return -1;
    if (!aExact && bExact) return 1;
    return a.suggestion.localeCompare(b.suggestion);
  });

  return filtered;
}

/**
 * Clear the column cache (useful when schema changes)
 */
export function clearColumnCache(): void {
  columnCache.clear();
}

// ============================================================================
// Legacy API (for backward compatibility during transition)
// ============================================================================

/**
 * @deprecated Use getAutocompleteSuggestions with full text and cursor position
 */
export async function getAutocompleteSuggestionsLegacy(
  queryFn: (sql: string) => Promise<Record<string, unknown>[]>,
  textUntilCursor: string,
): Promise<{ suggestion: string; suggestionStart: number }[]> {
  const suggestions = await getAutocompleteSuggestions(
    queryFn,
    textUntilCursor,
    textUntilCursor.length,
  );

  return suggestions.map((s) => ({
    suggestion: s.suggestion,
    suggestionStart: s.suggestionStart,
  }));
}
