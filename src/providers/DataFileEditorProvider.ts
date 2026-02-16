/**
 * DataFileEditorProvider - Custom readonly editor for data files
 *
 * Opens parquet, CSV, JSON, and JSONL files with DuckDB, displaying
 * query results in the same React webview used for regular query results.
 *
 * Parquet is enabled by default (replaces the "binary file" error).
 * CSV/JSON/JSONL are available via "Open With..." and can be enabled
 * as defaults via settings.
 */
import * as vscode from "vscode";
import * as path from "path";
import {
  getDuckDBService,
  buildQueryFileSql,
  type MultiQueryResultWithPages,
} from "../services/duckdb";
import { handleExport } from "../services/webviewService";

class DataFileDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {}
}

export class DataFileEditorProvider
  implements vscode.CustomReadonlyEditorProvider<DataFileDocument>
{
  public static readonly viewType = "duckdb.dataFileViewer";

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): DataFileDocument {
    return new DataFileDocument(uri);
  }

  async resolveCustomEditor(
    document: DataFileDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "out", "webview"),
      ],
    };

    webviewPanel.iconPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      "resources",
      "duckdb-icon.svg"
    );

    const filePath = this.getDisplayPath(document.uri);
    const sql = buildQueryFileSql(filePath);
    const config = vscode.workspace.getConfiguration("duckdb");
    const pageSize = config.get<number>("pageSize", 1000);
    const maxCopyRows = config.get<number>("maxCopyRows", 50000);
    const db = getDuckDBService();

    let cacheIds: string[] = [];
    let sortColumn: string | undefined;
    let sortDirection: "asc" | "desc" | undefined;

    const scriptUri = webviewPanel.webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "out",
        "webview",
        "results.js"
      )
    );
    webviewPanel.webview.html = getWebviewHtml(scriptUri);

    // Clean up DuckDB caches when the editor is closed
    webviewPanel.onDidDispose(() => {
      for (const id of cacheIds) {
        db.dropCache(id).catch(() => {});
      }
    });

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case "ready":
          try {
            const result = await db.executeQuery(sql, pageSize);
            cacheIds = collectCacheIds(result);
            webviewPanel.webview.postMessage({
              type: "queryResult",
              data: result,
              pageSize,
              maxCopyRows,
            });
          } catch (error) {
            webviewPanel.webview.postMessage({
              type: "queryError",
              error: String(error),
            });
          }
          break;

        case "requestPage":
          try {
            const pageData = await db.fetchPage(
              message.cacheId,
              message.offset,
              pageSize,
              message.sortColumn,
              message.sortDirection,
              message.whereClause
            );
            sortColumn = message.sortColumn;
            sortDirection = message.sortDirection;
            webviewPanel.webview.postMessage({
              type: "pageData",
              data: pageData,
            });
          } catch (error) {
            webviewPanel.webview.postMessage({
              type: "filterError",
              cacheId: message.cacheId,
              error: String(error),
            });
          }
          break;

        case "requestColumnStats":
          try {
            const stats = await db.getCacheColumnStats(
              message.cacheId,
              message.column,
              message.whereClause
            );
            webviewPanel.webview.postMessage({
              type: "columnStats",
              cacheId: message.cacheId,
              data: stats,
            });
          } catch (error) {
            webviewPanel.webview.postMessage({
              type: "columnStats",
              cacheId: message.cacheId,
              column: message.column,
              data: null,
              error: String(error),
            });
          }
          break;

        case "requestColumnSummaries":
          try {
            const summaries = await db.getCacheColumnSummaries(message.cacheId);
            webviewPanel.webview.postMessage({
              type: "columnSummaries",
              cacheId: message.cacheId,
              data: summaries,
            });
          } catch (error) {
            webviewPanel.webview.postMessage({
              type: "columnSummaries",
              cacheId: message.cacheId,
              data: [],
              error: String(error),
            });
          }
          break;

        case "requestDistinctValues":
          try {
            const [distinctValues, cardinality] = await Promise.all([
              db.getColumnDistinctValues(
                message.cacheId,
                message.column,
                100,
                message.searchTerm
              ),
              db.getColumnCardinality(message.cacheId, message.column),
            ]);
            webviewPanel.webview.postMessage({
              type: "distinctValues",
              cacheId: message.cacheId,
              column: message.column,
              data: distinctValues,
              cardinality,
            });
          } catch (error) {
            webviewPanel.webview.postMessage({
              type: "distinctValues",
              cacheId: message.cacheId,
              column: message.column,
              data: [],
              cardinality: 0,
            });
          }
          break;

        case "export":
          await handleExport(
            db,
            message.cacheId,
            message.format,
            maxCopyRows,
            sortColumn,
            sortDirection
          );
          break;

        case "requestCopyData":
          try {
            const { columns, rows } = await db.getCopyData(
              message.cacheId,
              maxCopyRows,
              sortColumn,
              sortDirection
            );
            webviewPanel.webview.postMessage({
              type: "copyData",
              data: { columns, rows, maxCopyRows },
            });
          } catch (error) {
            webviewPanel.webview.postMessage({
              type: "copyData",
              error: String(error),
            });
          }
          break;

        case "refreshQuery":
          try {
            for (const id of cacheIds) {
              db.dropCache(id).catch(() => {});
            }
            const result = await db.executeQuery(sql, pageSize);
            cacheIds = collectCacheIds(result);
            sortColumn = undefined;
            sortDirection = undefined;
            webviewPanel.webview.postMessage({
              type: "queryResult",
              data: result,
              pageSize,
              maxCopyRows,
            });
          } catch (error) {
            webviewPanel.webview.postMessage({
              type: "refreshError",
              error: String(error),
            });
          }
          break;

        case "goToSource":
          // For data files, "go to source" opens the file with default text editor
          break;
      }
    });
  }

  private getDisplayPath(uri: vscode.Uri): string {
    const filePath = uri.fsPath;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot && filePath.startsWith(workspaceRoot)) {
      return "./" + path.relative(workspaceRoot, filePath);
    }
    return filePath;
  }
}

function collectCacheIds(result: MultiQueryResultWithPages): string[] {
  return result.statements.map((s) => s.meta.cacheId).filter((id) => id);
}

function getWebviewHtml(scriptUri: vscode.Uri): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src ${scriptUri.scheme}:;">
  <title>DuckDB Data Viewer</title>
</head>
<body>
  <div id="root"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}

// ============================================================================
// Editor Associations Management
// ============================================================================

/**
 * File type configuration for editor associations.
 * Maps settings to the glob patterns that should auto-open with DuckDB.
 */
const FILE_TYPE_ASSOCIATIONS: Array<{
  setting: string;
  patterns: string[];
  defaultEnabled: boolean;
}> = [
  {
    setting: "fileViewer.parquet",
    patterns: ["*.parquet"],
    defaultEnabled: true,
  },
  {
    setting: "fileViewer.csv",
    patterns: ["*.csv", "*.tsv"],
    defaultEnabled: true,
  },
  {
    setting: "fileViewer.json",
    // Only auto-associate jsonl/ndjson — plain .json files are too
    // common for config files and would be disruptive as a default.
    patterns: ["*.jsonl", "*.ndjson"],
    defaultEnabled: false,
  },
];

/**
 * Synchronize `workbench.editorAssociations` with the current
 * `duckdb.fileViewer.*` settings. Called on activation and when
 * settings change.
 *
 * Only touches associations that are unset or owned by this extension.
 * User-configured associations for other editors are never overwritten.
 */
export async function syncEditorAssociations(): Promise<void> {
  const duckdbConfig = vscode.workspace.getConfiguration("duckdb");
  const workbenchConfig = vscode.workspace.getConfiguration("workbench");

  const associations =
    workbenchConfig.get<Record<string, string>>("editorAssociations") || {};
  const updated = { ...associations };
  let changed = false;

  for (const { setting, patterns, defaultEnabled } of FILE_TYPE_ASSOCIATIONS) {
    const enabled = duckdbConfig.get<boolean>(setting, defaultEnabled);

    for (const pattern of patterns) {
      if (enabled) {
        // Set our editor as default only if unset or already ours
        if (updated[pattern] !== DataFileEditorProvider.viewType) {
          if (
            !updated[pattern] ||
            updated[pattern] === DataFileEditorProvider.viewType
          ) {
            updated[pattern] = DataFileEditorProvider.viewType;
            changed = true;
          }
        }
      } else {
        // Remove only if currently set to our editor
        if (updated[pattern] === DataFileEditorProvider.viewType) {
          delete updated[pattern];
          changed = true;
        }
      }
    }
  }

  if (changed) {
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await workbenchConfig.update("editorAssociations", updated, target);
  }
}
