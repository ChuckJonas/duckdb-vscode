import * as vscode from "vscode";
import * as path from "path";
import {
  getDuckDBService,
  disposeDuckDBService,
  buildSummarizeSql,
  buildSummarizeFileSql,
  buildQueryFileSql,
  DuckDBQueryError,
  DuckDBError,
} from "./services/duckdb";
import {
  showResultsPanel,
  disposeAllPanels,
  getActiveResultsSourceUri,
} from "./services/webviewService";
import {
  DatabaseExplorer,
  ExplorerNode,
  getTableDefinition,
  getViewDefinition,
} from "./explorer/DatabaseExplorer";
import { HistoryExplorer, HistoryNode } from "./explorer/HistoryExplorer";
import {
  ExtensionsExplorer,
  ExtensionNode,
} from "./explorer/ExtensionsExplorer";
import { getHistoryService } from "./services/historyService";
import { registerSqlCodeLens } from "./providers/SqlCodeLensProvider";
import {
  switchDatabase,
  detachDatabase,
  attachDatabase,
  setDefaultDatabase,
  removeDatabaseFromSettings,
  removeExtensionFromSettings,
  addDatabaseToSettings,
  addExtensionToSettings,
  getCurrentDatabase,
  DatabaseConfig as ManagerDatabaseConfig,
  getCombinedDatabases,
  buildDescribeSql,
  attachDatabaseAndUse,
  attachMemoryDatabase,
  createSchema,
  dropObject,
  runManualSql,
  buildSelectTopSql,
  buildNewTableBoilerplate,
  buildNewViewBoilerplate,
  getWorkspaceConfig,
  updateDatabaseAttachedState,
  updateDatabaseReadOnlyState,
  getConfiguredDatabases,
} from "./services/databaseManager";
import {
  getAutocompleteSuggestions,
  inferCompletionKind,
} from "./services/autocompleteService";
import {
  installAndLoadExtension,
  getLoadedExtensions as getLoadedExtensionsFromService,
  COMMON_EXTENSIONS,
} from "./services/extensionsService";

// Current database state
let currentDatabase = "memory";
let statusBarItem: vscode.StatusBarItem;

// Diagnostic collection for SQL errors
let diagnosticCollection: vscode.DiagnosticCollection;

/**
 * Show a DuckDB error as a VS Code diagnostic (inline error in editor)
 */
function showErrorDiagnostic(
  document: vscode.TextDocument,
  error: DuckDBError,
  sqlStartOffset: number = 0,
): void {
  // Clear previous diagnostics for this document
  diagnosticCollection.delete(document.uri);

  // Determine the error range
  let range: vscode.Range;

  if (error.line !== undefined && error.column !== undefined) {
    // We have line and column info - use it
    const line = Math.max(0, error.line - 1); // Convert 1-indexed to 0-indexed
    const column = Math.max(0, error.column);

    // Get the line text to determine end column
    const lineText = document.lineAt(
      Math.min(line, document.lineCount - 1),
    ).text;
    const endColumn = Math.min(column + 20, lineText.length); // Highlight up to 20 chars or end of line

    range = new vscode.Range(line, column, line, endColumn);
  } else if (error.position !== undefined) {
    // We have character offset - convert to position
    const pos = document.positionAt(sqlStartOffset + error.position);
    const endPos = document.positionAt(sqlStartOffset + error.position + 10);
    range = new vscode.Range(pos, endPos);
  } else {
    // No location info - highlight first line
    range = new vscode.Range(0, 0, 0, 100);
  }

  // Create the diagnostic
  const diagnostic = new vscode.Diagnostic(
    range,
    error.message,
    vscode.DiagnosticSeverity.Error,
  );
  diagnostic.source = `DuckDB (${error.type})`;

  // Add code for specific error subtypes
  if (error.subtype) {
    diagnostic.code = error.subtype;
  }

  diagnosticCollection.set(document.uri, [diagnostic]);
}

/**
 * Clear diagnostics for a document
 */
function clearDiagnostics(document: vscode.TextDocument): void {
  diagnosticCollection.delete(document.uri);
}

export async function activate(context: vscode.ExtensionContext) {
  console.log("🦆 DuckDB extension is now active!");

  // Create diagnostic collection for SQL errors
  diagnosticCollection = vscode.languages.createDiagnosticCollection("duckdb");
  context.subscriptions.push(diagnosticCollection);

  // Initialize DuckDB on activation
  const db = getDuckDBService();
  try {
    await db.initialize();

    // Change process working directory to workspace root
    // This affects DuckDB's file path autocomplete
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
      console.log("🦆 Changing working directory to:", workspaceRoot);
      process.chdir(workspaceRoot);
    }

    // Load autocomplete extension (required for SQL completions)
    await installAndLoadExtension((sql) => db.run(sql), "autocomplete");
    // Auto-load extensions from workspace settings
    await autoLoadExtensions(db);
    // Auto-attach databases from workspace settings
    await autoAttachDatabases(db);

    // Initialize query history (optional persistence)
    const historyService = getHistoryService();
    await historyService.initialize(async (dbPath: string) => {
      // Create a separate DuckDB connection for history persistence
      const { DuckDBInstance } = await import("@duckdb/node-api");
      const historyInstance = await DuckDBInstance.create(dbPath);
      const historyConn = await historyInstance.connect();
      return {
        query: async (sql: string) => {
          const reader = await historyConn.runAndReadAll(sql);
          return { rows: reader.getRowObjectsJS() };
        },
        run: async (sql: string) => {
          await historyConn.run(sql);
        },
      };
    });
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to initialize DuckDB: ${error}`);
  }

  // Create status bar item (right side, low priority = far right)
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    50,
  );
  statusBarItem.command = "duckdb.selectDatabase";
  updateStatusBar();
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Get settings
  const getPageSize = () =>
    vscode.workspace.getConfiguration("duckdb").get<number>("pageSize", 1000);
  const getMaxCopyRows = () =>
    vscode.workspace
      .getConfiguration("duckdb")
      .get<number>("maxCopyRows", 50000);

  // Register Execute Query command
  const executeCmd = vscode.commands.registerCommand(
    "duckdb.executeQuery",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("No active editor");
        return;
      }

      const selection = editor.selection;
      const sql = selection.isEmpty
        ? editor.document.getText()
        : editor.document.getText(selection);

      if (!sql.trim()) {
        vscode.window.showWarningMessage("No SQL to execute");
        return;
      }

      const startTime = Date.now();
      const pageSize = getPageSize();

      // Clear previous diagnostics before executing
      clearDiagnostics(editor.document);

      // Calculate SQL offset if using selection
      const sqlStartOffset = selection.isEmpty
        ? 0
        : editor.document.offsetAt(selection.start);

      try {
        const result = await db.executeQuery(sql, pageSize);
        const sourceId = editor.document.uri.toString();
        showResultsPanel(result, context, sourceId, pageSize, getMaxCopyRows());

        // Record in history - use totals from all statements
        const dbName = await getCurrentDatabase(async (s) => ({
          rows: await db.query(s),
        }));
        const lastStmt = result.statements[result.statements.length - 1];
        const totalRows = result.statements.reduce(
          (sum, s) => sum + s.meta.totalRows,
          0,
        );
        const totalCols = lastStmt?.meta.columns.length || 0;
        await getHistoryService().addEntry({
          sql,
          executedAt: new Date(),
          durationMs: result.totalExecutionTime,
          rowCount: totalRows,
          columnCount: totalCols,
          error: null,
          databaseName: dbName,
          sourceFile: sourceId,
        });

        // Refresh database list in case ATTACH was run
        updateStatusBar();
      } catch (error) {
        // Record failed query in history
        const dbName = await getCurrentDatabase(async (s) => ({
          rows: await db.query(s),
        })).catch(() => currentDatabase);
        await getHistoryService().addEntry({
          sql,
          executedAt: new Date(),
          durationMs: Date.now() - startTime,
          rowCount: null,
          columnCount: null,
          error: String(error),
          databaseName: dbName,
          sourceFile: editor.document.uri.toString(),
        });

        // Show error as inline diagnostic if it's a DuckDB error with location info
        if (error instanceof DuckDBQueryError) {
          console.log(
            "🦆 DuckDB Error:",
            JSON.stringify(error.duckdbError, null, 2),
          );
          showErrorDiagnostic(
            editor.document,
            error.duckdbError,
            sqlStartOffset,
          );
          vscode.window.showErrorMessage(
            `DuckDB ${error.duckdbError.type} Error: ${error.duckdbError.message}`,
          );
        } else {
          console.log("🦆 Non-DuckDB Error:", error);
          vscode.window.showErrorMessage(`${error}`);
        }
      }
    },
  );

  // Register Run Statement command (from CodeLens)
  const runStatementCmd = vscode.commands.registerCommand(
    "duckdb.runStatement",
    async (uri: vscode.Uri, startOffset: number, endOffset: number) => {
      // Find the document
      const document = await vscode.workspace.openTextDocument(uri);
      const sql = document.getText().slice(startOffset, endOffset).trim();

      if (!sql) {
        vscode.window.showWarningMessage("No SQL to execute");
        return;
      }

      // Clear previous diagnostics
      clearDiagnostics(document);

      const startTime = Date.now();
      const pageSize = getPageSize();

      try {
        const result = await db.executeQuery(sql, pageSize);
        const sourceId = uri.toString(); // Use document URI to reuse panel per file
        showResultsPanel(result, context, sourceId, pageSize, getMaxCopyRows());

        // Record in history
        const dbName = await getCurrentDatabase(async (s) => ({
          rows: await db.query(s),
        }));
        const lastStmt = result.statements[result.statements.length - 1];
        const totalRows = result.statements.reduce(
          (sum, s) => sum + s.meta.totalRows,
          0,
        );
        await getHistoryService().addEntry({
          sql,
          executedAt: new Date(),
          durationMs: result.totalExecutionTime,
          rowCount: totalRows,
          columnCount: lastStmt?.meta.columns.length || 0,
          error: null,
          databaseName: dbName,
          sourceFile: uri.toString(),
        });

        updateStatusBar();
      } catch (error) {
        const dbName = await getCurrentDatabase(async (s) => ({
          rows: await db.query(s),
        })).catch(() => currentDatabase);
        await getHistoryService().addEntry({
          sql,
          executedAt: new Date(),
          durationMs: Date.now() - startTime,
          rowCount: 0,
          columnCount: 0,
          error: String(error),
          databaseName: dbName,
          sourceFile: uri.toString(),
        });

        // Show error as inline diagnostic
        if (error instanceof DuckDBQueryError) {
          console.log(
            "🦆 DuckDB Error (statement):",
            JSON.stringify(error.duckdbError, null, 2),
          );
          showErrorDiagnostic(document, error.duckdbError, startOffset);
          vscode.window.showErrorMessage(
            `DuckDB ${error.duckdbError.type} Error: ${error.duckdbError.message}`,
          );
        } else {
          console.log("🦆 Non-DuckDB Error (statement):", error);
          vscode.window.showErrorMessage(`${error}`);
        }
      }
    },
  );

  // Register Select Database command (status bar click)
  const selectDbCmd = vscode.commands.registerCommand(
    "duckdb.selectDatabase",
    async () => {
      // Get combined database state from DuckDB and settings
      const databases = await getCombinedDatabases(async (sql) => ({
        rows: await db.query(sql),
      }));

      const items: DatabasePickItem[] = [];

      // Add attached databases first
      const attachedDbs = databases.filter((d) => d.isAttached);
      for (const dbInfo of attachedDbs) {
        const isCurrent = dbInfo.alias === currentDatabase;
        // Show :memory: for the in-memory database
        const displayName =
          dbInfo.alias === "memory" ? ":memory:" : dbInfo.alias;
        let label = isCurrent ? `$(check) ${displayName}` : displayName;
        if (dbInfo.isReadOnly) label += " 🔒";

        items.push({
          label,
          description:
            dbInfo.alias === "memory" ? undefined : dbInfo.path || undefined,
          action: "switch",
          databaseName: dbInfo.alias,
        });
      }

      // Add detached databases (from settings but not attached)
      const detachedDbs = databases.filter(
        (d) => !d.isAttached && d.isConfigured,
      );
      if (detachedDbs.length > 0) {
        items.push({
          label: "",
          kind: vscode.QuickPickItemKind.Separator,
          action: "none",
        });
        items.push({
          label: "Detached Databases",
          kind: vscode.QuickPickItemKind.Separator,
          action: "none",
        });

        for (const dbInfo of detachedDbs) {
          // Show :memory: for memory-type databases
          const displayName =
            dbInfo.type === "memory" ? ":memory:" : dbInfo.alias;
          items.push({
            label: `$(debug-disconnect) ${displayName}`,
            description:
              dbInfo.type === "memory" ? undefined : dbInfo.path || undefined,
            detail: "Click to attach",
            action: "reattach",
            databaseName: dbInfo.alias,
          });
        }
      }

      // Add separator and actions
      items.push(
        { label: "", kind: vscode.QuickPickItemKind.Separator, action: "none" },
        {
          label: "$(new-file) Create New Database...",
          description: "Create a new .duckdb file",
          action: "create",
        },
        {
          label: "$(folder-opened) Attach Existing...",
          description: "Attach an existing .duckdb file",
          action: "attach",
        },
      );

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: "🦆 Select Database",
      });

      if (!selected || selected.action === "none") return;

      switch (selected.action) {
        case "create": {
          const fileUri = await vscode.window.showSaveDialog({
            filters: { "DuckDB Database": ["duckdb"] },
            title: "Create New DuckDB Database",
            defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
          });

          if (fileUri) {
            const filePath = fileUri.fsPath;
            const alias = path.basename(filePath, path.extname(filePath));

            try {
              await attachDatabaseAndUse((sql) => db.run(sql), filePath, alias);
              currentDatabase = alias;
              updateStatusBar();
              databaseExplorer.refresh();

              // Save to workspace settings
              await addDatabaseToSettings({
                alias,
                type: "file",
                path: filePath,
                attached: true,
              });
              await setDefaultDatabase(alias);

              vscode.window.showInformationMessage(
                `🦆 Created database: ${alias}`,
              );
            } catch (error) {
              vscode.window.showErrorMessage(
                `Failed to create database: ${error}`,
              );
            }
          }
          break;
        }

        case "attach": {
          const fileUri = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { "DuckDB Database": ["duckdb", "db"] },
            title: "Attach DuckDB Database File",
          });

          if (fileUri && fileUri[0]) {
            const filePath = fileUri[0].fsPath;
            const alias = path.basename(filePath, path.extname(filePath));

            // Ask if read-only
            const readOnlyChoice = await vscode.window.showQuickPick(
              [
                {
                  label: "Read & Write",
                  description: "Full access to database",
                  readOnly: false,
                },
                {
                  label: "Read Only",
                  description: "No modifications allowed",
                  readOnly: true,
                },
              ],
              { placeHolder: "Select access mode" },
            );

            if (!readOnlyChoice) break;

            try {
              await attachDatabaseAndUse(
                (sql) => db.run(sql),
                filePath,
                alias,
                readOnlyChoice.readOnly,
              );
              currentDatabase = alias;
              updateStatusBar();
              databaseExplorer.refresh();

              // Save to workspace settings
              await addDatabaseToSettings({
                alias,
                type: "file",
                path: filePath,
                readOnly: readOnlyChoice.readOnly || undefined,
                attached: true,
              });
              await setDefaultDatabase(alias);

              const modeLabel = readOnlyChoice.readOnly ? " (read-only)" : "";
              vscode.window.showInformationMessage(
                `🦆 Attached database: ${alias}${modeLabel}`,
              );
            } catch (error) {
              vscode.window.showErrorMessage(
                `Failed to attach database: ${error}`,
              );
            }
          }
          break;
        }

        case "reattach": {
          if (selected.databaseName) {
            // Re-attach a detached database from settings
            const configs = getConfiguredDatabases();
            const config = configs.find(
              (c) => c.alias === selected.databaseName,
            );

            if (!config) {
              vscode.window.showErrorMessage(
                `No configuration found for database: ${selected.databaseName}`,
              );
              break;
            }

            // For file databases, ask about read-only mode
            let readOnly = config.readOnly ?? false;
            if (config.type === "file") {
              const readOnlyChoice = await vscode.window.showQuickPick(
                [
                  {
                    label: "Read & Write",
                    description: "Full access to database",
                    readOnly: false,
                  },
                  {
                    label: "Read Only",
                    description: "No modifications allowed",
                    readOnly: true,
                  },
                ],
                {
                  placeHolder: "Select access mode",
                  // Pre-select the current mode
                },
              );

              if (!readOnlyChoice) break; // User cancelled
              readOnly = readOnlyChoice.readOnly;
            }

            try {
              const workspaceRoot =
                vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
              const runFn = (sql: string) => db.run(sql);

              switch (config.type) {
                case "memory":
                  await attachMemoryDatabase(runFn, config.alias);
                  break;
                case "file":
                  if (config.path) {
                    const filePath = config.path.startsWith("/")
                      ? config.path
                      : path.join(workspaceRoot, config.path);
                    await attachDatabase(
                      runFn,
                      filePath,
                      config.alias,
                      readOnly,
                    );
                  }
                  break;
                case "manual":
                  if (config.sql) {
                    await runManualSql(runFn, config.sql);
                  }
                  break;
              }

              // Update settings to mark as attached and save readOnly state
              await updateDatabaseAttachedState(selected.databaseName, true);
              if (config.type === "file" && readOnly !== config.readOnly) {
                await updateDatabaseReadOnlyState(
                  selected.databaseName,
                  readOnly,
                );
              }
              databaseExplorer.refresh();
              const modeLabel = readOnly ? " (read-only)" : "";
              vscode.window.showInformationMessage(
                `🦆 Attached database: ${selected.databaseName}${modeLabel}`,
              );
            } catch (error) {
              vscode.window.showErrorMessage(
                `Failed to attach database: ${error}`,
              );
            }
          }
          break;
        }

        case "switch": {
          if (selected.databaseName) {
            try {
              await switchDatabase((sql) => db.run(sql), selected.databaseName);
              currentDatabase = selected.databaseName;
              updateStatusBar();
              databaseExplorer.refresh();

              // Update default database in settings
              await setDefaultDatabase(selected.databaseName);
            } catch (error) {
              vscode.window.showErrorMessage(
                `Failed to switch database: ${error}`,
              );
            }
          }
          break;
        }
      }
    },
  );

  // Register Manage Extensions command
  const manageExtCmd = vscode.commands.registerCommand(
    "duckdb.manageExtensions",
    async () => {
      await showExtensionsQuickPick(db);
    },
  );

  // Register Query File command (right-click on data files)
  // Helper to get display path (relative if within workspace)
  function getDisplayPath(uri: vscode.Uri): string {
    const filePath = uri.fsPath;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot && filePath.startsWith(workspaceRoot)) {
      return "./" + path.relative(workspaceRoot, filePath);
    }
    return filePath;
  }

  function getQueryForFile(uri: vscode.Uri): string {
    return buildQueryFileSql(getDisplayPath(uri));
  }

  const queryFileCmd = vscode.commands.registerCommand(
    "duckdb.queryFile",
    async (uri: vscode.Uri) => {
      if (!uri) {
        vscode.window.showWarningMessage("No file selected");
        return;
      }

      const sql = getQueryForFile(uri);

      // Open new SQL file with the query
      const doc = await vscode.workspace.openTextDocument({
        content: sql,
        language: "sql",
      });
      await vscode.window.showTextDocument(doc);

      // Execute the query
      try {
        const pageSize = getPageSize();
        const result = await db.executeQuery(sql, pageSize);
        showResultsPanel(
          result,
          context,
          doc.uri.toString(),
          pageSize,
          getMaxCopyRows(),
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Query failed: ${error}`);
      }
    },
  );

  const copyQueryCmd = vscode.commands.registerCommand(
    "duckdb.copyQuery",
    async (uri: vscode.Uri) => {
      if (!uri) {
        vscode.window.showWarningMessage("No file selected");
        return;
      }

      const sql = getQueryForFile(uri);
      await vscode.env.clipboard.writeText(sql);
      vscode.window.showInformationMessage("Query copied to clipboard");
    },
  );

  const summarizeFileCmd = vscode.commands.registerCommand(
    "duckdb.summarizeFile",
    async (uri: vscode.Uri) => {
      if (!uri) {
        vscode.window.showWarningMessage("No file selected");
        return;
      }

      const displayPath = getDisplayPath(uri);
      const sql = buildSummarizeFileSql(displayPath);

      // Open new SQL file with the query
      const doc = await vscode.workspace.openTextDocument({
        content: sql,
        language: "sql",
      });
      await vscode.window.showTextDocument(doc);

      // Execute the query
      await vscode.commands.executeCommand("duckdb.executeQuery");
    },
  );

  // Register SQL autocomplete provider (behind experimental setting)
  const completionProvider = vscode.languages.registerCompletionItemProvider(
    "sql",
    {
      async provideCompletionItems(document, position) {
        // Check if autocomplete is enabled
        const config = vscode.workspace.getConfiguration("duckdb");
        if (!config.get<boolean>("autocomplete.enabled", false)) {
          return [];
        }

        try {
          const textUntilCursor = document.getText(
            new vscode.Range(new vscode.Position(0, 0), position),
          );

          const suggestions = await getAutocompleteSuggestions(
            (sql) => db.query(sql),
            textUntilCursor,
          );

          return suggestions.map(({ suggestion, suggestionStart }) => {
            const item = new vscode.CompletionItem(suggestion);

            const kind = inferCompletionKind(suggestion);
            item.kind =
              kind === "keyword"
                ? vscode.CompletionItemKind.Keyword
                : kind === "function"
                  ? vscode.CompletionItemKind.Function
                  : vscode.CompletionItemKind.Field;

            const startPos = document.positionAt(suggestionStart);
            item.range = new vscode.Range(startPos, position);

            return item;
          });
        } catch (error) {
          console.error("🦆 Autocomplete error:", error);
          return [];
        }
      },
    },
    " ",
    ".",
    "(",
    ",",
    "\n",
  );

  // ============================================
  // Database Explorer
  // ============================================

  const databaseExplorer = new DatabaseExplorer(async (sql: string) => {
    const rows = await db.query(sql);
    return { rows };
  });

  const treeView = vscode.window.createTreeView("duckdb.databaseExplorer", {
    treeDataProvider: databaseExplorer,
    showCollapseAll: true,
  });

  const explorerRefreshCmd = vscode.commands.registerCommand(
    "duckdb.explorer.refresh",
    () => {
      databaseExplorer.refresh();
    },
  );

  const explorerSelectTop100Cmd = vscode.commands.registerCommand(
    "duckdb.explorer.selectTop100",
    async (node: ExplorerNode) => {
      if (node.type !== "table" && node.type !== "view") return;

      const schema = node.schema || "main";
      const sql = buildSelectTopSql(node.database!, schema, node.name, 100);

      try {
        const pageSize = getPageSize();
        const result = await db.executeQuery(sql, pageSize);
        showResultsPanel(
          result,
          context,
          `explorer-${node.name}`,
          pageSize,
          getMaxCopyRows(),
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Query failed: ${error}`);
      }
    },
  );

  const explorerDescribeCmd = vscode.commands.registerCommand(
    "duckdb.explorer.describe",
    async (node: ExplorerNode) => {
      if (node.type !== "table" && node.type !== "view") return;

      const schema = node.schema || "main";
      const sql = buildDescribeSql(node.database!, schema, node.name);

      try {
        const pageSize = getPageSize();
        const result = await db.executeQuery(sql, pageSize);
        showResultsPanel(
          result,
          context,
          `describe-${node.name}`,
          pageSize,
          getMaxCopyRows(),
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Describe failed: ${error}`);
      }
    },
  );

  const explorerSummarizeCmd = vscode.commands.registerCommand(
    "duckdb.explorer.summarize",
    async (node: ExplorerNode) => {
      if (node.type !== "table" && node.type !== "view") return;

      const schema = node.schema || "main";
      const sql = buildSummarizeSql(node.database!, schema, node.name);

      try {
        const pageSize = getPageSize();
        const result = await db.executeQuery(sql, pageSize);
        showResultsPanel(
          result,
          context,
          `summarize-${node.name}`,
          pageSize,
          getMaxCopyRows(),
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Summarize failed: ${error}`);
      }
    },
  );

  const explorerViewDefinitionCmd = vscode.commands.registerCommand(
    "duckdb.explorer.viewDefinition",
    async (node: ExplorerNode) => {
      if (node.type !== "table" && node.type !== "view") return;

      const schema = node.schema || "main";
      try {
        let definition: string;
        if (node.type === "view") {
          definition = await getViewDefinition(
            async (sql) => {
              const rows = await db.query(sql);
              return { rows };
            },
            node.database!,
            schema,
            node.name,
          );
        } else {
          definition = await getTableDefinition(
            async (sql) => {
              const rows = await db.query(sql);
              return { rows };
            },
            node.database!,
            schema,
            node.name,
          );
        }

        // Open in new SQL tab
        const doc = await vscode.workspace.openTextDocument({
          content: definition,
          language: "sql",
        });
        await vscode.window.showTextDocument(doc);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to get definition: ${error}`);
      }
    },
  );

  const explorerCopyNameCmd = vscode.commands.registerCommand(
    "duckdb.explorer.copyName",
    async (node: ExplorerNode) => {
      let name = node.name;
      if (node.type === "column") {
        const schema = node.schema || "main";
        name = `"${node.database}"."${schema}"."${node.tableName}"."${node.name}"`;
      } else if (node.type === "table" || node.type === "view") {
        const schema = node.schema || "main";
        name = `"${node.database}"."${schema}"."${node.name}"`;
      } else if (node.type === "schema") {
        name = `"${node.database}"."${node.name}"`;
      } else if (node.type === "database") {
        name = `"${node.name}"`;
      }
      await vscode.env.clipboard.writeText(name);
      vscode.window.showInformationMessage(`Copied: ${name}`);
    },
  );

  const explorerSelectColumnCmd = vscode.commands.registerCommand(
    "duckdb.explorer.selectColumn",
    async (node: ExplorerNode) => {
      if (node.type !== "column") return;

      const schema = node.schema || "main";
      const sql = `SELECT "${node.name}" FROM "${node.database}"."${schema}"."${node.tableName}" LIMIT 100`;

      try {
        const pageSize = getPageSize();
        const result = await db.executeQuery(sql, pageSize);
        showResultsPanel(
          result,
          context,
          `explorer-col-${node.tableName}-${node.name}`,
          pageSize,
          getMaxCopyRows(),
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Query failed: ${error}`);
      }
    },
  );

  const explorerDropCmd = vscode.commands.registerCommand(
    "duckdb.explorer.drop",
    async (node: ExplorerNode) => {
      if (node.type !== "table" && node.type !== "view") return;

      const objectType = node.type === "table" ? "TABLE" : "VIEW";
      const schema = node.schema || "main";

      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to drop ${objectType} ${node.name}?`,
        { modal: true },
        "Drop",
      );

      if (confirm === "Drop") {
        try {
          await dropObject(
            (sql) => db.run(sql),
            objectType,
            node.database!,
            schema,
            node.name,
          );
          databaseExplorer.refresh();
          vscode.window.showInformationMessage(
            `Dropped ${objectType} ${node.name}`,
          );
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to drop: ${error}`);
        }
      }
    },
  );

  // Database management commands
  const explorerUseDatabaseCmd = vscode.commands.registerCommand(
    "duckdb.explorer.useDatabase",
    async (node: ExplorerNode) => {
      if (node.type !== "database") return;

      try {
        await switchDatabase(async (sql) => db.run(sql), node.name);
        await setDefaultDatabase(node.name);
        currentDatabase = node.name;
        updateStatusBar();
        databaseExplorer.refresh();
        vscode.window.showInformationMessage(
          `Now using database: ${node.name}`,
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to switch database: ${error}`);
      }
    },
  );

  const explorerAttachDatabaseCmd = vscode.commands.registerCommand(
    "duckdb.explorer.attachDatabase",
    async () => {
      // Reuse the existing selectDatabase command which has attach functionality
      await vscode.commands.executeCommand("duckdb.selectDatabase");
      databaseExplorer.refresh();
    },
  );

  const explorerDetachDatabaseCmd = vscode.commands.registerCommand(
    "duckdb.explorer.detachDatabase",
    async (node: ExplorerNode) => {
      if (node.type !== "database") return;
      if (node.name === "memory") {
        vscode.window.showWarningMessage(
          "Cannot detach the default memory database",
        );
        return;
      }

      try {
        // Detach from DuckDB
        await detachDatabase(async (sql) => db.run(sql), node.name);

        // Update settings to mark as detached (don't remove)
        await updateDatabaseAttachedState(node.name, false);

        // If this was the current database, switch to memory
        if (node.name === currentDatabase) {
          currentDatabase = "memory";
        }

        databaseExplorer.refresh();
        updateStatusBar();
        vscode.window.showInformationMessage(`Detached database: ${node.name}`);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to detach database: ${error}`);
      }
    },
  );

  // Reattach a detached database (prompts for read-only mode for file databases)
  const explorerReattachDatabaseCmd = vscode.commands.registerCommand(
    "duckdb.explorer.reattachDatabase",
    async (node: ExplorerNode, forceReadOnly?: boolean) => {
      if (node.type !== "database-detached") return;

      // Find the config for this database
      const configs = getConfiguredDatabases();
      const config = configs.find((c) => c.alias === node.name);

      if (!config) {
        vscode.window.showErrorMessage(
          `No configuration found for database: ${node.name}`,
        );
        return;
      }

      // For file databases, ask about read-only mode (unless forced)
      let readOnly = config.readOnly ?? false;
      if (config.type === "file" && forceReadOnly === undefined) {
        const readOnlyChoice = await vscode.window.showQuickPick(
          [
            {
              label: "Read & Write",
              description: "Full access to database",
              readOnly: false,
            },
            {
              label: "Read Only",
              description: "No modifications allowed",
              readOnly: true,
            },
          ],
          { placeHolder: "Select access mode" },
        );

        if (!readOnlyChoice) return; // User cancelled
        readOnly = readOnlyChoice.readOnly;
      } else if (forceReadOnly !== undefined) {
        readOnly = forceReadOnly;
      }

      try {
        const workspaceRoot =
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
        const runFn = (sql: string) => db.run(sql);

        // Attach based on type
        switch (config.type) {
          case "memory":
            await attachMemoryDatabase(runFn, config.alias);
            break;
          case "file":
            if (config.path) {
              const filePath = config.path.startsWith("/")
                ? config.path
                : path.join(workspaceRoot, config.path);
              await attachDatabase(runFn, filePath, config.alias, readOnly);
            }
            break;
          case "manual":
            if (config.sql) {
              await runManualSql(runFn, config.sql);
            }
            break;
        }

        // Update settings to mark as attached and save readOnly state
        await updateDatabaseAttachedState(node.name, true);
        if (config.type === "file" && readOnly !== config.readOnly) {
          await updateDatabaseReadOnlyState(node.name, readOnly);
        }

        databaseExplorer.refresh();
        const modeLabel = readOnly ? " (read-only)" : "";
        vscode.window.showInformationMessage(
          `Attached database: ${node.name}${modeLabel}`,
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to attach database: ${error}`);
      }
    },
  );

  // Forget a database (remove from settings completely)
  const explorerForgetDatabaseCmd = vscode.commands.registerCommand(
    "duckdb.explorer.forgetDatabase",
    async (node: ExplorerNode) => {
      if (node.type !== "database-detached") return;

      const confirm = await vscode.window.showWarningMessage(
        `Remove "${node.name}" from workspace settings?`,
        { modal: true },
        "Remove",
      );

      if (confirm === "Remove") {
        try {
          await removeDatabaseFromSettings(node.name);
          databaseExplorer.refresh();
          vscode.window.showInformationMessage(
            `Removed database configuration: ${node.name}`,
          );
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to remove database: ${error}`);
        }
      }
    },
  );

  // New Schema command - creates directly
  const explorerNewSchemaCmd = vscode.commands.registerCommand(
    "duckdb.explorer.newSchema",
    async (node: ExplorerNode) => {
      if (node.type !== "database") return;

      const schemaName = await vscode.window.showInputBox({
        prompt: "Enter schema name",
        placeHolder: "my_schema",
        validateInput: (value) => {
          if (!value || !value.trim()) return "Schema name is required";
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value))
            return "Invalid schema name";
          return null;
        },
      });

      if (!schemaName) return;

      try {
        await createSchema((sql) => db.run(sql), node.name, schemaName);
        databaseExplorer.refresh();
        vscode.window.showInformationMessage(
          `Created schema: ${node.name}.${schemaName}`,
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to create schema: ${error}`);
      }
    },
  );

  // New Table command - opens boilerplate
  const explorerNewTableCmd = vscode.commands.registerCommand(
    "duckdb.explorer.newTable",
    async (node: ExplorerNode) => {
      const database = node.database || node.name;
      const schema = node.type === "schema" ? node.name : node.schema || "main";

      const sql = buildNewTableBoilerplate(database, schema);

      const doc = await vscode.workspace.openTextDocument({
        content: sql,
        language: "sql",
      });
      await vscode.window.showTextDocument(doc);
    },
  );

  // New View command - opens boilerplate
  const explorerNewViewCmd = vscode.commands.registerCommand(
    "duckdb.explorer.newView",
    async (node: ExplorerNode) => {
      const database = node.database || node.name;
      const schema = node.type === "schema" ? node.name : node.schema || "main";

      const sql = buildNewViewBoilerplate(database, schema);

      const doc = await vscode.workspace.openTextDocument({
        content: sql,
        language: "sql",
      });
      await vscode.window.showTextDocument(doc);
    },
  );

  // ============================================
  // Query History Explorer
  // ============================================

  const historyExplorer = new HistoryExplorer();

  const historyTreeView = vscode.window.createTreeView("duckdb.queryHistory", {
    treeDataProvider: historyExplorer,
    showCollapseAll: true,
  });

  const historyRefreshCmd = vscode.commands.registerCommand(
    "duckdb.history.refresh",
    () => {
      historyExplorer.refresh();
    },
  );

  const historyRunAgainCmd = vscode.commands.registerCommand(
    "duckdb.history.runAgain",
    async (node: HistoryNode) => {
      if (node.type !== "query" || !node.entry) return;

      try {
        const pageSize = getPageSize();
        const result = await db.executeQuery(node.entry.sql, pageSize);
        showResultsPanel(
          result,
          context,
          `history-${node.entry.id}`,
          pageSize,
          getMaxCopyRows(),
        );

        // Update history with new execution
        const dbName = await getCurrentDatabase(async (s) => ({
          rows: await db.query(s),
        }));
        const lastStmt = result.statements[result.statements.length - 1];
        await getHistoryService().addEntry({
          sql: node.entry.sql,
          executedAt: new Date(),
          durationMs: result.totalExecutionTime,
          rowCount: lastStmt?.meta.totalRows || 0,
          columnCount: lastStmt?.meta.columns.length || 0,
          error: null,
          databaseName: dbName,
          sourceFile: null,
        });
      } catch (error) {
        vscode.window.showErrorMessage(`Query failed: ${error}`);
      }
    },
  );

  const historyOpenInEditorCmd = vscode.commands.registerCommand(
    "duckdb.history.openInEditor",
    async (node: HistoryNode) => {
      if (node.type !== "query" || !node.entry) return;

      const doc = await vscode.workspace.openTextDocument({
        content: node.entry.sql,
        language: "sql",
      });
      await vscode.window.showTextDocument(doc);
    },
  );

  const historyCopySqlCmd = vscode.commands.registerCommand(
    "duckdb.history.copySql",
    async (node: HistoryNode) => {
      if (node.type !== "query" || !node.entry) return;

      await vscode.env.clipboard.writeText(node.entry.sql);
      vscode.window.showInformationMessage("SQL copied to clipboard");
    },
  );

  const historyDeleteCmd = vscode.commands.registerCommand(
    "duckdb.history.delete",
    async (node: HistoryNode) => {
      if (node.type !== "query" || !node.entry) return;

      await getHistoryService().deleteEntry(node.entry.id);
    },
  );

  const historyClearAllCmd = vscode.commands.registerCommand(
    "duckdb.history.clearAll",
    async () => {
      const confirm = await vscode.window.showWarningMessage(
        "Clear all query history?",
        { modal: true },
        "Clear",
      );

      if (confirm === "Clear") {
        await getHistoryService().clearAll();
        vscode.window.showInformationMessage("Query history cleared");
      }
    },
  );

  // ============================================
  // Extensions Explorer
  // ============================================

  const extensionsExplorer = new ExtensionsExplorer(async (sql: string) => {
    const rows = await db.query(sql);
    return { rows };
  });

  const extensionsTreeView = vscode.window.createTreeView("duckdb.extensions", {
    treeDataProvider: extensionsExplorer,
  });

  const extensionsRefreshCmd = vscode.commands.registerCommand(
    "duckdb.extensions.refresh",
    () => {
      extensionsExplorer.refresh();
    },
  );

  const extensionsAddCmd = vscode.commands.registerCommand(
    "duckdb.extensions.add",
    async () => {
      // Reuse the existing manageExtensions logic
      await showExtensionsQuickPick(db);
      extensionsExplorer.refresh();
    },
  );

  const extensionsUnloadCmd = vscode.commands.registerCommand(
    "duckdb.extensions.unload",
    async (node: ExtensionNode) => {
      if (node.type !== "extension") return;

      await removeExtensionFromSettings(node.name);
      vscode.window.showInformationMessage(
        `Removed ${node.name} from auto-load. Restart VS Code to unload.`,
      );
      extensionsExplorer.refresh();
    },
  );

  // Register SQL CodeLens provider for run actions
  registerSqlCodeLens(context);

  // Register "Go to Source" command for results panel
  const goToSourceCmd = vscode.commands.registerCommand(
    "duckdb.results.goToSource",
    async () => {
      const sourceUri = getActiveResultsSourceUri();
      if (sourceUri) {
        try {
          // First check if there's already a visible editor for this file
          const existingEditor = vscode.window.visibleTextEditors.find(
            (editor) => editor.document.uri.toString() === sourceUri.toString(),
          );

          if (existingEditor) {
            // Reveal the existing editor
            await vscode.window.showTextDocument(existingEditor.document, {
              viewColumn: existingEditor.viewColumn,
              preserveFocus: false,
            });
          } else {
            // Open the document (will reuse existing tab if any)
            const doc = await vscode.workspace.openTextDocument(sourceUri);
            await vscode.window.showTextDocument(doc, { preserveFocus: false });
          }
        } catch (error) {
          vscode.window.showErrorMessage(
            `Could not open source file: ${error}`,
          );
        }
      } else {
        vscode.window.showInformationMessage(
          "No source file associated with this results panel",
        );
      }
    },
  );

  context.subscriptions.push(
    executeCmd,
    runStatementCmd,
    selectDbCmd,
    manageExtCmd,
    queryFileCmd,
    copyQueryCmd,
    summarizeFileCmd,
    completionProvider,
    treeView,
    explorerRefreshCmd,
    explorerSelectTop100Cmd,
    explorerDescribeCmd,
    explorerSummarizeCmd,
    explorerViewDefinitionCmd,
    explorerCopyNameCmd,
    explorerSelectColumnCmd,
    explorerDropCmd,
    explorerUseDatabaseCmd,
    explorerAttachDatabaseCmd,
    explorerDetachDatabaseCmd,
    explorerReattachDatabaseCmd,
    explorerForgetDatabaseCmd,
    explorerNewSchemaCmd,
    explorerNewTableCmd,
    explorerNewViewCmd,
    historyTreeView,
    historyRefreshCmd,
    historyRunAgainCmd,
    historyOpenInEditorCmd,
    historyCopySqlCmd,
    historyDeleteCmd,
    historyClearAllCmd,
    extensionsTreeView,
    extensionsRefreshCmd,
    extensionsAddCmd,
    extensionsUnloadCmd,
    goToSourceCmd,
  );
}

export async function deactivate() {
  await disposeDuckDBService();
}

/**
 * Auto-attach databases from workspace settings
 * Only attaches databases that were attached last session (attached !== false)
 */
async function autoAttachDatabases(
  db: ReturnType<typeof getDuckDBService>,
): Promise<void> {
  const config = getWorkspaceConfig();
  const databases = config.get<DatabaseConfig[]>("databases", []);
  const defaultDb = config.get<string>("defaultDatabase", "memory");

  if (databases.length === 0) {
    return;
  }

  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
  const runFn = (sql: string) => db.run(sql);
  let attachedCount = 0;
  let skippedCount = 0;

  for (const dbConfig of databases) {
    // Only attach if it was attached last session (attached defaults to true for backward compat)
    if (dbConfig.attached === false) {
      console.log(`🦆 Skipping "${dbConfig.alias}" (was detached)`);
      skippedCount++;
      continue;
    }

    try {
      switch (dbConfig.type) {
        case "memory":
          // In-memory databases are implicit, but we can create named ones
          if (dbConfig.alias && dbConfig.alias !== "memory") {
            await attachMemoryDatabase(runFn, dbConfig.alias);
          }
          attachedCount++;
          break;

        case "file": {
          if (!dbConfig.path) {
            vscode.window.showWarningMessage(
              `DuckDB: Database "${dbConfig.alias}" missing path`,
            );
            continue;
          }

          // Resolve relative paths from workspace root
          const filePath = path.isAbsolute(dbConfig.path)
            ? dbConfig.path
            : path.resolve(workspaceRoot, dbConfig.path);

          // Check if file exists
          try {
            await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
          } catch {
            vscode.window.showErrorMessage(
              `DuckDB: Database file not found: ${dbConfig.path}`,
            );
            // Mark as detached since we couldn't attach it
            await updateDatabaseAttachedState(dbConfig.alias, false);
            continue;
          }

          await attachDatabase(
            runFn,
            filePath,
            dbConfig.alias,
            dbConfig.readOnly,
          );
          attachedCount++;
          break;
        }

        case "manual": {
          if (!dbConfig.sql) {
            vscode.window.showWarningMessage(
              `DuckDB: Database "${dbConfig.alias}" missing sql`,
            );
            continue;
          }
          await runManualSql(runFn, dbConfig.sql);
          attachedCount++;
          break;
        }

        default:
          vscode.window.showWarningMessage(
            `DuckDB: Unknown database type for "${dbConfig.alias}"`,
          );
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `DuckDB: Failed to attach "${dbConfig.alias}": ${error}`,
      );
      // Mark as detached since we couldn't attach it
      await updateDatabaseAttachedState(dbConfig.alias, false);
    }
  }

  // Switch to default database (only if it's attached)
  if (defaultDb && defaultDb !== "memory") {
    try {
      await switchDatabase(runFn, defaultDb);
      currentDatabase = defaultDb;
    } catch (error) {
      // Default database might not be attached, that's okay
      console.log(
        `🦆 Could not switch to default database "${defaultDb}": ${error}`,
      );
    }
  }

  if (attachedCount > 0 || skippedCount > 0) {
    console.log(
      `🦆 Auto-attached ${attachedCount} database(s), skipped ${skippedCount}`,
    );
  }
}

interface DatabaseConfig {
  alias: string;
  type: "memory" | "file" | "manual";
  path?: string;
  readOnly?: boolean;
  sql?: string;
  attached?: boolean; // Attach on startup based on last state (default true)
}

/**
 * Auto-load extensions from workspace settings
 */
async function autoLoadExtensions(
  db: ReturnType<typeof getDuckDBService>,
): Promise<void> {
  const config = getWorkspaceConfig();
  const extensions = config.get<string[]>("extensions", []);

  if (extensions.length === 0) {
    return;
  }

  const runFn = (sql: string) => db.run(sql);
  let loadedCount = 0;

  for (const ext of extensions) {
    try {
      await installAndLoadExtension(runFn, ext);
      loadedCount++;
    } catch (error) {
      vscode.window.showWarningMessage(
        `DuckDB: Failed to load extension "${ext}": ${error}`,
      );
    }
  }

  if (loadedCount > 0) {
    console.log(`🦆 Auto-loaded ${loadedCount} extension(s)`);
  }
}

/**
 * Show quick pick for managing extensions
 */
async function showExtensionsQuickPick(
  db: ReturnType<typeof getDuckDBService>,
): Promise<void> {
  const config = getWorkspaceConfig();
  const enabledExtensions = config.get<string[]>("extensions", []);

  // Get currently loaded extensions
  let loadedExtensions: string[] = [];
  try {
    loadedExtensions = await getLoadedExtensionsFromService((sql) =>
      db.query(sql),
    );
  } catch {
    // Ignore errors
  }

  // Build items with checkmarks for enabled ones
  const items: (vscode.QuickPickItem & { action: string; extName?: string })[] =
    [
      {
        label: "Currently enabled extensions",
        kind: vscode.QuickPickItemKind.Separator,
        action: "none",
      },
    ];

  if (enabledExtensions.length === 0) {
    items.push({ label: "  (none configured)", action: "none" });
  } else {
    for (const ext of enabledExtensions) {
      const isLoaded = loadedExtensions.includes(ext);
      items.push({
        label: `$(check) ${ext}`,
        description: isLoaded ? "loaded" : "will load on restart",
        action: "remove",
        extName: ext,
      });
    }
  }

  items.push(
    { label: "", kind: vscode.QuickPickItemKind.Separator, action: "none" },
    {
      label: "Add Extension",
      kind: vscode.QuickPickItemKind.Separator,
      action: "none",
    },
  );

  // Add common extensions (excluding already enabled)
  for (const ext of COMMON_EXTENSIONS) {
    if (!enabledExtensions.includes(ext.name)) {
      items.push({
        label: ext.name,
        description: ext.description,
        action: "add",
        extName: ext.name,
      });
    }
  }

  items.push({
    label: "$(edit) Other...",
    description: "Enter a custom extension name",
    action: "custom",
  });

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: "🦆 Manage Extensions",
  });

  if (!selected || selected.action === "none") return;

  const runFn = (sql: string) => db.run(sql);

  switch (selected.action) {
    case "add": {
      if (selected.extName) {
        await addExtensionToSettings(selected.extName);
        // Try to load immediately
        try {
          await installAndLoadExtension(runFn, selected.extName);
          vscode.window.showInformationMessage(
            `🦆 Loaded extension: ${selected.extName}`,
          );
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to load extension: ${error}`);
        }
      }
      break;
    }

    case "remove": {
      if (selected.extName) {
        await removeExtensionFromSettings(selected.extName);
        vscode.window.showInformationMessage(
          `🦆 Removed extension: ${selected.extName} (restart to unload)`,
        );
      }
      break;
    }

    case "custom": {
      const extName = await vscode.window.showInputBox({
        prompt: "Enter extension name",
        placeHolder: "e.g., httpfs, postgres, spatial",
      });
      if (extName) {
        await addExtensionToSettings(extName);
        try {
          await installAndLoadExtension(runFn, extName);
          vscode.window.showInformationMessage(
            `🦆 Loaded extension: ${extName}`,
          );
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to load extension: ${error}`);
        }
      }
      break;
    }
  }
}

/**
 * Add an extension to workspace settings
 */
/**
 * Update the status bar with current database info
 */
function updateStatusBar() {
  const displayName =
    currentDatabase === "memory" ? ":memory:" : currentDatabase;
  statusBarItem.text = `$(database) ${displayName}`;
  statusBarItem.tooltip = `DuckDB: ${displayName}\nClick to switch database`;
}

interface DatabasePickItem extends vscode.QuickPickItem {
  action:
    | "switch"
    | "create"
    | "attach"
    | "reattach"
    | "detach"
    | "forget"
    | "none";
  databaseName?: string;
}
