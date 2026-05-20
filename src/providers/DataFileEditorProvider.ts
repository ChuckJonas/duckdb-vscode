/**
 * DataFileEditorProvider - Custom readonly editor for data files
 *
 * Opens parquet, CSV, JSON, JSONL, and Excel files with DuckDB, displaying
 * query results in the same React webview used for regular query results.
 *
 * For xlsx files with multiple sheets, shows a container overview first
 * that lets the user pick a sheet before drilling into the column view.
 */
import * as vscode from "vscode";
import * as path from "path";
import { getDuckDBService } from "../services/duckdb";
import { installAndLoadExtension } from "../services/extensionsService";
import { getXlsxSheetNames } from "../services/xlsxSheetReader";
import {
  setupOverviewWebview,
  setupMultiTableOverviewWebview,
  type OverviewDataSource,
  type MultiTableDataSource,
  type DataOverviewMetadata,
  type ContainerOverviewMetadata,
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
      xlsx: "xlsx",
    };
    const fileType = fileTypeMap[ext] || ext;
    const fileName = path.basename(document.uri.fsPath);
    const documentUri = document.uri;

    if (fileType === "xlsx") {
      await this.resolveExcelEditor(
        document,
        webviewPanel,
        filePath,
        fileName,
        db
      );
      return;
    }

    const isParquet = fileType === "parquet";

    const source: OverviewDataSource = {
      async getMetadata(): Promise<DataOverviewMetadata> {
        const [metadata, stat, kvMetadata] = await Promise.all([
          db.getFileMetadata(filePath),
          Promise.resolve(vscode.workspace.fs.stat(documentUri)),
          isParquet ? db.getParquetKvMetadata(filePath) : Promise.resolve([]),
        ] as const);
        return {
          sourceKind: "file",
          displayName: fileName,
          fileType,
          fileSize: stat.size,
          rowCount: metadata.rowCount,
          columns: metadata.columns,
          ...(kvMetadata.length > 0 && { kvMetadata }),
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

      getWriteBackTarget() {
        // xlsx is excluded — DuckDB's excel extension is read-only.
        const writableFormats: Record<string, "parquet" | "csv" | "tsv" | "json" | "jsonl" | "ndjson"> = {
          parquet: "parquet",
          csv: "csv",
          tsv: "tsv",
          json: "json",
          jsonl: "jsonl",
          ndjson: "ndjson",
        };
        const fmt = writableFormats[fileType];
        return fmt ? { path: filePath, format: fmt } : null;
      },
    };

    setupOverviewWebview(webviewPanel, this.context, source, {
      autoLoad: getAutoLoadOptions(),
    });
  }

  /**
   * Handle xlsx files: discover sheets, then either show a single-sheet
   * overview or a multi-sheet container overview.
   */
  private async resolveExcelEditor(
    document: DataFileDocument,
    webviewPanel: vscode.WebviewPanel,
    filePath: string,
    fileName: string,
    db: ReturnType<typeof getDuckDBService>
  ): Promise<void> {
    const documentUri = document.uri;

    // Ensure the DuckDB excel extension is available
    try {
      await installAndLoadExtension(
        (sql) => db.run(sql),
        "excel"
      );
    } catch {
      // May already be loaded — continue and let queries fail with a clear error
    }

    const sheetNames = getXlsxSheetNames(document.uri.fsPath);

    // Single sheet: use the standard single-table flow
    if (sheetNames.length <= 1) {
      const sheetName = sheetNames[0] || "Sheet1";
      const source = this.buildExcelSheetSource(
        filePath,
        fileName,
        sheetName,
        documentUri,
        db
      );
      setupOverviewWebview(webviewPanel, this.context, source, {
        autoLoad: getAutoLoadOptions(),
      });
      return;
    }

    // Multiple sheets: use the container overview flow
    const multiSource: MultiTableDataSource = {
      async getContainerMetadata(): Promise<ContainerOverviewMetadata> {
        const stat = await vscode.workspace.fs.stat(documentUri);

        // Fetch metadata for all sheets in parallel
        const tableInfos = await Promise.all(
          sheetNames.map(async (name) => {
            try {
              const meta = await db.getExcelSheetMetadata(filePath, name);
              return {
                id: name,
                name,
                rowCount: meta.rowCount,
                columnCount: meta.columns.length,
                columns: meta.columns,
              };
            } catch {
              return {
                id: name,
                name,
                rowCount: 0,
                columnCount: 0,
                columns: [],
              };
            }
          })
        );

        return {
          sourceKind: "multi-table",
          displayName: fileName,
          fileType: "xlsx",
          fileSize: stat.size,
          tables: tableInfos,
        };
      },

      getTableSource: (tableId: string): OverviewDataSource => {
        return this.buildExcelSheetSource(
          filePath,
          tableId,
          tableId,
          documentUri,
          db
        );
      },
    };

    setupMultiTableOverviewWebview(webviewPanel, this.context, multiSource);
  }

  private buildExcelSheetSource(
    filePath: string,
    displayName: string,
    sheetName: string,
    documentUri: vscode.Uri,
    db: ReturnType<typeof getDuckDBService>
  ): OverviewDataSource {
    return {
      async getMetadata(): Promise<DataOverviewMetadata> {
        const [metadata, stat] = await Promise.all([
          db.getExcelSheetMetadata(filePath, sheetName),
          Promise.resolve(vscode.workspace.fs.stat(documentUri)),
        ]);
        return {
          sourceKind: "file",
          displayName,
          fileType: "xlsx",
          fileSize: stat.size,
          rowCount: metadata.rowCount,
          columns: metadata.columns,
        };
      },

      async getSummaries() {
        return db.getExcelSheetSummaries(filePath, sheetName);
      },

      async getColumnStats(column: string) {
        return db.getExcelSheetColumnStats(filePath, sheetName, column);
      },

      buildSelectSql(columns?: string[], limit?: number): string {
        const escapedPath = filePath.replace(/'/g, "''");
        const escapedSheet = sheetName.replace(/'/g, "''");
        const colList =
          columns && columns.length > 0
            ? columns.map((c) => `"${c}"`).join(", ")
            : "*";
        let sql = `SELECT ${colList} FROM read_xlsx('${escapedPath}', sheet = '${escapedSheet}', ignore_errors = true)`;
        if (limit) {
          sql += ` LIMIT ${limit}`;
        }
        return sql;
      },
    };
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

/**
 * Resolve the auto-load options when opening a data file.
 * Returns undefined when openMode is "schema" (auto-load disabled).
 *
 * `limit: undefined` (or 0 in settings) means "no LIMIT" — the full result
 * set is materialized and the table loads rows on demand via infinite scroll.
 */
function getAutoLoadOptions(): { limit?: number } | undefined {
  const cfg = vscode.workspace.getConfiguration("duckdb");
  const mode = cfg.get<string>("fileViewer.openMode", "schema");
  if (mode !== "data") return undefined;
  const limit = cfg.get<number>("fileViewer.openRowLimit", 0);
  return { limit: limit > 0 ? limit : undefined };
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
  {
    setting: "fileViewer.excel",
    patterns: ["*.xlsx"],
    defaultEnabled: true,
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
