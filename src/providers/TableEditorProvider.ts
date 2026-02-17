/**
 * TableEditorProvider - Custom readonly editor for database tables and views
 *
 * Uses a virtual URI scheme (duckdb-table:) so that VS Code's native editor
 * tab system manages the tabs, giving us preview-tab behavior for free.
 *
 * URI format: duckdb-table:///database/schema/tableName?view=true
 */
import * as vscode from "vscode";
import { getDuckDBService } from "../services/duckdb";
import {
  setupOverviewWebview,
  type OverviewDataSource,
  type DataOverviewMetadata,
} from "./overviewHandler";

// ============================================================================
// Virtual URI helpers
// ============================================================================

/**
 * Build a virtual URI for a table/view that can be opened as a custom editor.
 */
export function buildTableUri(
  database: string,
  schema: string,
  tableName: string,
  isView: boolean
): vscode.Uri {
  return vscode.Uri.parse(
    `duckdb-table:///${encodeURIComponent(database)}/${encodeURIComponent(
      schema
    )}/${encodeURIComponent(tableName)}${isView ? "?view=true" : ""}`
  );
}

/**
 * Parse table info out of a duckdb-table: URI.
 */
function parseTableUri(uri: vscode.Uri): {
  database: string;
  schema: string;
  tableName: string;
  isView: boolean;
} {
  const parts = uri.path.split("/").filter(Boolean);
  return {
    database: decodeURIComponent(parts[0] || "memory"),
    schema: decodeURIComponent(parts[1] || "main"),
    tableName: decodeURIComponent(parts[2] || ""),
    isView: uri.query === "view=true",
  };
}

// ============================================================================
// Minimal FileSystemProvider for the duckdb-table: scheme
// ============================================================================

/**
 * A stub FileSystemProvider so VS Code can "open" duckdb-table: URIs.
 * We only need stat() to return a valid entry; reads are never called
 * because the custom editor handles all rendering.
 */
export class TableFileSystemProvider implements vscode.FileSystemProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChange.event;

  stat(_uri: vscode.Uri): vscode.FileStat {
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 };
  }

  readFile(_uri: vscode.Uri): Uint8Array {
    return new Uint8Array();
  }

  // Remaining methods are no-ops — the provider is read-only.
  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }
  readDirectory(): [string, vscode.FileType][] {
    return [];
  }
  createDirectory(): void {}
  writeFile(): void {}
  delete(): void {}
  rename(): void {}
}

// ============================================================================
// Custom Editor Provider
// ============================================================================

class TableDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {}
}

export class TableEditorProvider
  implements vscode.CustomReadonlyEditorProvider<TableDocument>
{
  public static readonly viewType = "duckdb.tableViewer";

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): TableDocument {
    return new TableDocument(uri);
  }

  async resolveCustomEditor(
    document: TableDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const { database, schema, tableName, isView } = parseTableUri(document.uri);
    const db = getDuckDBService();
    const qualifiedName = `"${database}"."${schema}"."${tableName}"`;

    const source: OverviewDataSource = {
      async getMetadata(): Promise<DataOverviewMetadata> {
        const metadata = await db.getTableMetadata(database, schema, tableName);
        return {
          sourceKind: "table",
          displayName: tableName,
          database,
          schema,
          tableName,
          isView,
          rowCount: metadata.rowCount,
          columns: metadata.columns,
        };
      },

      async getSummaries() {
        return db.getTableSummaries(database, schema, tableName);
      },

      async getColumnStats(column: string) {
        return db.getTableColumnStats(database, schema, tableName, column);
      },

      buildSelectSql(columns?: string[], limit?: number): string {
        const colList =
          columns && columns.length > 0
            ? columns.map((c) => `"${c}"`).join(", ")
            : "*";
        let sql = `SELECT ${colList} FROM ${qualifiedName}`;
        if (limit) {
          sql += ` LIMIT ${limit}`;
        }
        return sql;
      },
    };

    setupOverviewWebview(webviewPanel, this.context, source);
  }
}
