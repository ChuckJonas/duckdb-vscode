/**
 * Inline Decoration Service
 *
 * Shows transient execution feedback directly in the editor:
 *   Loading: "⏳ running (3s)"     (muted, italic, live timer)
 *   Success: "✓ executed (3.2ms)"  (muted, italic)
 *   Error:   "✗ Parser Error: ..." (red, italic)
 * Auto-fades after a configurable timeout.
 */
import * as vscode from "vscode";

// ============================================================================
// Shared decoration infrastructure
// ============================================================================

interface DecorationState {
  type: vscode.TextEditorDecorationType;
  timer?: ReturnType<typeof setTimeout>;
  editor?: vscode.TextEditor;
}

function createState(): DecorationState {
  return {
    type: vscode.window.createTextEditorDecorationType({ isWholeLine: false }),
  };
}

const success: DecorationState = createState();
const error: DecorationState = createState();

/**
 * Show decorations on an editor and auto-clear after a timeout.
 */
function applyDecorations(
  state: DecorationState,
  editor: vscode.TextEditor,
  decorations: vscode.DecorationOptions[],
  fadeMs: number
): void {
  clearState(state);
  editor.setDecorations(state.type, decorations);
  state.editor = editor;
  state.timer = setTimeout(() => clearState(state), fadeMs);
}

function clearState(state: DecorationState): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }
  if (state.editor) {
    state.editor.setDecorations(state.type, []);
    state.editor = undefined;
  }
}

// ============================================================================
// Loading decoration (live timer while query executes)
// ============================================================================

interface LoadingState {
  type: vscode.TextEditorDecorationType;
  editor?: vscode.TextEditor;
  lines: number[];
  startTime: number;
  interval?: ReturnType<typeof setInterval>;
}

const loading: LoadingState = {
  type: vscode.window.createTextEditorDecorationType({ isWholeLine: false }),
  lines: [],
  startTime: 0,
};

function updateLoadingText(): void {
  if (!loading.editor) {
    return;
  }
  const elapsed = Math.floor((Date.now() - loading.startTime) / 1000);
  const text = `  ⏳ running (${elapsed}s)`;

  const decorations: vscode.DecorationOptions[] = loading.lines.map((line) => ({
    range: new vscode.Range(
      line,
      Number.MAX_SAFE_INTEGER,
      line,
      Number.MAX_SAFE_INTEGER
    ),
    renderOptions: {
      after: {
        contentText: text,
        color: new vscode.ThemeColor("editorCodeLens.foreground"),
        fontStyle: "italic" as const,
      },
    },
  }));

  loading.editor.setDecorations(loading.type, decorations);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Show a loading decoration with a live elapsed-time counter.
 * Call `clearLoadingDecoration()` when execution finishes.
 */
export function showLoadingDecoration(
  editor: vscode.TextEditor,
  lines: number[]
): void {
  clearLoadingDecoration();
  // Clear any lingering success decoration so they don't overlap
  clearState(success);

  loading.editor = editor;
  loading.lines = lines;
  loading.startTime = Date.now();

  updateLoadingText();
  loading.interval = setInterval(updateLoadingText, 1000);
}

/**
 * Clear the loading decoration and stop the timer.
 */
export function clearLoadingDecoration(): void {
  if (loading.interval) {
    clearInterval(loading.interval);
    loading.interval = undefined;
  }
  if (loading.editor) {
    loading.editor.setDecorations(loading.type, []);
    loading.editor = undefined;
  }
  loading.lines = [];
}

/**
 * Show inline success decorations on statement lines.
 * Renders as:  ✓ executed (3.2ms)
 * Auto-clears after `fadeMs` (default 5000).
 */
export function showExecutionDecorations(
  editor: vscode.TextEditor,
  results: Array<{ line: number; timeMs: number }>,
  fadeMs = 5000
): void {
  const decorations = results.map(({ line, timeMs }) => ({
    range: new vscode.Range(
      line,
      Number.MAX_SAFE_INTEGER,
      line,
      Number.MAX_SAFE_INTEGER
    ),
    renderOptions: {
      after: {
        contentText: `  ✓ executed (${timeMs.toFixed(1)}ms)`,
        color: new vscode.ThemeColor("editorCodeLens.foreground"),
        fontStyle: "italic" as const,
      },
    },
  }));
  applyDecorations(success, editor, decorations, fadeMs);
}

/**
 * Show an inline error decoration on a statement line.
 * Renders as:  ✗ Parser Error: message...
 * Auto-clears after `fadeMs` (default 8000).
 */
export function showErrorDecoration(
  editor: vscode.TextEditor,
  line: number,
  errorType: string,
  errorMessage: string,
  fadeMs = 8000
): void {
  const maxLen = 80;
  const msg =
    errorMessage.length > maxLen
      ? errorMessage.slice(0, maxLen - 1) + "…"
      : errorMessage;
  const label = errorType ? `${errorType} Error: ${msg}` : msg;

  const decorations: vscode.DecorationOptions[] = [
    {
      range: new vscode.Range(
        line,
        Number.MAX_SAFE_INTEGER,
        line,
        Number.MAX_SAFE_INTEGER
      ),
      renderOptions: {
        after: {
          contentText: `  ✗ ${label}`,
          color: new vscode.ThemeColor("editorError.foreground"),
          fontStyle: "italic" as const,
        },
      },
    },
  ];
  applyDecorations(error, editor, decorations, fadeMs);
}

/**
 * Map statement SQL texts to their ending line positions in the editor.
 * Uses sequential search through the full SQL to locate each statement.
 */
export function mapStatementsToLines(
  fullSql: string,
  baseOffset: number,
  statements: Array<{ meta: { sql: string; executionTime: number } }>,
  document: vscode.TextDocument
): Array<{ line: number; timeMs: number }> {
  const results: Array<{ line: number; timeMs: number }> = [];
  let searchFrom = 0;

  for (const stmt of statements) {
    const idx = fullSql.indexOf(stmt.meta.sql, searchFrom);
    if (idx !== -1) {
      const endOffset = baseOffset + idx + stmt.meta.sql.length;
      const endPos = document.positionAt(endOffset);
      results.push({ line: endPos.line, timeMs: stmt.meta.executionTime });
      searchFrom = idx + stmt.meta.sql.length;
    }
  }

  return results;
}

/**
 * Dispose all decoration state. Call from extension deactivate().
 */
export function disposeDecorations(): void {
  clearLoadingDecoration();
  clearState(success);
  clearState(error);
  loading.type.dispose();
  success.type.dispose();
  error.type.dispose();
}
