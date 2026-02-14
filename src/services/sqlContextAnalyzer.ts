/**
 * SQL Context Analyzer for Autocomplete
 *
 * Analyzes SQL at a given cursor position to determine:
 * - Which clause the cursor is in (SELECT, FROM, WHERE, etc.)
 * - What tables/files are in scope
 * - What CTEs are defined
 * - What prefix the user has typed (for filtering completions)
 *
 * This enables intelligent autocomplete that works with cursor positions
 * in the middle of SQL statements, not just at the end.
 */

// ============================================================================
// Types
// ============================================================================

export interface TableReference {
  /** Table name, file path, function call, or subquery text */
  name: string;
  /** Optional alias (e.g., "u" for "users u") */
  alias?: string;
  /** Type of reference */
  type: "table" | "file" | "function" | "subquery";
  /** For subqueries, the full SELECT statement to use with DESCRIBE */
  subquery?: string;
}

export interface CTEReference {
  /** CTE name from WITH clause */
  name: string;
}

export type ClauseType =
  | "select" // SELECT ... (before FROM) - suggest columns
  | "from" // FROM ... - suggest tables/files
  | "join" // JOIN ... - suggest tables/files
  | "on" // ON ... - suggest columns
  | "where" // WHERE ... - suggest columns
  | "group_by" // GROUP BY ... - suggest columns
  | "having" // HAVING ... - suggest columns
  | "order_by" // ORDER BY ... - suggest columns
  | "insert_into" // INSERT INTO - suggest tables
  | "update" // UPDATE - suggest tables
  | "set" // SET ... - suggest columns
  | "unknown"; // Unknown context

export interface SQLContext {
  /** Which SQL clause the cursor is in */
  clause: ClauseType;
  /** Tables/files referenced in FROM/JOIN clauses */
  tables: TableReference[];
  /** CTEs defined in WITH clause */
  ctes: CTEReference[];
  /** Partial word at cursor position (for filtering completions) */
  prefix: string;
  /** True if cursor is immediately after a dot (e.g., "u.|") */
  isAfterDot: boolean;
  /** The identifier before the dot (e.g., "u" in "u.name") */
  dotPrefix?: string;
  /** Full qualified prefix including dots, with quotes stripped (e.g., "db.schema." or "db.schema.tab") */
  fullQualifiedPrefix: string;
  /** Raw character length of qualified prefix including any double quotes (for replacement positioning) */
  rawQualifiedPrefixLength: number;
  /** Quote context for completions inside quoted strings */
  quoteContext?: {
    /** True if cursor is inside a quoted string */
    inQuote: boolean;
    /** The quote character (' for file paths, " for identifiers) */
    quoteChar: "'" | '"';
    /** Position where the quote started */
    quoteStart: number;
    /** The text typed so far inside the quote */
    pathPrefix: string;
  };
}

// ============================================================================
// Helper: Parse cursor position from test strings
// ============================================================================

/**
 * Helper for tests: parse SQL with | marking cursor position
 */
export function parseCursorPosition(sqlWithCursor: string): {
  sql: string;
  cursor: number;
} {
  const cursor = sqlWithCursor.indexOf("|");
  if (cursor === -1) {
    throw new Error("Test SQL must contain | to mark cursor position");
  }
  const sql = sqlWithCursor.slice(0, cursor) + sqlWithCursor.slice(cursor + 1);
  return { sql, cursor };
}

// ============================================================================
// Main Analysis Function
// ============================================================================

/**
 * Analyze SQL context at a given cursor position.
 *
 * @param sql The complete SQL string
 * @param cursorPosition The 0-based character index of the cursor
 * @returns SQLContext with clause type, tables in scope, and prefix
 */
export function analyzeSQLContext(
  sql: string,
  cursorPosition: number
): SQLContext {
  // Default empty context
  const defaultContext: SQLContext = {
    clause: "unknown",
    tables: [],
    ctes: [],
    prefix: "",
    isAfterDot: false,
    fullQualifiedPrefix: "",
    rawQualifiedPrefixLength: 0,
  };

  if (!sql || sql.trim().length === 0) {
    return defaultContext;
  }

  // Step 1: Find the top-level statement containing the cursor (for CTE extraction)
  const fullStatement = findTopLevelStatement(sql, cursorPosition);

  // Step 2: Extract CTEs from the full statement (before narrowing to inner query)
  const ctes = extractCTEs(fullStatement.text);

  // Step 3: Find the innermost query for context analysis
  const statement = findCurrentStatement(sql, cursorPosition);
  const localCursor = cursorPosition - statement.start;

  // Step 4: Extract prefix (partial word at cursor)
  const {
    prefix,
    isAfterDot,
    dotPrefix,
    fullQualifiedPrefix,
    rawQualifiedPrefixLength,
  } = extractPrefix(statement.text, localCursor);

  // Step 5: Detect which clause we're in
  const clause = detectClause(statement.text, localCursor);

  // Step 6: Extract tables from FROM/JOIN clauses (from innermost query)
  const tables = extractTables(statement.text, localCursor, ctes);

  // Step 7: Detect quote context (for file path completions)
  const quoteContext = detectQuoteContext(statement.text, localCursor);

  return {
    clause,
    tables,
    ctes,
    prefix,
    isAfterDot,
    dotPrefix,
    fullQualifiedPrefix,
    rawQualifiedPrefixLength,
    quoteContext,
  };
}

/**
 * Detect if cursor is inside a quoted string.
 *
 * - Single quotes (') → file path / string literal context
 * - Double quotes (") → SQL identifier context (table/column names)
 *
 * The completion service uses quoteChar to determine what kind of
 * completions to provide.
 */
function detectQuoteContext(
  statement: string,
  cursor: number
): SQLContext["quoteContext"] {
  const beforeCursor = statement.slice(0, cursor);

  let inSingleQuote = false;
  let inDoubleQuote = false;
  let quoteStart = -1;

  for (let i = 0; i < beforeCursor.length; i++) {
    const char = beforeCursor[i];
    const prevChar = i > 0 ? beforeCursor[i - 1] : "";

    // Skip escaped quotes
    if (prevChar === "\\") continue;

    // Handle doubled quotes (SQL escape)
    if (char === "'" && !inDoubleQuote) {
      if (inSingleQuote && beforeCursor[i + 1] === "'") {
        i++; // Skip escaped quote
        continue;
      }
      inSingleQuote = !inSingleQuote;
      if (inSingleQuote) quoteStart = i;
    } else if (char === '"' && !inSingleQuote) {
      if (inDoubleQuote && beforeCursor[i + 1] === '"') {
        i++; // Skip escaped quote
        continue;
      }
      inDoubleQuote = !inDoubleQuote;
      if (inDoubleQuote) quoteStart = i;
    }
  }

  if (!inSingleQuote && !inDoubleQuote) {
    return undefined;
  }

  const quoteChar = inSingleQuote ? ("'" as const) : ('"' as const);
  const pathPrefix = beforeCursor.slice(quoteStart + 1);

  return {
    inQuote: true,
    quoteChar,
    quoteStart,
    pathPrefix,
  };
}

// ============================================================================
// Statement Finder
// ============================================================================

interface StatementBounds {
  text: string;
  start: number;
  end: number;
}

/**
 * Find the top-level SQL statement containing the cursor position.
 * Does NOT narrow down to inner subqueries - used for CTE extraction.
 */
function findTopLevelStatement(
  sql: string,
  cursorPosition: number
): StatementBounds {
  const statements: StatementBounds[] = [];
  let start = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const nextChar = sql[i + 1];

    // Handle comment state
    if (!inSingleQuote && !inDoubleQuote) {
      if (!inBlockComment && char === "-" && nextChar === "-") {
        inLineComment = true;
        i++;
        continue;
      }
      if (inLineComment && char === "\n") {
        inLineComment = false;
        continue;
      }
      if (!inLineComment && char === "/" && nextChar === "*") {
        inBlockComment = true;
        i++;
        continue;
      }
      if (inBlockComment && char === "*" && nextChar === "/") {
        inBlockComment = false;
        i++;
        continue;
      }
    }

    if (inLineComment || inBlockComment) continue;

    // Handle quote state
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    }

    // Statement separator
    if (char === ";" && !inSingleQuote && !inDoubleQuote) {
      statements.push({
        text: sql.slice(start, i),
        start,
        end: i,
      });
      start = i + 1;
    }
  }

  // Add final statement
  if (start < sql.length) {
    statements.push({
      text: sql.slice(start),
      start,
      end: sql.length,
    });
  }

  // Find statement containing cursor
  for (const stmt of statements) {
    if (cursorPosition >= stmt.start && cursorPosition <= stmt.end) {
      return stmt;
    }
  }

  return { text: sql, start: 0, end: sql.length };
}

/**
 * Find the SQL statement containing the cursor position.
 * Handles multiple statements separated by semicolons.
 * For nested queries, finds the innermost SELECT containing the cursor.
 */
function findCurrentStatement(
  sql: string,
  cursorPosition: number
): StatementBounds {
  // Simple approach: split by semicolons (respecting quotes)
  // Then find which statement contains the cursor

  const statements: StatementBounds[] = [];
  let start = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const nextChar = sql[i + 1];

    // Handle comment state
    if (!inSingleQuote && !inDoubleQuote) {
      if (!inBlockComment && char === "-" && nextChar === "-") {
        inLineComment = true;
        i++; // skip next char
        continue;
      }
      if (inLineComment && char === "\n") {
        inLineComment = false;
        continue;
      }
      if (!inLineComment && char === "/" && nextChar === "*") {
        inBlockComment = true;
        i++;
        continue;
      }
      if (inBlockComment && char === "*" && nextChar === "/") {
        inBlockComment = false;
        i++;
        continue;
      }
    }

    if (inLineComment || inBlockComment) continue;

    // Handle quote state
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    }

    // Statement separator
    if (char === ";" && !inSingleQuote && !inDoubleQuote) {
      statements.push({
        text: sql.slice(start, i),
        start,
        end: i,
      });
      start = i + 1;
    }
  }

  // Add final statement (may not have semicolon)
  if (start < sql.length) {
    statements.push({
      text: sql.slice(start),
      start,
      end: sql.length,
    });
  }

  // Find statement containing cursor
  for (const stmt of statements) {
    if (cursorPosition >= stmt.start && cursorPosition <= stmt.end) {
      // Now find innermost SELECT for nested queries
      return findInnermostQuery(
        stmt.text,
        cursorPosition - stmt.start,
        stmt.start
      );
    }
  }

  // Fallback: return full SQL
  return { text: sql, start: 0, end: sql.length };
}

/**
 * Find the innermost query (for nested subqueries)
 */
function findInnermostQuery(
  statement: string,
  localCursor: number,
  globalOffset: number
): StatementBounds {
  // Track parenthesis depth and SELECT positions
  let depth = 0;
  let bestMatch: StatementBounds = {
    text: statement,
    start: globalOffset,
    end: globalOffset + statement.length,
  };
  let bestDepth = -1;

  // Stack of SELECT positions at each depth
  const selectStack: number[] = [];

  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < statement.length; i++) {
    const char = statement[i];

    // Handle quotes
    if (char === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote;
    if (char === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
    if (inSingleQuote || inDoubleQuote) continue;

    // Track parentheses
    if (char === "(") {
      depth++;
      selectStack.push(-1); // placeholder
    } else if (char === ")") {
      selectStack.pop();
      depth--;
    }

    // Look for SELECT keyword
    const upper = statement.slice(i, i + 6).toUpperCase();
    if (upper === "SELECT" && (i === 0 || /\s|\(/.test(statement[i - 1]))) {
      if (selectStack.length > 0) {
        selectStack[selectStack.length - 1] = i;
      }

      // Check if cursor is within this SELECT's scope
      if (i <= localCursor && depth > bestDepth) {
        // Find the end of this SELECT (closing paren or end of statement)
        const endPos = findSelectEnd(statement, i);
        if (localCursor <= endPos) {
          bestDepth = depth;
          bestMatch = {
            text: statement.slice(i, endPos),
            start: globalOffset + i,
            end: globalOffset + endPos,
          };
        }
      }
    }
  }

  return bestMatch;
}

/**
 * Find the end of a SELECT statement (closing paren or statement end)
 */
function findSelectEnd(statement: string, selectStart: number): number {
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let foundFrom = false;

  for (let i = selectStart; i < statement.length; i++) {
    const char = statement[i];

    if (char === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote;
    if (char === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
    if (inSingleQuote || inDoubleQuote) continue;

    if (char === "(") depth++;
    if (char === ")") {
      if (depth === 0) return i; // End of subquery
      depth--;
    }

    // Check for UNION/INTERSECT/EXCEPT at depth 0
    const remaining = statement.slice(i).toUpperCase();
    if (
      depth === 0 &&
      (remaining.startsWith("UNION") ||
        remaining.startsWith("INTERSECT") ||
        remaining.startsWith("EXCEPT"))
    ) {
      return i;
    }
  }

  return statement.length;
}

// ============================================================================
// Prefix Extraction
// ============================================================================

interface PrefixInfo {
  prefix: string;
  isAfterDot: boolean;
  dotPrefix?: string;
  /** Full qualified prefix including dots, with quotes stripped (e.g., "db.schema." or "db.schema.tab") */
  fullQualifiedPrefix: string;
  /** Raw character length of the qualified prefix including any double quotes (for replacement positioning) */
  rawQualifiedPrefixLength: number;
}

/**
 * Strip single and double quotes from a SQL identifier
 */
function stripQuotes(identifier: string): string {
  return identifier.replace(/["']/g, "");
}

/**
 * Extract the partial word at cursor position.
 * Handles both unquoted and double-quoted SQL identifiers.
 */
function extractPrefix(statement: string, cursor: number): PrefixInfo {
  const beforeCursor = statement.slice(0, cursor);

  // Match qualified identifiers with optional single or double quotes:
  // "db"."schema".table, 'schema'.'table', db."table", db.schema.table, etc.
  // Each qualifier part can be "double-quoted", 'single-quoted', or unquoted
  const qualifiedMatch = beforeCursor.match(
    /((?:(?:"[^"]*"|'[^']*'|\w+)\.)+)(\w*)$/
  );
  if (qualifiedMatch) {
    const rawQualifiers = qualifiedMatch[1]; // e.g., '"db".' or "'cms'." or 'db.schema.'
    const partial = qualifiedMatch[2] || "";
    const rawLength = qualifiedMatch[0].length;
    // Strip quotes for lookup purposes
    const cleanQualifiers = stripQuotes(rawQualifiers);
    return {
      prefix: partial,
      isAfterDot: true,
      dotPrefix: cleanQualifiers.slice(0, -1), // Remove trailing dot
      fullQualifiedPrefix: cleanQualifiers + partial,
      rawQualifiedPrefixLength: rawLength,
    };
  }

  // Check for single level: word (or quoted identifier) followed by dot
  const dotMatch = beforeCursor.match(
    /(?:"([^"]*)"|'([^']*)'|(\w+))\.\s*(\w*)$/
  );
  if (dotMatch) {
    const identifier = dotMatch[1] || dotMatch[2] || dotMatch[3]; // quoted content or unquoted word
    const partial = dotMatch[4] || "";
    const rawLength = dotMatch[0].length;
    return {
      prefix: partial,
      isAfterDot: true,
      dotPrefix: identifier,
      fullQualifiedPrefix: identifier + "." + partial,
      rawQualifiedPrefixLength: rawLength,
    };
  }

  // Extract word prefix (alphanumeric + underscore)
  const wordMatch = beforeCursor.match(/(\w+)$/);
  const prefix = wordMatch ? wordMatch[1] : "";
  return {
    prefix,
    isAfterDot: false,
    fullQualifiedPrefix: prefix,
    rawQualifiedPrefixLength: prefix.length,
  };
}

// ============================================================================
// Clause Detection
// ============================================================================

/**
 * Detect which SQL clause the cursor is in
 */
function detectClause(statement: string, cursor: number): ClauseType {
  const beforeCursor = statement.slice(0, cursor).toUpperCase();

  // Work backwards to find the most recent clause keyword
  // Order matters: more specific patterns first

  // INSERT INTO
  if (/INSERT\s+INTO\s+\S*$/i.test(beforeCursor)) {
    return "insert_into";
  }

  // UPDATE ... SET
  if (/UPDATE\s+\S+\s+SET\s+/i.test(beforeCursor)) {
    return "set";
  }

  // UPDATE (before SET)
  if (/UPDATE\s+\S*$/i.test(beforeCursor)) {
    return "update";
  }

  // ORDER BY
  if (
    /ORDER\s+BY\s+/i.test(beforeCursor) &&
    !hasClauseAfter(beforeCursor, "ORDER BY")
  ) {
    return "order_by";
  }

  // GROUP BY
  if (
    /GROUP\s+BY\s+/i.test(beforeCursor) &&
    !hasClauseAfter(beforeCursor, "GROUP BY")
  ) {
    return "group_by";
  }

  // HAVING
  if (
    /HAVING\s+/i.test(beforeCursor) &&
    !hasClauseAfter(beforeCursor, "HAVING")
  ) {
    return "having";
  }

  // WHERE
  if (
    /WHERE\s+/i.test(beforeCursor) &&
    !hasClauseAfter(beforeCursor, "WHERE")
  ) {
    return "where";
  }

  // ON (in JOIN)
  if (/\bON\s+/i.test(beforeCursor) && !hasClauseAfter(beforeCursor, "ON")) {
    return "on";
  }

  // JOIN (any type)
  if (
    /(?:LEFT|RIGHT|INNER|OUTER|CROSS|FULL)?\s*JOIN\s+\S*$/i.test(beforeCursor)
  ) {
    return "join";
  }

  // FROM
  if (/FROM\s+/i.test(beforeCursor) && !hasClauseAfter(beforeCursor, "FROM")) {
    return "from";
  }

  // SELECT (before FROM or at start) - also match "SELECT" without trailing space
  if (/SELECT(\s+|$)/i.test(beforeCursor)) {
    return "select";
  }

  return "unknown";
}

/**
 * Check if there's another clause after the given one
 */
function hasClauseAfter(text: string, clause: string): boolean {
  const clausePatterns: Record<string, RegExp> = {
    SELECT: /\bFROM\b/i,
    FROM: /\b(WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|FULL|GROUP|ORDER|HAVING|LIMIT|UNION|INTERSECT|EXCEPT)\b/i,
    WHERE: /\b(GROUP|ORDER|HAVING|LIMIT|UNION|INTERSECT|EXCEPT)\b/i,
    "GROUP BY": /\b(HAVING|ORDER|LIMIT|UNION|INTERSECT|EXCEPT)\b/i,
    HAVING: /\b(ORDER|LIMIT|UNION|INTERSECT|EXCEPT)\b/i,
    "ORDER BY": /\b(LIMIT|UNION|INTERSECT|EXCEPT)\b/i,
    ON: /\b(WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|FULL|GROUP|ORDER|HAVING|LIMIT|UNION|INTERSECT|EXCEPT)\b/i,
  };

  const pattern = clausePatterns[clause];
  if (!pattern) return false;

  // Find position of the clause
  const clausePos = text.toUpperCase().lastIndexOf(clause.toUpperCase());
  if (clausePos === -1) return false;

  // Check if any following clause exists after it
  const afterClause = text.slice(clausePos + clause.length);
  return pattern.test(afterClause);
}

// ============================================================================
// CTE Extraction
// ============================================================================

/**
 * Extract CTE names from WITH clause
 */
function extractCTEs(statement: string): CTEReference[] {
  const ctes: CTEReference[] = [];

  // Match WITH clause (handles RECURSIVE)
  const withMatch = statement.match(/^\s*WITH\s+(?:RECURSIVE\s+)?/i);
  if (!withMatch) return ctes;

  // Find the main SELECT (where WITH clause ends)
  const mainSelectPos = findMainSelectAfterWith(statement);
  if (mainSelectPos === -1) return ctes;

  const withClause = statement.slice(withMatch[0].length, mainSelectPos);

  // Extract CTE names: "name AS (" pattern
  // Handle multiple CTEs separated by commas
  const ctePattern = /(\w+)\s+AS\s*\(/gi;
  let match;
  while ((match = ctePattern.exec(withClause)) !== null) {
    ctes.push({ name: match[1] });
  }

  return ctes;
}

/**
 * Find the position of the main SELECT after WITH clause
 */
function findMainSelectAfterWith(statement: string): number {
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  // Skip "WITH" keyword
  const withMatch = statement.match(/^\s*WITH\s+(?:RECURSIVE\s+)?/i);
  if (!withMatch) return -1;

  let i = withMatch[0].length;

  for (; i < statement.length; i++) {
    const char = statement[i];

    if (char === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote;
    if (char === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
    if (inSingleQuote || inDoubleQuote) continue;

    if (char === "(") depth++;
    if (char === ")") depth--;

    // Look for SELECT at depth 0 (main query)
    if (depth === 0) {
      const remaining = statement.slice(i).toUpperCase();
      if (remaining.match(/^\s*SELECT\b/)) {
        return i;
      }
    }
  }

  return -1;
}

// ============================================================================
// Table Extraction
// ============================================================================

/**
 * Extract table references from FROM, JOIN, and UPDATE clauses
 */
function extractTables(
  statement: string,
  cursor: number,
  ctes: CTEReference[]
): TableReference[] {
  const tables: TableReference[] = [];
  const cteNames = new Set(ctes.map((c) => c.name.toLowerCase()));

  // First, extract subqueries and get their positions (to exclude from later patterns)
  const subqueryResult = extractSubqueries(statement);
  tables.push(...subqueryResult.subqueries);

  // Create a "masked" statement where subquery content is replaced with spaces
  // This prevents us from matching tables inside subqueries
  const maskedStatement = maskSubqueries(statement, subqueryResult.positions);

  // Pattern for FROM/JOIN sources
  // Handles: table_name, 'file.csv', "quoted table", read_csv(...), schema.table
  // Note: Need to handle quoted strings and function calls specially

  // First: match any two-part qualified name (any combo of quoted/unquoted parts)
  // FROM schema.table, FROM 'schema'.'table', FROM schema.'table', FROM 'schema'.table, etc.
  const qualifiedPattern =
    /(?:FROM|JOIN)\s+(?:(['"])([^'"]+)\1|([a-zA-Z_]\w*))\s*\.\s*(?:(['"])([^'"]+)\4|([a-zA-Z_]\w*))\s*(?:AS\s+)?(\w+)?/gi;

  const singlePatterns = [
    // FROM/JOIN with quoted string: FROM 'file.csv' or FROM "My Table"
    /(?:FROM|JOIN)\s+(['"])([^'"]+)\1\s*(?:AS\s+)?(\w+)?/gi,
    // FROM/JOIN with function call: FROM read_csv('...')
    /(?:FROM|JOIN)\s+(\w+\s*\([^)]*\))\s*(?:AS\s+)?(\w+)?/gi,
    // FROM/JOIN with regular table name: FROM users
    /(?:FROM|JOIN)\s+([a-zA-Z_][\w.]*)\s*(?:AS\s+)?(\w+)?/gi,
    // UPDATE table_name
    /UPDATE\s+([a-zA-Z_][\w.]*)/gi,
  ];

  // Match qualified names where at least one part is quoted
  // (e.g., 'schema'.'table', schema."table", 'schema'.table)
  // Fully unquoted names like schema.table are handled by the regular table pattern below
  let match;
  while ((match = qualifiedPattern.exec(maskedStatement)) !== null) {
    // Only use this pattern when at least one part is quoted
    // match[1] = first part quote char, match[4] = second part quote char
    if (!match[1] && !match[4]) continue;
    const schemaName = match[2] || match[3];
    const tableName = match[5] || match[6];
    const alias = match[7];
    const fullName = `${schemaName}.${tableName}`;
    tables.push({ name: fullName, alias, type: "table" });
  }

  // Match single quoted strings (files or quoted table names) on masked statement
  const quotedPattern = singlePatterns[0];
  while ((match = quotedPattern.exec(maskedStatement)) !== null) {
    const name = match[2];
    const alias = match[3];
    // Skip if we already matched this as part of a qualified quoted name
    if (tables.some((t) => t.name.includes(name))) continue;
    const type =
      name.includes("/") || name.includes("s3://") || name.match(/\.\w{2,4}$/)
        ? "file"
        : "table";
    tables.push({ name, alias, type });
  }

  // Match function calls on masked statement (but not if it's a subquery we already captured)
  const funcPattern = singlePatterns[1];
  while ((match = funcPattern.exec(maskedStatement)) !== null) {
    const funcCall = match[1];
    const alias = match[2];
    // Skip if this looks like it might be part of a subquery alias
    if (tables.some((t) => t.alias === alias && t.type === "subquery"))
      continue;
    tables.push({ name: funcCall, alias, type: "function" });
  }

  // Match regular table names on masked statement (skip if already matched as quoted/function/subquery)
  const tablePattern = singlePatterns[2];
  while ((match = tablePattern.exec(maskedStatement)) !== null) {
    const name = match[1];
    const alias = match[2];
    // Skip if this is a function call (starts with read_, etc.)
    if (/^read_|^parquet_|^csv_|^json_/i.test(name)) continue;
    // Skip if we already have this table or it's a subquery alias
    if (tables.some((t) => t.name === name || t.alias === name)) continue;
    // Skip if this name (possibly with trailing dot) is a prefix of an already-matched
    // qualified name (e.g., 'my_database.' when we already have 'my_database.categories')
    const cleanName = name.replace(/\.$/, "");
    if (
      tables.some(
        (t) => t.name.startsWith(cleanName + ".") || t.name === cleanName
      )
    )
      continue;

    const tableRef: TableReference = { name, type: "table" };
    if (alias) tableRef.alias = alias;

    // Check if this is a CTE reference
    if (cteNames.has(name.toLowerCase())) {
      tableRef.type = "table";
    }

    tables.push(tableRef);
  }

  // Match UPDATE table on masked statement
  const updatePattern = singlePatterns[3];
  while ((match = updatePattern.exec(maskedStatement)) !== null) {
    const name = match[1];
    if (!tables.some((t) => t.name === name)) {
      tables.push({ name, type: "table" });
    }
  }

  return tables;
}

/**
 * Replace subquery content with spaces to prevent matching tables inside them
 */
function maskSubqueries(
  statement: string,
  positions: { start: number; end: number }[]
): string {
  let result = statement;
  // Process in reverse order to preserve positions
  for (let i = positions.length - 1; i >= 0; i--) {
    const { start, end } = positions[i];
    const length = end - start + 1;
    result =
      result.slice(0, start) + " ".repeat(length) + result.slice(end + 1);
  }
  return result;
}

interface SubqueryResult {
  subqueries: TableReference[];
  positions: { start: number; end: number }[];
}

/**
 * Extract subqueries from FROM/JOIN clauses
 * e.g., FROM (SELECT id, amount FROM orders) sub
 */
function extractSubqueries(statement: string): SubqueryResult {
  const subqueries: TableReference[] = [];
  const positions: { start: number; end: number }[] = [];

  // Find FROM ( or JOIN ( patterns
  const pattern = /(?:FROM|JOIN)\s*\(/gi;
  let match;

  while ((match = pattern.exec(statement)) !== null) {
    const startPos = match.index + match[0].length - 1; // Position of opening (

    // Find the matching closing parenthesis
    const subqueryEnd = findMatchingParen(statement, startPos);
    if (subqueryEnd === -1) continue;

    // Extract the subquery (without outer parens)
    const subqueryText = statement.slice(startPos + 1, subqueryEnd).trim();

    // Only treat as subquery if it starts with SELECT
    if (!/^\s*SELECT\b/i.test(subqueryText)) continue;

    // Record the position of the subquery content (for masking)
    positions.push({ start: startPos + 1, end: subqueryEnd - 1 });

    // Look for alias after the closing paren
    const afterParen = statement.slice(subqueryEnd + 1);
    const aliasMatch = afterParen.match(/^\s*(?:AS\s+)?(\w+)/i);
    const alias = aliasMatch ? aliasMatch[1] : undefined;

    subqueries.push({
      name: alias || `subquery_${subqueries.length}`,
      alias,
      type: "subquery",
      subquery: subqueryText,
    });
  }

  return { subqueries, positions };
}

/**
 * Find the position of the matching closing parenthesis
 */
function findMatchingParen(text: string, openPos: number): number {
  let depth = 1;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = openPos + 1; i < text.length; i++) {
    const char = text[i];

    // Handle quotes
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    }

    if (inSingleQuote || inDoubleQuote) continue;

    if (char === "(") depth++;
    if (char === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

/**
 * Parse a table reference string into structured form
 */
function parseTableReference(raw: string): TableReference {
  // File path (quoted string)
  if (/^['"]/.test(raw)) {
    const path = raw.slice(1, -1); // Remove quotes
    return { name: path, type: "file" };
  }

  // Function call (read_csv, read_parquet, etc.)
  if (/^\w+\s*\(/.test(raw)) {
    return { name: raw, type: "function" };
  }

  // Regular table (possibly schema-qualified)
  // Handle quoted identifiers: "My Table"
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return { name: raw.slice(1, -1), type: "table" };
  }

  return { name: raw, type: "table" };
}

// ============================================================================
// Exports for testing
// ============================================================================

export {
  findCurrentStatement,
  extractPrefix,
  detectClause,
  extractCTEs,
  extractTables,
};
