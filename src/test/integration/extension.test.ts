/**
 * Smoke Tests for DuckDB VS Code Extension
 *
 * These run inside a real VS Code instance via @vscode/test-cli (Mocha).
 * They validate that the extension activates correctly and core features
 * are functional across all platforms (macOS, Linux, Windows).
 *
 * Run with: npm test
 */
import * as assert from "assert";
import * as vscode from "vscode";

const EXTENSION_ID = "chuckjonas.duckdb";

suite("DuckDB Extension Smoke Tests", function () {
  this.timeout(30_000);

  let extension: vscode.Extension<unknown>;

  suiteSetup(async function () {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `Extension '${EXTENSION_ID}' should be installed`);
    extension = ext;

    // Activate and wait for initialization (DuckDB native bindings, etc.)
    if (!extension.isActive) {
      await extension.activate();
    }
  });

  // --- Activation ---

  test("extension activates without error", function () {
    assert.strictEqual(extension.isActive, true);
  });

  // --- Command Registration ---

  test("core query commands are registered", async function () {
    const commands = await vscode.commands.getCommands(
      /* filterInternal */ true
    );

    const expected = [
      "duckdb.executeQuery",
      "duckdb.runStatement",
      "duckdb.runStatementAtCursor",
      "duckdb.peekResults",
    ];

    for (const cmd of expected) {
      assert.ok(
        commands.includes(cmd),
        `Command '${cmd}' should be registered`
      );
    }
  });

  test("database management commands are registered", async function () {
    const commands = await vscode.commands.getCommands(true);

    const expected = [
      "duckdb.selectDatabase",
      "duckdb.explorer.refresh",
      "duckdb.explorer.attachDatabase",
      "duckdb.explorer.detachDatabase",
      "duckdb.explorer.selectTop100",
      "duckdb.explorer.describe",
    ];

    for (const cmd of expected) {
      assert.ok(
        commands.includes(cmd),
        `Command '${cmd}' should be registered`
      );
    }
  });

  test("extension management commands are registered", async function () {
    const commands = await vscode.commands.getCommands(true);

    const expected = [
      "duckdb.manageExtensions",
      "duckdb.extensions.refresh",
      "duckdb.extensions.add",
      "duckdb.extensions.load",
    ];

    for (const cmd of expected) {
      assert.ok(
        commands.includes(cmd),
        `Command '${cmd}' should be registered`
      );
    }
  });

  test("query history commands are registered", async function () {
    const commands = await vscode.commands.getCommands(true);

    const expected = [
      "duckdb.history.refresh",
      "duckdb.history.search",
      "duckdb.history.runAgain",
      "duckdb.history.clearAll",
    ];

    for (const cmd of expected) {
      assert.ok(
        commands.includes(cmd),
        `Command '${cmd}' should be registered`
      );
    }
  });

  // --- Contributed Views ---

  test("tree views are contributed", function () {
    const pkg = extension.packageJSON;
    const views = pkg.contributes?.views?.["duckdb-explorer"];
    assert.ok(
      Array.isArray(views),
      "DuckDB explorer views should be contributed"
    );

    const ids = views.map((v: { id: string }) => v.id);
    assert.ok(
      ids.includes("duckdb.databaseExplorer"),
      "Database explorer view"
    );
    assert.ok(ids.includes("duckdb.queryHistory"), "Query history view");
    assert.ok(ids.includes("duckdb.extensions"), "Extensions view");
  });

  // --- Query Execution ---

  test("can execute a simple query via DuckDB", async function () {
    // Open an untitled SQL document with a trivial query
    const doc = await vscode.workspace.openTextDocument({
      language: "sql",
      content: "SELECT 42 AS answer;",
    });
    const editor = await vscode.window.showTextDocument(doc);
    assert.ok(editor, "Editor should open");

    // Execute the query — this triggers DuckDB and the results webview.
    // In a headless test environment the webview may not fully render,
    // but the command should not throw due to a DuckDB or binding error.
    try {
      await vscode.commands.executeCommand("duckdb.executeQuery");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Fail on DuckDB / binding errors — these indicate a real problem.
      // Webview or UI errors are acceptable in headless CI.
      if (/duckdb|binding|native|initialize/i.test(msg)) {
        assert.fail(`DuckDB execution error: ${msg}`);
      }
    }
  });

  // --- SQL Language Features ---

  test("SQL completion provider is registered", async function () {
    // Open a SQL file and request completions — the provider should be active
    const doc = await vscode.workspace.openTextDocument({
      language: "sql",
      content: "SELECT ",
    });
    await vscode.window.showTextDocument(doc);

    // Give the extension a moment to register the provider
    await sleep(500);

    const position = new vscode.Position(0, 7); // after "SELECT "
    const completions =
      await vscode.commands.executeCommand<vscode.CompletionList>(
        "vscode.executeCompletionItemProvider",
        doc.uri,
        position
      );

    // We just verify the provider responds — it may return 0 items in
    // some environments, but it should not be undefined/null.
    assert.ok(completions, "Completion provider should respond");
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
