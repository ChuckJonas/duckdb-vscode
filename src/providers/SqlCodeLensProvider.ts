/**
 * SQL CodeLens Provider
 * Injects "Run All" and "Run Statement" actions directly into SQL files
 */
import * as vscode from "vscode";

// Callback to get current database - set by extension.ts
let getCurrentDatabase: () => string = () => "memory";

export function setGetCurrentDatabase(fn: () => string): void {
  getCurrentDatabase = fn;
}

/**
 * Represents a parsed SQL statement with position information
 */
export interface ParsedStatement {
  sql: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
}

/**
 * CodeLens provider for SQL files
 * Adds clickable "Run" actions above SQL statements
 */
export class SqlCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  /**
   * Refresh CodeLenses when document changes
   */
  refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const text = document.getText();
    const statements = parseSqlStatements(text);
    const lenses: vscode.CodeLens[] = [];

    // Always add actions at the top if there's any SQL
    if (statements.length > 0) {
      const topRange = new vscode.Range(0, 0, 0, 0);

      // Database selector (leftmost)
      const dbName = getCurrentDatabase();
      const displayName = dbName === "memory" ? ":memory:" : dbName;
      lenses.push(
        new vscode.CodeLens(topRange, {
          title: `$(database) ${displayName}`,
          command: "duckdb.selectDatabase",
          tooltip: "Click to switch database",
        })
      );

      // Run All button
      lenses.push(
        new vscode.CodeLens(topRange, {
          title: "$(play) Run All",
          command: "duckdb.executeQuery",
          tooltip: "Execute all SQL statements in this file",
        })
      );
    }

    // Add "Run Statement" above each statement (if more than one)
    if (statements.length > 1) {
      for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i];
        const range = new vscode.Range(stmt.startLine, 0, stmt.startLine, 0);

        // Preview of the statement (first line, truncated)
        const preview = getStatementPreview(stmt.sql);

        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(play) Run Statement`,
            command: "duckdb.runStatement",
            arguments: [document.uri, stmt.startOffset, stmt.endOffset],
            tooltip: `Execute: ${preview}`,
          })
        );
      }
    }

    return lenses;
  }
}

/**
 * Parse SQL text into individual statements with position info
 * Handles:
 * - Semicolon-separated statements
 * - String literals (single and double quotes)
 * - Single-line comments (--)
 * - Block comments
 */
export function parseSqlStatements(sql: string): ParsedStatement[] {
  const statements: ParsedStatement[] = [];

  let currentStart = 0;
  let currentLine = 0;
  let startLine = 0;
  let i = 0;

  // Track whether we've found any non-whitespace content
  let hasContent = false;
  let contentStartOffset = 0;
  let contentStartLine = 0;

  while (i < sql.length) {
    const char = sql[i];

    // Track line numbers
    if (char === "\n") {
      currentLine++;
      i++;
      continue;
    }

    // Skip whitespace at the start of a statement
    if (!hasContent && /\s/.test(char)) {
      i++;
      continue;
    }

    // Handle single-line comments BEFORE marking content start
    // This ensures comment-only blocks don't count as statements
    if (char === "-" && sql[i + 1] === "-") {
      // Skip to end of line
      while (i < sql.length && sql[i] !== "\n") {
        i++;
      }
      continue;
    }

    // Handle multi-line comments BEFORE marking content start
    if (char === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length - 1) {
        if (sql[i] === "\n") {
          currentLine++;
        }
        if (sql[i] === "*" && sql[i + 1] === "/") {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    // Mark start of content (after skipping whitespace and comments)
    if (!hasContent) {
      hasContent = true;
      contentStartOffset = i;
      contentStartLine = currentLine;
    }

    // Handle string literals (single quotes)
    if (char === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "\n") currentLine++;
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2; // Escaped quote
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

    // Handle string literals (double quotes - identifiers)
    if (char === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === "\n") currentLine++;
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2; // Escaped quote
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

    // Handle dollar-quoted strings (PostgreSQL/DuckDB style)
    if (char === "$") {
      const dollarMatch = sql.slice(i).match(/^(\$[^$]*\$)/);
      if (dollarMatch) {
        const tag = dollarMatch[1];
        i += tag.length;
        const endIdx = sql.indexOf(tag, i);
        if (endIdx !== -1) {
          // Count newlines in the string
          for (let j = i; j < endIdx; j++) {
            if (sql[j] === "\n") currentLine++;
          }
          i = endIdx + tag.length;
          continue;
        }
      }
    }

    // Found a statement terminator
    if (char === ";") {
      if (hasContent) {
        const stmtSql = sql.slice(contentStartOffset, i).trim();
        if (stmtSql.length > 0) {
          statements.push({
            sql: stmtSql,
            startLine: contentStartLine,
            endLine: currentLine,
            startOffset: contentStartOffset,
            endOffset: i,
          });
        }
      }

      // Reset for next statement
      hasContent = false;
      currentStart = i + 1;
      i++;
      continue;
    }

    i++;
  }

  // Handle final statement (without trailing semicolon)
  if (hasContent) {
    const stmtSql = sql.slice(contentStartOffset).trim();
    if (stmtSql.length > 0) {
      statements.push({
        sql: stmtSql,
        startLine: contentStartLine,
        endLine: currentLine,
        startOffset: contentStartOffset,
        endOffset: sql.length,
      });
    }
  }

  return statements;
}

/**
 * Get a short preview of a SQL statement for tooltip
 */
function getStatementPreview(sql: string): string {
  // Get first line, remove comments, truncate
  const firstLine = sql.split("\n")[0].trim();
  const withoutComment = firstLine.replace(/--.*$/, "").trim();

  if (withoutComment.length > 50) {
    return withoutComment.slice(0, 47) + "...";
  }
  return withoutComment || sql.slice(0, 50).trim();
}

/**
 * Register the CodeLens provider
 */
export function registerSqlCodeLens(
  context: vscode.ExtensionContext
): SqlCodeLensProvider {
  const provider = new SqlCodeLensProvider();

  // Register for SQL files
  const disposable = vscode.languages.registerCodeLensProvider(
    [
      { language: "sql", scheme: "file" },
      { language: "sql", scheme: "untitled" },
    ],
    provider
  );

  context.subscriptions.push(disposable);

  // Refresh on document changes
  const changeDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document.languageId === "sql") {
      provider.refresh();
    }
  });
  context.subscriptions.push(changeDisposable);

  return provider;
}
