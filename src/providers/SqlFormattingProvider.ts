/**
 * SQL Formatting Provider
 * Provides Format Document and Format Selection for SQL files using sql-formatter with DuckDB dialect
 */
import * as vscode from "vscode";
import {
  format,
  type SqlLanguage,
  type KeywordCase,
  type IndentStyle,
  type LogicalOperatorNewline,
} from "sql-formatter";

/**
 * Read DuckDB formatting configuration from workspace settings
 */
function getFormattingConfig(options: vscode.FormattingOptions) {
  const config = vscode.workspace.getConfiguration("duckdb.format");

  return {
    language: "duckdb" as SqlLanguage,
    keywordCase: config.get<KeywordCase>("keywordCase", "upper"),
    indentStyle: config.get<IndentStyle>("indentStyle", "standard"),
    logicalOperatorNewline: config.get<LogicalOperatorNewline>(
      "logicalOperatorNewline",
      "before"
    ),
    tabWidth: options.tabSize,
    useTabs: !options.insertSpaces,
  };
}

/**
 * Format SQL text using sql-formatter with DuckDB dialect
 */
function formatSql(sql: string, options: vscode.FormattingOptions): string {
  const config = getFormattingConfig(options);
  return format(sql, config);
}

/**
 * Document formatting provider for SQL files
 */
class SqlDocumentFormattingProvider
  implements vscode.DocumentFormattingEditProvider
{
  provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions
  ): vscode.TextEdit[] {
    const text = document.getText();
    if (!text.trim()) {
      return [];
    }

    try {
      const formatted = formatSql(text, options);
      if (formatted === text) {
        return [];
      }

      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(text.length)
      );
      return [vscode.TextEdit.replace(fullRange, formatted)];
    } catch (error) {
      console.error("DuckDB SQL formatting error:", error);
      return [];
    }
  }
}

/**
 * Range formatting provider for SQL files (Format Selection)
 */
class SqlDocumentRangeFormattingProvider
  implements vscode.DocumentRangeFormattingEditProvider
{
  provideDocumentRangeFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range,
    options: vscode.FormattingOptions
  ): vscode.TextEdit[] {
    const text = document.getText(range);
    if (!text.trim()) {
      return [];
    }

    try {
      const formatted = formatSql(text, options);
      if (formatted === text) {
        return [];
      }

      return [vscode.TextEdit.replace(range, formatted)];
    } catch (error) {
      console.error("DuckDB SQL range formatting error:", error);
      return [];
    }
  }
}

/**
 * Register both document and range formatting providers for SQL files
 */
export function registerSqlFormatter(context: vscode.ExtensionContext): void {
  const documentFormatter =
    vscode.languages.registerDocumentFormattingEditProvider(
      { language: "sql" },
      new SqlDocumentFormattingProvider()
    );

  const rangeFormatter =
    vscode.languages.registerDocumentRangeFormattingEditProvider(
      { language: "sql" },
      new SqlDocumentRangeFormattingProvider()
    );

  context.subscriptions.push(documentFormatter, rangeFormatter);
}
