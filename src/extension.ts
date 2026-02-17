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
  getStatementType,
} from "./services/duckdb";
import {
  showResultsPanel,
  disposeAllPanels,
  getActiveResultsSourceUri,
  getActiveResultsQueries,
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
import {
  registerSqlCodeLens,
  SqlCodeLensProvider,
  setGetCurrentDatabase,
  setGetCachedResultsForDoc,
  parseSqlStatements,
} from "./providers/SqlCodeLensProvider";
import {
  ResultDocumentProvider,
  RESULTS_SCHEME,
} from "./providers/ResultDocumentProvider";
import {
  cacheResult,
  getCachedResult,
  getCachedResultsForDoc,
} from "./services/resultCacheService";
import {
  switchDatabase,
  detachDatabase,
  attachDatabase,
  setDefaultDatabase,
  removeDatabaseFromSettings,
  removeExtensionFromAutoLoad,
  addDatabaseToSettings,
  addExtensionToAutoLoad,
  getAutoLoadExtensions,
  migrateExtensionsSetting,
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
  addIgnoredSchema,
  getIgnoredSchemas,
  getSchemas,
  getTables,
  getAttachedDatabases,
} from "./services/databaseManager";
import { getAutocompleteSuggestions } from "./services/autocompleteService";
import {
  installAndLoadExtension,
  isExtensionLoaded,
  getLoadedExtensions as getLoadedExtensionsFromService,
  COMMON_EXTENSIONS,
} from "./services/extensionsService";
import { registerSqlFormatter } from "./providers/SqlFormattingProvider";
import {
  DataFileEditorProvider,
  syncEditorAssociations,
} from "./providers/DataFileEditorProvider";
import {
  showExecutionDecorations,
  showErrorDecoration,
  showLoadingDecoration,
  clearLoadingDecoration,
  mapStatementsToLines,
  disposeDecorations,
} from "./services/inlineDecorationService";

// Current database state
let currentDatabase = "memory";
let statusBarItem: vscode.StatusBarItem;
let codeLensProvider: SqlCodeLensProvider | undefined;

// Diagnostic collection for SQL errors
let diagnosticCollection: vscode.DiagnosticCollection;

/**
 * Show a DuckDB error as a VS Code diagnostic (inline error in editor)
 */
function showErrorDiagnostic(
  document: vscode.TextDocument,
  error: DuckDBError,
  sqlStartOffset: number = 0
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
      Math.min(line, document.lineCount - 1)
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
    vscode.DiagnosticSeverity.Error
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

// ============================================================================
// Shared helpers for inline execution feedback
// ============================================================================

/**
 * Show inline success decorations for non-result (DDL/DML) statements.
 */
function showSuccessDecorations(
  editor: vscode.TextEditor,
  sql: string,
  sqlStartOffset: number,
  statements: Array<{
    meta: { sql: string; executionTime: number; hasResults: boolean };
  }>
): void {
  const nonResultStmts = statements.filter((s) => !s.meta.hasResults);
  if (nonResultStmts.length === 0) {
    return;
  }
  const decorationResults = mapStatementsToLines(
    sql,
    sqlStartOffset,
    nonResultStmts,
    editor.document
  );
  showExecutionDecorations(editor, decorationResults);
}

/**
 * Compute the editor line for a DuckDB error, using the best available info.
 */
function computeErrorLine(
  errInfo: DuckDBError,
  document: vscode.TextDocument,
  sqlStartOffset: number,
  fallbackLine: number
): number {
  if (errInfo.line !== undefined) {
    return Math.max(0, errInfo.line - 1); // 1-indexed → 0-indexed
  }
  if (errInfo.position !== undefined) {
    return document.positionAt(sqlStartOffset + errInfo.position).line;
  }
  return fallbackLine;
}

/**
 * Handle a DuckDBQueryError: show diagnostic, notification, inline error
 * decoration, and success decorations for any partially completed statements.
 */
function handleDuckDBError(
  error: DuckDBQueryError,
  editor: vscode.TextEditor,
  sql: string,
  sqlStartOffset: number,
  fallbackLine: number
): void {
  const errInfo = error.duckdbError;

  showErrorDiagnostic(editor.document, errInfo, sqlStartOffset);
  vscode.window.showErrorMessage(
    `DuckDB ${errInfo.type} Error: ${errInfo.message}`
  );

  // Inline error decoration
  const errorLine = computeErrorLine(
    errInfo,
    editor.document,
    sqlStartOffset,
    fallbackLine
  );
  showErrorDecoration(editor, errorLine, errInfo.type, errInfo.message);

  // Success decorations for statements that completed before the error
  if (error.partialResults) {
    showSuccessDecorations(
      editor,
      sql,
      sqlStartOffset,
      error.partialResults.statements
    );
  }
}

export async function activate(context: vscode.ExtensionContext) {
  console.log("🦆 DuckDB extension is now active!");

  // Create diagnostic collection for SQL errors
  diagnosticCollection = vscode.languages.createDiagnosticCollection("duckdb");
  context.subscriptions.push(diagnosticCollection);

  // Initialize DuckDB on activation
  const db = getDuckDBService();
  try {
    const duckdbConfig = vscode.workspace.getConfiguration("duckdb");
    const memoryLimit = duckdbConfig.get<string>("memoryLimit", "1.5GB");
    const maxTempDirectorySize = duckdbConfig.get<string>(
      "maxTempDirectorySize",
      "15GB"
    );
    const tempDirectory =
      duckdbConfig.get<string>("tempDirectory", "") || undefined;
    await db.initialize({ memoryLimit, maxTempDirectorySize, tempDirectory });

    // Change process working directory to workspace root
    // This affects DuckDB's file path autocomplete
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
      console.log("🦆 Changing working directory to:", workspaceRoot);
      process.chdir(workspaceRoot);
    }

    // Load autocomplete extension (required for SQL completions)
    await installAndLoadExtension((sql) => db.run(sql), "autocomplete");
    // Migrate legacy setting name if needed
    await migrateExtensionsSetting();
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
    50
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
  const getDefaultRowLimit = () =>
    vscode.workspace
      .getConfiguration("duckdb")
      .get<number>("explorer.defaultRowLimit", 1000);

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

      // Show loading indicator
      const loadingLine = selection.isEmpty ? 0 : editor.selection.start.line;
      const docUri = editor.document.uri.toString();
      showLoadingDecoration(editor, [loadingLine]);
      codeLensProvider?.setRunningAll(docUri);

      try {
        const result = await db.executeQuery(sql, pageSize);
        clearLoadingDecoration();
        codeLensProvider?.clearRunningAll(docUri);

        const sourceId = docUri;
        showResultsPanel(result, context, sourceId, pageSize, getMaxCopyRows());
        showSuccessDecorations(editor, sql, sqlStartOffset, result.statements);

        // Cache results for peek preview
        cacheStatementsForPeek(
          editor.document,
          sql,
          sqlStartOffset,
          result.statements
        );
        codeLensProvider?.refresh();

        // Record in history - use totals from all statements
        const dbName = await getCurrentDatabase(async (s) => ({
          rows: await db.query(s),
        }));
        const lastStmt = result.statements[result.statements.length - 1];
        const totalRows = result.statements.reduce(
          (sum, s) => sum + s.meta.totalRows,
          0
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

        // Auto-refresh explorer if any statement was DDL/DML (CREATE, DROP, ALTER, INSERT, etc.)
        const hasSchemaChange = result.statements.some(
          (s) => getStatementType(s.meta.sql) === "command"
        );
        if (hasSchemaChange) {
          databaseExplorer.refresh();
        }
      } catch (error) {
        clearLoadingDecoration();
        codeLensProvider?.clearRunningAll(docUri);

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

        if (error instanceof DuckDBQueryError) {
          const fallbackLine = editor.selection.isEmpty
            ? 0
            : editor.selection.start.line;
          handleDuckDBError(error, editor, sql, sqlStartOffset, fallbackLine);
        } else {
          console.log("🦆 Non-DuckDB Error:", error);
          vscode.window.showErrorMessage(`${error}`);
        }
      }
    }
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
      const docUri = uri.toString();

      // Show loading indicator on the statement's first line
      const loadingLine = document.positionAt(startOffset).line;
      const activeEditorForLoading = vscode.window.activeTextEditor;
      if (
        activeEditorForLoading &&
        activeEditorForLoading.document.uri.toString() === docUri
      ) {
        showLoadingDecoration(activeEditorForLoading, [loadingLine]);
      }
      codeLensProvider?.setRunning(docUri, startOffset);

      try {
        const result = await db.executeQuery(sql, pageSize);
        clearLoadingDecoration();
        codeLensProvider?.clearRunning(docUri, startOffset);

        const sourceId = docUri;
        showResultsPanel(result, context, sourceId, pageSize, getMaxCopyRows());

        // Show inline decorations for non-result statements (DDL/DML)
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.uri.toString() === docUri) {
          showSuccessDecorations(
            activeEditor,
            sql,
            startOffset,
            result.statements
          );
        }

        // Cache results for peek preview
        cacheStatementsForPeek(document, sql, startOffset, result.statements);
        codeLensProvider?.refresh();

        // Record in history
        const dbName = await getCurrentDatabase(async (s) => ({
          rows: await db.query(s),
        }));
        const lastStmt = result.statements[result.statements.length - 1];
        const totalRows = result.statements.reduce(
          (sum, s) => sum + s.meta.totalRows,
          0
        );
        await getHistoryService().addEntry({
          sql,
          executedAt: new Date(),
          durationMs: result.totalExecutionTime,
          rowCount: totalRows,
          columnCount: lastStmt?.meta.columns.length || 0,
          error: null,
          databaseName: dbName,
          sourceFile: docUri,
        });

        updateStatusBar();

        // Auto-refresh explorer if any statement was DDL/DML
        const hasSchemaChange = result.statements.some(
          (s) => getStatementType(s.meta.sql) === "command"
        );
        if (hasSchemaChange) {
          databaseExplorer.refresh();
        }
      } catch (error) {
        clearLoadingDecoration();
        codeLensProvider?.clearRunning(docUri, startOffset);

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
          sourceFile: docUri,
        });

        if (error instanceof DuckDBQueryError) {
          const activeEditor = vscode.window.activeTextEditor;
          if (activeEditor && activeEditor.document.uri.toString() === docUri) {
            const fallbackLine = document.positionAt(startOffset).line;
            handleDuckDBError(
              error,
              activeEditor,
              sql,
              startOffset,
              fallbackLine
            );
          } else {
            // No matching editor — still show diagnostic + notification
            showErrorDiagnostic(document, error.duckdbError, startOffset);
            vscode.window.showErrorMessage(
              `DuckDB ${error.duckdbError.type} Error: ${error.duckdbError.message}`
            );
          }
        } else {
          console.log("🦆 Non-DuckDB Error (statement):", error);
          vscode.window.showErrorMessage(`${error}`);
        }
      }
    }
  );

  // Register Run Statement at Cursor command (keybinding: Cmd+Shift+Enter)
  const runStatementAtCursorCmd = vscode.commands.registerCommand(
    "duckdb.runStatementAtCursor",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== "sql") {
        vscode.window.showWarningMessage(
          "No active SQL editor. Open a .sql file first."
        );
        return;
      }

      const document = editor.document;
      const text = document.getText();
      const statements = parseSqlStatements(text);

      if (statements.length === 0) {
        vscode.window.showWarningMessage("No SQL statements found in file");
        return;
      }

      // Find the statement that contains the cursor
      const cursorOffset = document.offsetAt(editor.selection.active);
      let target = statements[0]; // fallback to first

      for (const stmt of statements) {
        // Use a generous range: from statement start to its end (including trailing whitespace up to next statement)
        if (
          cursorOffset >= stmt.startOffset &&
          cursorOffset <= stmt.endOffset
        ) {
          target = stmt;
          break;
        }
        // If cursor is between statements (in whitespace after semicolon), pick the previous one
        if (stmt.endOffset < cursorOffset) {
          target = stmt;
        }
      }

      // Delegate to the existing runStatement command
      await vscode.commands.executeCommand(
        "duckdb.runStatement",
        document.uri,
        target.startOffset,
        target.endOffset
      );
    }
  );

  // ── Peek state ─────────────────────────────────────────────────────
  /** Tracks which document + line has the active peek */
  let activePeekDocUri: string | undefined;
  let activePeekLine: number | undefined;

  // ── Live Peek state ──────────────────────────────────────────────────
  let livePeekTimer: ReturnType<typeof setTimeout> | undefined;
  let livePeekDisposable: vscode.Disposable | undefined;
  let livePeekDocUri: string | undefined;
  const getLivePeekDebounceMs = () =>
    vscode.workspace
      .getConfiguration("duckdb")
      .get<number>("peekResults.debounceMs", 600);

  // ── HTTP safety guard state ───────────────────────────────────────────
  let httpWarningShown = false;
  let httpBypassCheck = false;
  /** Cache the cache_httpfs loaded state (refreshed once per peek session) */
  let cacheHttpfsLoaded: boolean | undefined;

  /**
   * Check if SQL contains remote HTTP/S3/cloud URLs that would trigger
   * network requests on every execution.
   */
  function sqlContainsRemoteSource(sql: string): boolean {
    return /https?:\/\/|s3:\/\/|s3a:\/\/|s3n:\/\/|gcs:\/\/|gs:\/\/|az:\/\/|abfss:\/\//i.test(
      sql
    );
  }

  /**
   * Check if cache_httpfs is loaded (with session-level caching).
   */
  async function isCacheHttpfsLoaded(): Promise<boolean> {
    if (cacheHttpfsLoaded !== undefined) return cacheHttpfsLoaded;
    try {
      cacheHttpfsLoaded = await isExtensionLoaded(
        (sql) => db.query(sql),
        "cache_httpfs"
      );
    } catch {
      cacheHttpfsLoaded = false;
    }
    return cacheHttpfsLoaded;
  }

  /**
   * Show a one-time notification recommending cache_httpfs for HTTP queries.
   * Returns true if the user chose to continue anyway.
   */
  async function showHttpCacheWarning(): Promise<boolean> {
    if (httpWarningShown) return httpBypassCheck;
    httpWarningShown = true;

    const choice = await vscode.window.showWarningMessage(
      "Live preview paused: queries with HTTP/S3 sources can cause rate limiting without caching. " +
        "Install the cache_httpfs extension to cache HTTP responses locally.",
      "Install cache_httpfs",
      "Continue Anyway"
    );

    if (choice === "Install cache_httpfs") {
      try {
        await installAndLoadExtension((sql) => db.run(sql), "cache_httpfs");
        await addExtensionToAutoLoad("cache_httpfs");
        cacheHttpfsLoaded = true;
        vscode.window.showInformationMessage(
          "cache_httpfs installed, loaded, and added to auto-load."
        );
        return true;
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to install cache_httpfs: ${error}`
        );
        return false;
      }
    } else if (choice === "Continue Anyway") {
      httpBypassCheck = true;
      return true;
    }

    return false;
  }

  /**
   * Execute a statement and push the result into the active peek slot.
   * Always uses the same stable virtual URI so the peek view can be
   * refreshed in-place even when the statement offset changes.
   */
  async function executeAndPeek(
    uri: vscode.Uri,
    startOffset: number,
    endOffset: number
  ): Promise<vscode.Uri | undefined> {
    const docUri = uri.toString();
    const document = await vscode.workspace.openTextDocument(uri);
    const sql = document.getText().slice(startOffset, endOffset).trim();
    if (!sql) return undefined;

    try {
      const pageSize = getPageSize();
      const result = await db.executeQuery(sql, pageSize);

      if (result.statements.length > 0) {
        const stmt = result.statements[0];
        // Also keep in the per-statement cache (for CodeLens indicators)
        cacheResult(docUri, startOffset, stmt.meta, stmt.page);
        const cached = getCachedResult(docUri, startOffset);
        if (cached) {
          return resultDocProvider.setActivePeekResult(cached);
        }
      }
    } catch (error) {
      return resultDocProvider.setActivePeekError(String(error));
    }

    return undefined;
  }

  /**
   * Start live peek mode — watches for document changes and auto-refreshes.
   */
  function startLivePeek(uri: vscode.Uri): void {
    stopLivePeek(); // Clean up any previous session
    livePeekDocUri = uri.toString();

    livePeekDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== livePeekDocUri) return;
      if (e.contentChanges.length === 0) return;

      // Debounce
      if (livePeekTimer) clearTimeout(livePeekTimer);
      livePeekTimer = setTimeout(() => {
        refreshLivePeek(e.document);
      }, getLivePeekDebounceMs());
    });
  }

  /**
   * Re-execute the peeked statement and update the peek view.
   * Uses activePeekLine (the line where the peek is anchored) to find the
   * correct statement, so edits in other statements don't hijack the preview.
   */
  async function refreshLivePeek(document: vscode.TextDocument): Promise<void> {
    if (activePeekLine === undefined) {
      stopLivePeek();
      return;
    }

    const text = document.getText();
    const statements = parseSqlStatements(text);
    if (statements.length === 0) return;

    // Find the statement that contains or ends near the peek anchor line.
    // activePeekLine is the endLine of the peeked statement, so look for
    // the statement whose range includes that line.
    const peekOffset = document.offsetAt(
      new vscode.Position(activePeekLine, 0)
    );
    let target = statements[0];
    for (const stmt of statements) {
      if (peekOffset >= stmt.startOffset && peekOffset <= stmt.endOffset) {
        target = stmt;
        break;
      }
      // Also match if the peek line is just past the statement end (the
      // peek anchors at endLine which may be 1 past the last statement char)
      if (stmt.endOffset < peekOffset) {
        target = stmt;
      }
    }

    // Update activePeekLine in case the statement shifted due to edits above it
    const newEndLine = document.positionAt(target.endOffset).line;
    activePeekLine = newEndLine;

    const sql = text.slice(target.startOffset, target.endOffset).trim();
    if (!sql) return;

    // HTTP safety guard: skip live re-execution for remote sources without caching
    if (!httpBypassCheck && sqlContainsRemoteSource(sql)) {
      const hasCache = await isCacheHttpfsLoaded();
      if (!hasCache) {
        const shouldContinue = await showHttpCacheWarning();
        if (!shouldContinue) return; // Skip this refresh, keep last result
      }
    }

    const docUri = document.uri.toString();
    const pageSize = getPageSize();

    try {
      const result = await db.executeQuery(sql, pageSize);
      if (result.statements.length > 0) {
        const stmt = result.statements[0];
        cacheResult(docUri, target.startOffset, stmt.meta, stmt.page);
        const cached = getCachedResult(docUri, target.startOffset);
        if (cached) {
          resultDocProvider.setActivePeekResult(cached);
        }
      }
    } catch (error) {
      resultDocProvider.setActivePeekError(String(error));
    }

    codeLensProvider?.refresh();
  }

  function stopLivePeek(): void {
    if (livePeekTimer) {
      clearTimeout(livePeekTimer);
      livePeekTimer = undefined;
    }
    if (livePeekDisposable) {
      livePeekDisposable.dispose();
      livePeekDisposable = undefined;
    }
    livePeekDocUri = undefined;
    // Reset HTTP guard state for next session
    httpWarningShown = false;
    httpBypassCheck = false;
    cacheHttpfsLoaded = undefined;
  }

  // Stop live peek / clear peek state when user switches to a completely different file
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;
      const scheme = editor.document.uri.scheme;
      // Don't stop if focus moved to our peek result view
      if (scheme === RESULTS_SCHEME) return;
      // Don't stop if focus is still on the same SQL document
      const editorUri = editor.document.uri.toString();
      if (editorUri === livePeekDocUri || editorUri === activePeekDocUri)
        return;
      // Different document entirely — stop live peek and clear peek state
      stopLivePeek();
      activePeekDocUri = undefined;
      activePeekLine = undefined;
    })
  );

  // Register Peek Results command (inline preview via Peek View)
  const peekResultsCmd = vscode.commands.registerCommand(
    "duckdb.peekResults",
    async (
      uri: vscode.Uri,
      startOffset: number,
      endOffset: number,
      line: number
    ) => {
      const docUri = uri.toString();

      // Check if a duckdb peek is already visible at the SAME statement.
      // If so, we can refresh content in-place without reopening.
      // If the peek is at a different line, we need to reopen at the new position.
      const peekEditorVisible = vscode.window.visibleTextEditors.some(
        (e) => e.document.uri.scheme === RESULTS_SCHEME
      );
      const sameStatementPeek =
        peekEditorVisible &&
        activePeekDocUri === docUri &&
        activePeekLine === line;

      // Execute and get the virtual URI
      const virtualUri = await executeAndPeek(uri, startOffset, endOffset);
      if (!virtualUri) {
        vscode.window.showWarningMessage("No SQL to execute.");
        return;
      }

      codeLensProvider?.refresh();

      if (!sameStatementPeek) {
        // Open (or move) the peek widget at the end of the statement.
        // If a peek is open at a different line, VS Code will close the
        // old one and open at the new position.
        await vscode.commands.executeCommand(
          "editor.action.peekLocations",
          uri,
          new vscode.Position(line, 0),
          [new vscode.Location(virtualUri, new vscode.Position(0, 0))],
          "peek"
        );
      }
      // else: peek is at the same statement — the setActivePeekResult call
      // inside executeAndPeek already fired onDidChange, so the peek
      // view content refreshes automatically.

      // Track the active peek
      activePeekDocUri = docUri;
      activePeekLine = line;

      // Start live preview mode if the setting is enabled
      const livePreviewEnabled = vscode.workspace
        .getConfiguration("duckdb")
        .get<boolean>("peekResults.livePreview", false);

      if (livePreviewEnabled && !livePeekDocUri) {
        startLivePeek(uri);

        // Warn about HTTP sources after the peek is open (non-blocking)
        const document = await vscode.workspace.openTextDocument(uri);
        const sql = document.getText().slice(startOffset, endOffset).trim();
        if (sql && sqlContainsRemoteSource(sql)) {
          const hasCache = await isCacheHttpfsLoaded();
          if (!hasCache) {
            showHttpCacheWarning();
          }
        }
      }
    }
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
        (d) => !d.isAttached && d.isConfigured
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
        {
          label: "$(terminal) Attach with SQL...",
          description: "Run a custom ATTACH command (e.g. Postgres, SQLite)",
          action: "manual",
        }
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
                `🦆 Created database: ${alias}`
              );
            } catch (error) {
              vscode.window.showErrorMessage(
                `Failed to create database: ${error}`
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
              { placeHolder: "Select access mode" }
            );

            if (!readOnlyChoice) break;

            try {
              await attachDatabaseAndUse(
                (sql) => db.run(sql),
                filePath,
                alias,
                readOnlyChoice.readOnly
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
                `🦆 Attached database: ${alias}${modeLabel}`
              );
            } catch (error) {
              vscode.window.showErrorMessage(
                `Failed to attach database: ${error}`
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
              (c) => c.alias === selected.databaseName
            );

            if (!config) {
              vscode.window.showErrorMessage(
                `No configuration found for database: ${selected.databaseName}`
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
                }
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
                      readOnly
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
                  readOnly
                );
              }
              databaseExplorer.refresh();
              const modeLabel = readOnly ? " (read-only)" : "";
              vscode.window.showInformationMessage(
                `🦆 Attached database: ${selected.databaseName}${modeLabel}`
              );
            } catch (error) {
              vscode.window.showErrorMessage(
                `Failed to attach database: ${error}`
              );
            }
          }
          break;
        }

        case "manual": {
          // Let user enter a custom ATTACH SQL command
          const sql = await vscode.window.showInputBox({
            prompt: "Enter the ATTACH SQL command",
            placeHolder:
              "ATTACH 'postgres://user:pass@host:5432/db' AS mydb (TYPE postgres)",
            ignoreFocusOut: true,
            validateInput: (value) => {
              if (!value.trim()) return "SQL command is required";
              return undefined;
            },
          });

          if (!sql) break;

          // Extract alias from SQL: ... AS "alias" or AS alias
          let alias = "";
          const aliasMatch = sql.match(/\bAS\s+(?:"([^"]+)"|(\w+))/i);
          if (aliasMatch) {
            alias = aliasMatch[1] || aliasMatch[2];
          }

          // Only prompt for alias if we couldn't parse one from the SQL
          if (!alias) {
            const enteredAlias = await vscode.window.showInputBox({
              prompt: "Could not detect alias — enter a name for this database",
              ignoreFocusOut: true,
              validateInput: (value) => {
                if (!value.trim()) return "Alias is required";
                return undefined;
              },
            });

            if (!enteredAlias) break;
            alias = enteredAlias;
          }

          try {
            await runManualSql((s) => db.run(s), sql);
            currentDatabase = alias;
            updateStatusBar();
            databaseExplorer.refresh();

            // Save to workspace settings as manual type
            await addDatabaseToSettings({
              alias,
              type: "manual",
              sql,
              attached: true,
            });
            await setDefaultDatabase(alias);

            vscode.window.showInformationMessage(
              `🦆 Attached database: ${alias}`
            );
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to execute ATTACH command: ${error}`
            );
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
                `Failed to switch database: ${error}`
              );
            }
          }
          break;
        }
      }
    }
  );

  // Register Manage Extensions command
  const manageExtCmd = vscode.commands.registerCommand(
    "duckdb.manageExtensions",
    async () => {
      await showExtensionsQuickPick(db);
      extensionsExplorer.refresh();
    }
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
          getMaxCopyRows()
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Query failed: ${error}`);
      }
    }
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
    }
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
    }
  );

  // File listing function for autocomplete
  async function listFilesForAutocomplete(
    dirPath: string
  ): Promise<{ name: string; isDirectory: boolean }[]> {
    try {
      // Get workspace folder or document folder
      const workspaceFolders = vscode.workspace.workspaceFolders;
      let baseUri: vscode.Uri;

      if (workspaceFolders && workspaceFolders.length > 0) {
        baseUri = workspaceFolders[0].uri;
      } else {
        // No workspace, return empty
        return [];
      }

      // Resolve the directory path
      let targetUri: vscode.Uri;
      if (dirPath === "." || dirPath === "") {
        targetUri = baseUri;
      } else if (dirPath.startsWith("/")) {
        // Absolute path
        targetUri = vscode.Uri.file(dirPath);
      } else {
        // Relative path
        targetUri = vscode.Uri.joinPath(baseUri, dirPath);
      }

      const entries = await vscode.workspace.fs.readDirectory(targetUri);

      return entries
        .filter(([name]) => !name.startsWith(".")) // Hide dotfiles
        .map(([name, type]) => ({
          name,
          isDirectory: type === vscode.FileType.Directory,
        }))
        .sort((a, b) => {
          // Directories first, then alphabetical
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return a.name.localeCompare(b.name);
        });
    } catch (error) {
      console.error("🦆 Failed to list files:", error);
      return [];
    }
  }

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
          // Get full document text and cursor position
          const fullText = document.getText();
          const cursorPosition = document.offsetAt(position);

          // Skip DESCRIBE for remote sources if cache_httpfs is not loaded
          const skipRemote = !(await isCacheHttpfsLoaded());

          const suggestions = await getAutocompleteSuggestions(
            (sql) => db.query(sql),
            fullText,
            cursorPosition,
            listFilesForAutocomplete,
            skipRemote
          );

          return suggestions.map(
            ({ suggestion, suggestionStart, kind, detail }) => {
              const item = new vscode.CompletionItem(suggestion);

              // Map our kind to VS Code's CompletionItemKind
              // See: https://code.visualstudio.com/docs/editing/intellisense#_types-of-completions
              switch (kind) {
                case "keyword":
                  item.kind = vscode.CompletionItemKind.Keyword;
                  break;
                case "function":
                  item.kind = vscode.CompletionItemKind.Function;
                  break;
                case "database":
                  item.kind = vscode.CompletionItemKind.Event; // Stands out visually
                  break;
                case "schema":
                  item.kind = vscode.CompletionItemKind.Module; // Namespace/container concept
                  break;
                case "table":
                  item.kind = vscode.CompletionItemKind.Class; // Structured data type
                  break;
                case "view":
                  item.kind = vscode.CompletionItemKind.Interface; // Similar to table but virtual
                  break;
                case "column":
                  item.kind = vscode.CompletionItemKind.Field;
                  break;
                case "file":
                  item.kind = vscode.CompletionItemKind.File;
                  break;
                default:
                  item.kind = vscode.CompletionItemKind.Text;
              }

              // Add detail (e.g., data type for columns)
              if (detail) {
                item.detail = detail;
              }

              const startPos = document.positionAt(suggestionStart);
              item.range = new vscode.Range(startPos, position);

              // Re-trigger suggestions after inserting database/schema (they end with .)
              if (kind === "database" || kind === "schema") {
                item.command = {
                  command: "editor.action.triggerSuggest",
                  title: "Re-trigger completions",
                };
              }

              return item;
            }
          );
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
    "'", // Trigger on opening quote for file paths
    '"', // Trigger on opening quote for file paths
    "/" // Trigger on slash for path navigation
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
    }
  );

  const explorerSelectTop100Cmd = vscode.commands.registerCommand(
    "duckdb.explorer.selectTop100",
    async (node: ExplorerNode) => {
      if (node.type !== "table" && node.type !== "view") return;

      const schema = node.schema || "main";
      const sql = buildSelectTopSql(
        node.database!,
        schema,
        node.name,
        getDefaultRowLimit()
      );

      try {
        const pageSize = getPageSize();
        const result = await db.executeQuery(sql, pageSize);
        showResultsPanel(
          result,
          context,
          `explorer-${node.name}`,
          pageSize,
          getMaxCopyRows()
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Query failed: ${error}`);
      }
    }
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
          getMaxCopyRows()
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Describe failed: ${error}`);
      }
    }
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
          getMaxCopyRows()
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Summarize failed: ${error}`);
      }
    }
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
            node.name
          );
        } else {
          definition = await getTableDefinition(
            async (sql) => {
              const rows = await db.query(sql);
              return { rows };
            },
            node.database!,
            schema,
            node.name
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
    }
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
    }
  );

  const explorerSelectColumnCmd = vscode.commands.registerCommand(
    "duckdb.explorer.selectColumn",
    async (node: ExplorerNode) => {
      if (node.type !== "column") return;

      const schema = node.schema || "main";
      const qualifiedTable = `"${node.database}"."${schema}"."${node.tableName}"`;
      const limit = getDefaultRowLimit();
      const sql = `SELECT "${node.name}", COUNT(*) AS count FROM ${qualifiedTable} GROUP BY "${node.name}" ORDER BY count DESC LIMIT ${limit}`;

      try {
        const pageSize = getPageSize();
        const result = await db.executeQuery(sql, pageSize);
        showResultsPanel(
          result,
          context,
          `explorer-col-${node.tableName}-${node.name}`,
          pageSize,
          getMaxCopyRows()
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Query failed: ${error}`);
      }
    }
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
        "Drop"
      );

      if (confirm === "Drop") {
        try {
          await dropObject(
            (sql) => db.run(sql),
            objectType,
            node.database!,
            schema,
            node.name
          );
          databaseExplorer.refresh();
          vscode.window.showInformationMessage(
            `Dropped ${objectType} ${node.name}`
          );
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to drop: ${error}`);
        }
      }
    }
  );

  const explorerHideSchemaCmd = vscode.commands.registerCommand(
    "duckdb.explorer.hideSchema",
    async (node: ExplorerNode) => {
      if (node.type !== "schema") return;

      const confirm = await vscode.window.showWarningMessage(
        `Hide schema "${node.name}" from the explorer? You can restore it in Settings > DuckDB > Explorer: Ignored Schemas.`,
        "Hide"
      );
      if (confirm !== "Hide") return;

      await addIgnoredSchema(node.name);
      databaseExplorer.refresh();
      vscode.window.showInformationMessage(
        `Schema "${node.name}" is now hidden from the explorer.`
      );
    }
  );

  const explorerShowHiddenSchemasCmd = vscode.commands.registerCommand(
    "duckdb.explorer.showHiddenSchemas",
    async () => {
      const ignored = getIgnoredSchemas();
      if (ignored.length === 0) {
        vscode.window.showInformationMessage(
          "No schemas are currently hidden."
        );
        return;
      }

      const selected = await vscode.window.showQuickPick(ignored, {
        placeHolder: "Select a schema to show again",
        canPickMany: true,
        title: "Hidden Schemas",
      });

      if (selected && selected.length > 0) {
        const config = getWorkspaceConfig();
        const current = config.get<string[]>("explorer.ignoredSchemas", []);
        const updated = current.filter((s) => !selected.includes(s));
        await config.update(
          "explorer.ignoredSchemas",
          updated,
          vscode.ConfigurationTarget.Workspace
        );
        databaseExplorer.refresh();
        vscode.window.showInformationMessage(
          `Restored ${selected.length} schema(s) to the explorer.`
        );
      }
    }
  );

  const explorerFindTableCmd = vscode.commands.registerCommand(
    "duckdb.explorer.findTable",
    async () => {
      const queryFn = async (sql: string) => ({
        rows: await db.query(sql),
      });

      // Gather all tables/views from all attached databases and schemas
      const items: Array<{
        label: string;
        description: string;
        detail: string;
        database: string;
        schema: string;
        name: string;
        objectType: "table" | "view";
      }> = [];

      try {
        const databases = await getAttachedDatabases(queryFn);
        for (const database of databases) {
          if (database.isInternal) continue;
          const schemas = await getSchemas(queryFn, database.name);
          for (const schema of schemas) {
            const tables = await getTables(queryFn, database.name, schema.name);
            for (const table of tables) {
              const icon = table.type === "view" ? "$(eye)" : "$(table)";
              items.push({
                label: `${icon} ${table.name}`,
                description: `${database.name}.${schema.name}`,
                detail:
                  table.rowCount !== undefined
                    ? `${table.type} — ${table.rowCount.toLocaleString()} rows`
                    : table.type,
                database: database.name,
                schema: schema.name,
                name: table.name,
                objectType: table.type,
              });
            }
          }
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to search tables: ${error}`);
        return;
      }

      if (items.length === 0) {
        vscode.window.showInformationMessage("No tables or views found.");
        return;
      }

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: "Type to search for a table or view...",
        matchOnDescription: true,
        matchOnDetail: true,
        title: "Find Table or View",
      });

      if (selected) {
        // Run Select Top Rows on the selected table
        const limit = getDefaultRowLimit();
        const sql = buildSelectTopSql(
          selected.database,
          selected.schema,
          selected.name,
          limit
        );
        try {
          const pageSize = getPageSize();
          const result = await db.executeQuery(sql, pageSize);
          showResultsPanel(
            result,
            context,
            `explorer-${selected.name}`,
            pageSize,
            getMaxCopyRows()
          );
        } catch (error) {
          vscode.window.showErrorMessage(`Query failed: ${error}`);
        }
      }
    }
  );

  const explorerCopyAsInsertCmd = vscode.commands.registerCommand(
    "duckdb.explorer.copyAsInsert",
    async (node: ExplorerNode) => {
      if (node.type !== "table" && node.type !== "view") return;

      const schema = node.schema || "main";
      const queryFn = async (sql: string) => ({
        rows: await db.query(sql),
      });

      try {
        // Get column info for the INSERT template
        const result = await queryFn(`
          SELECT column_name, data_type
          FROM information_schema.columns
          WHERE table_catalog = '${node.database}'
            AND table_schema = '${schema}'
            AND table_name = '${node.name}'
          ORDER BY ordinal_position
        `);

        const columns = result.rows.map((r) => r.column_name as string);
        const placeholders = result.rows.map((r) => {
          const dt = (r.data_type as string).toUpperCase();
          if (
            dt.includes("INT") ||
            dt.includes("FLOAT") ||
            dt.includes("DOUBLE") ||
            dt.includes("DECIMAL") ||
            dt.includes("NUMERIC")
          ) {
            return "0";
          }
          if (dt.includes("BOOL")) {
            return "false";
          }
          if (
            dt.includes("DATE") ||
            dt.includes("TIME") ||
            dt.includes("TIMESTAMP")
          ) {
            return `'${new Date().toISOString().slice(0, 10)}'`;
          }
          return "''";
        });

        const qualifiedName = `"${node.database}"."${schema}"."${node.name}"`;
        const sql = `INSERT INTO ${qualifiedName} (\n    ${columns
          .map((c) => `"${c}"`)
          .join(",\n    ")}\n) VALUES (\n    ${placeholders.join(
          ",\n    "
        )}\n);`;

        await vscode.env.clipboard.writeText(sql);
        vscode.window.showInformationMessage(
          "Copied INSERT template to clipboard"
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to generate INSERT: ${error}`);
      }
    }
  );

  const explorerCopyAsCreateCmd = vscode.commands.registerCommand(
    "duckdb.explorer.copyAsCreate",
    async (node: ExplorerNode) => {
      if (node.type !== "table" && node.type !== "view") return;

      const schema = node.schema || "main";
      const queryFn = async (sql: string) => ({
        rows: await db.query(sql),
      });

      try {
        let ddl: string;
        if (node.type === "view") {
          ddl = await getViewDefinition(
            queryFn,
            node.database!,
            schema,
            node.name
          );
        } else {
          ddl = await getTableDefinition(
            queryFn,
            node.database!,
            schema,
            node.name
          );
        }
        await vscode.env.clipboard.writeText(ddl);
        vscode.window.showInformationMessage(
          `Copied CREATE ${
            node.type === "view" ? "VIEW" : "TABLE"
          } to clipboard`
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to generate DDL: ${error}`);
      }
    }
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
          `Now using database: ${node.name}`
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to switch database: ${error}`);
      }
    }
  );

  const explorerAttachDatabaseCmd = vscode.commands.registerCommand(
    "duckdb.explorer.attachDatabase",
    async () => {
      // Reuse the existing selectDatabase command which has attach functionality
      await vscode.commands.executeCommand("duckdb.selectDatabase");
      databaseExplorer.refresh();
    }
  );

  const explorerDetachDatabaseCmd = vscode.commands.registerCommand(
    "duckdb.explorer.detachDatabase",
    async (node: ExplorerNode) => {
      if (node.type !== "database") return;
      if (node.name === "memory") {
        vscode.window.showWarningMessage(
          "Cannot detach the default memory database"
        );
        return;
      }

      try {
        // Query DuckDB for the actual current database
        // (the local variable can be out of sync if the user ran USE manually)
        const actualCurrentDb = await getCurrentDatabase(async (s) => ({
          rows: await db.query(s),
        }));

        // If this is the current database, switch to memory first
        // (DuckDB won't allow detaching the default database)
        if (node.name === actualCurrentDb) {
          await switchDatabase(async (sql) => db.run(sql), "memory");
          currentDatabase = "memory";
        }

        // Detach from DuckDB
        await detachDatabase(async (sql) => db.run(sql), node.name);

        // Update settings to mark as detached (don't remove)
        await updateDatabaseAttachedState(node.name, false);

        databaseExplorer.refresh();
        updateStatusBar();
        vscode.window.showInformationMessage(`Detached database: ${node.name}`);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to detach database: ${error}`);
      }
    }
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
          `No configuration found for database: ${node.name}`
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
          { placeHolder: "Select access mode" }
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
          `Attached database: ${node.name}${modeLabel}`
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to attach database: ${error}`);
      }
    }
  );

  // Forget a database (remove from settings completely)
  const explorerForgetDatabaseCmd = vscode.commands.registerCommand(
    "duckdb.explorer.forgetDatabase",
    async (node: ExplorerNode) => {
      if (node.type !== "database-detached") return;

      const confirm = await vscode.window.showWarningMessage(
        `Remove "${node.name}" from workspace settings?`,
        { modal: true },
        "Remove"
      );

      if (confirm === "Remove") {
        try {
          await removeDatabaseFromSettings(node.name);
          databaseExplorer.refresh();
          vscode.window.showInformationMessage(
            `Removed database configuration: ${node.name}`
          );
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to remove database: ${error}`);
        }
      }
    }
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
          `Created schema: ${node.name}.${schemaName}`
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to create schema: ${error}`);
      }
    }
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
    }
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
    }
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
    }
  );

  const historySearchCmd = vscode.commands.registerCommand(
    "duckdb.history.search",
    async () => {
      const entries = getHistoryService().getEntries();

      if (entries.length === 0) {
        vscode.window.showInformationMessage("No query history yet.");
        return;
      }

      const items = entries.map((entry) => {
        const time = entry.executedAt.toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });

        const status = entry.error ? "$(error)" : "$(check)";
        const sqlOneLine = entry.sql.replace(/\s+/g, " ").trim();
        const sqlTruncated =
          sqlOneLine.length > 80
            ? sqlOneLine.substring(0, 80) + "..."
            : sqlOneLine;

        let detail = `${time} · ${entry.databaseName}`;
        if (entry.error) {
          detail += ` · Error`;
        } else if (entry.rowCount !== null) {
          const duration =
            entry.durationMs < 1000
              ? `${Math.round(entry.durationMs)}ms`
              : `${(entry.durationMs / 1000).toFixed(1)}s`;
          detail += ` · ${entry.rowCount.toLocaleString()} rows · ${duration}`;
        }

        return {
          label: `${status} ${sqlTruncated}`,
          description: entry.databaseName,
          detail,
          entry,
        };
      });

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: "Type to search query history...",
        matchOnDescription: true,
        matchOnDetail: true,
        title: "Search Query History",
      });

      if (!selected) return;

      // Offer actions on the selected entry
      const action = await vscode.window.showQuickPick(
        [
          { label: "$(play) Run Again", action: "run" },
          { label: "$(go-to-file) Open in Editor", action: "open" },
          { label: "$(copy) Copy SQL", action: "copy" },
        ],
        { placeHolder: "What would you like to do with this query?" }
      );

      if (!action) return;

      switch (action.action) {
        case "run": {
          try {
            const pageSize = getPageSize();
            const result = await db.executeQuery(selected.entry.sql, pageSize);
            showResultsPanel(
              result,
              context,
              `history-${selected.entry.id}`,
              pageSize,
              getMaxCopyRows()
            );

            const dbName = await getCurrentDatabase(async (s) => ({
              rows: await db.query(s),
            }));
            const lastStmt = result.statements[result.statements.length - 1];
            await getHistoryService().addEntry({
              sql: selected.entry.sql,
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
          break;
        }
        case "open": {
          const doc = await vscode.workspace.openTextDocument({
            content: selected.entry.sql,
            language: "sql",
          });
          await vscode.window.showTextDocument(doc);
          break;
        }
        case "copy": {
          await vscode.env.clipboard.writeText(selected.entry.sql);
          vscode.window.showInformationMessage("SQL copied to clipboard");
          break;
        }
      }
    }
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
          getMaxCopyRows()
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
    }
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
    }
  );

  const historyCopySqlCmd = vscode.commands.registerCommand(
    "duckdb.history.copySql",
    async (node: HistoryNode) => {
      if (node.type !== "query" || !node.entry) return;

      await vscode.env.clipboard.writeText(node.entry.sql);
      vscode.window.showInformationMessage("SQL copied to clipboard");
    }
  );

  const historyDeleteCmd = vscode.commands.registerCommand(
    "duckdb.history.delete",
    async (node: HistoryNode) => {
      if (node.type !== "query" || !node.entry) return;

      await getHistoryService().deleteEntry(node.entry.id);
    }
  );

  const historyClearAllCmd = vscode.commands.registerCommand(
    "duckdb.history.clearAll",
    async () => {
      const confirm = await vscode.window.showWarningMessage(
        "Clear all query history?",
        { modal: true },
        "Clear"
      );

      if (confirm === "Clear") {
        await getHistoryService().clearAll();
        vscode.window.showInformationMessage("Query history cleared");
      }
    }
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
    }
  );

  const extensionsAddCmd = vscode.commands.registerCommand(
    "duckdb.extensions.add",
    async () => {
      // Reuse the existing manageExtensions logic
      await showExtensionsQuickPick(db);
      extensionsExplorer.refresh();
    }
  );

  const extensionsLoadCmd = vscode.commands.registerCommand(
    "duckdb.extensions.load",
    async (node: ExtensionNode) => {
      if (node.type !== "extension") return;
      try {
        await installAndLoadExtension((sql) => db.run(sql), node.name);
        vscode.window.showInformationMessage(`Loaded extension: ${node.name}`);
        extensionsExplorer.refresh();
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to load extension ${node.name}: ${error}`
        );
      }
    }
  );

  const extensionsAddToAutoLoadCmd = vscode.commands.registerCommand(
    "duckdb.extensions.addToAutoLoad",
    async (node: ExtensionNode) => {
      if (node.type !== "extension") return;
      await addExtensionToAutoLoad(node.name);
      vscode.window.showInformationMessage(`Added ${node.name} to auto-load.`);
      extensionsExplorer.refresh();
    }
  );

  const extensionsRemoveFromAutoLoadCmd = vscode.commands.registerCommand(
    "duckdb.extensions.removeFromAutoLoad",
    async (node: ExtensionNode) => {
      if (node.type !== "extension") return;
      await removeExtensionFromAutoLoad(node.name);
      vscode.window.showInformationMessage(
        `Removed ${node.name} from auto-load.`
      );
      extensionsExplorer.refresh();
    }
  );

  // Register SQL CodeLens provider for run actions
  setGetCurrentDatabase(() => currentDatabase);
  setGetCachedResultsForDoc(getCachedResultsForDoc);
  codeLensProvider = registerSqlCodeLens(context);

  // Register virtual document provider for peek results
  const resultDocProvider = new ResultDocumentProvider();
  const resultDocRegistration =
    vscode.workspace.registerTextDocumentContentProvider(
      RESULTS_SCHEME,
      resultDocProvider
    );
  context.subscriptions.push(resultDocRegistration);

  // Register SQL formatting provider (Format Document / Format Selection)
  registerSqlFormatter(context);

  // Register Data File Editor (parquet, csv, json viewer)
  const dataFileProvider = new DataFileEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      DataFileEditorProvider.viewType,
      dataFileProvider,
      { supportsMultipleEditorsPerDocument: false }
    )
  );

  // Sync editor associations on activation and when settings change
  syncEditorAssociations().catch((err) =>
    console.error("🦆 Failed to sync editor associations:", err)
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("duckdb.fileViewer")) {
        syncEditorAssociations().catch((err) =>
          console.error("🦆 Failed to sync editor associations:", err)
        );
      }
    })
  );

  // Register "Go to Source" command for results panel
  const goToSourceCmd = vscode.commands.registerCommand(
    "duckdb.results.goToSource",
    async () => {
      const sourceUri = getActiveResultsSourceUri();
      if (sourceUri) {
        try {
          // First check if there's already a visible editor for this file
          const existingEditor = vscode.window.visibleTextEditors.find(
            (editor) => editor.document.uri.toString() === sourceUri.toString()
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
            `Could not open source file: ${error}`
          );
        }
      } else {
        // No source file - create a new untitled document with the SQL
        const queries = getActiveResultsQueries();
        if (queries.length > 0) {
          const sql = queries.join(";\n\n") + ";";
          const doc = await vscode.workspace.openTextDocument({
            language: "sql",
            content: sql,
          });
          await vscode.window.showTextDocument(doc, { preserveFocus: false });
        } else {
          vscode.window.showInformationMessage(
            "No source file associated with this results panel"
          );
        }
      }
    }
  );

  context.subscriptions.push(
    executeCmd,
    runStatementCmd,
    runStatementAtCursorCmd,
    peekResultsCmd,
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
    explorerHideSchemaCmd,
    explorerShowHiddenSchemasCmd,
    explorerFindTableCmd,
    explorerCopyAsInsertCmd,
    explorerCopyAsCreateCmd,
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
    historySearchCmd,
    historyRunAgainCmd,
    historyOpenInEditorCmd,
    historyCopySqlCmd,
    historyDeleteCmd,
    historyClearAllCmd,
    extensionsTreeView,
    extensionsRefreshCmd,
    extensionsAddCmd,
    extensionsLoadCmd,
    extensionsAddToAutoLoadCmd,
    extensionsRemoveFromAutoLoadCmd,
    goToSourceCmd
  );
}

/**
 * Cache executed statement results for the peek preview feature.
 * Uses parseSqlStatements to compute offsets that exactly match the CodeLens
 * provider's offsets (since both use the same parser).
 */
function cacheStatementsForPeek(
  document: vscode.TextDocument,
  sql: string,
  baseOffset: number,
  statements: Array<{
    meta: import("./services/duckdb").StatementCacheMeta;
    page: import("./services/duckdb").PageData;
  }>
): void {
  const docUri = document.uri.toString();

  // Use the same parser as CodeLens to guarantee matching offsets
  const parsed = parseSqlStatements(sql);

  // Pair results with parsed statements by index
  const count = Math.min(parsed.length, statements.length);
  for (let i = 0; i < count; i++) {
    const startOffset = baseOffset + parsed[i].startOffset;
    cacheResult(docUri, startOffset, statements[i].meta, statements[i].page);
  }
}

export async function deactivate() {
  disposeDecorations();
  await disposeDuckDBService();
}

/**
 * Auto-attach databases from workspace settings
 * Only attaches databases that were attached last session (attached !== false)
 */
async function autoAttachDatabases(
  db: ReturnType<typeof getDuckDBService>
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
              `DuckDB: Database "${dbConfig.alias}" missing path`
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
              `DuckDB: Database file not found: ${dbConfig.path}`
            );
            // Mark as detached since we couldn't attach it
            await updateDatabaseAttachedState(dbConfig.alias, false);
            continue;
          }

          await attachDatabase(
            runFn,
            filePath,
            dbConfig.alias,
            dbConfig.readOnly
          );
          attachedCount++;
          break;
        }

        case "manual": {
          if (!dbConfig.sql) {
            vscode.window.showWarningMessage(
              `DuckDB: Database "${dbConfig.alias}" missing sql`
            );
            continue;
          }
          await runManualSql(runFn, dbConfig.sql);
          attachedCount++;
          break;
        }

        default:
          vscode.window.showWarningMessage(
            `DuckDB: Unknown database type for "${dbConfig.alias}"`
          );
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `DuckDB: Failed to attach "${dbConfig.alias}": ${error}`
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
        `🦆 Could not switch to default database "${defaultDb}": ${error}`
      );
    }
  }

  if (attachedCount > 0 || skippedCount > 0) {
    console.log(
      `🦆 Auto-attached ${attachedCount} database(s), skipped ${skippedCount}`
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
  db: ReturnType<typeof getDuckDBService>
): Promise<void> {
  const extensions = getAutoLoadExtensions();

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
        `DuckDB: Failed to load extension "${ext}": ${error}`
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
  db: ReturnType<typeof getDuckDBService>
): Promise<void> {
  const enabledExtensions = getAutoLoadExtensions();

  // Get currently loaded extensions
  let loadedExtensions: string[] = [];
  try {
    loadedExtensions = await getLoadedExtensionsFromService((sql) =>
      db.query(sql)
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
    }
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
        await addExtensionToAutoLoad(selected.extName);
        // Try to load immediately
        try {
          await installAndLoadExtension(runFn, selected.extName);
          vscode.window.showInformationMessage(
            `🦆 Loaded extension: ${selected.extName}`
          );
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to load extension: ${error}`);
        }
      }
      break;
    }

    case "remove": {
      if (selected.extName) {
        await removeExtensionFromAutoLoad(selected.extName);
        vscode.window.showInformationMessage(
          `🦆 Removed extension: ${selected.extName} (restart to unload)`
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
        await addExtensionToAutoLoad(extName);
        try {
          await installAndLoadExtension(runFn, extName);
          vscode.window.showInformationMessage(
            `🦆 Loaded extension: ${extName}`
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

  // Also refresh CodeLens to show updated database
  codeLensProvider?.refresh();
}

interface DatabasePickItem extends vscode.QuickPickItem {
  action:
    | "switch"
    | "create"
    | "attach"
    | "reattach"
    | "detach"
    | "forget"
    | "manual"
    | "none";
  databaseName?: string;
}
