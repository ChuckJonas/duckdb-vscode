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
import { getDuckDBService } from "../services/duckdb";
import {
  setupOverviewWebview,
  type OverviewDataSource,
  type DataOverviewMetadata,
} from "./overviewHandler";

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
    const filePath = this.getDisplayPath(document.uri);
    const db = getDuckDBService();

    // Detect file type from extension
    const ext = path
      .extname(document.uri.fsPath)
      .toLowerCase()
      .replace(".", "");
    const fileTypeMap: Record<string, string> = {
      parquet: "parquet",
      csv: "csv",
      tsv: "tsv",
      json: "json",
      jsonl: "jsonl",
      ndjson: "ndjson",
    };
    const fileType = fileTypeMap[ext] || ext;
    const fileName = path.basename(document.uri.fsPath);
    const documentUri = document.uri;

    const source: OverviewDataSource = {
      async getMetadata(): Promise<DataOverviewMetadata> {
        const [metadata, stat] = await Promise.all([
          db.getFileMetadata(filePath),
          vscode.workspace.fs.stat(documentUri),
        ]);
        return {
          sourceKind: "file",
          displayName: fileName,
          fileType,
          fileSize: stat.size,
          rowCount: metadata.rowCount,
          columns: metadata.columns,
        };
      },

      async getSummaries() {
        return db.getFileSummaries(filePath);
      },

      async getColumnStats(column: string) {
        return db.getFileColumnStats(filePath, column);
      },

      buildSelectSql(columns?: string[], limit?: number): string {
        const escaped = filePath.replace(/'/g, "''");
        const colList =
          columns && columns.length > 0
            ? columns.map((c) => `"${c}"`).join(", ")
            : "*";
        let sql = `SELECT ${colList} FROM '${escaped}'`;
        if (limit) {
          sql += ` LIMIT ${limit}`;
        }
        return sql;
      },
    };

    setupOverviewWebview(webviewPanel, this.context, source);
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
