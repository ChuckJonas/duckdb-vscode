import * as assert from "assert";
import * as vscode from "vscode";
import { DuckDBService } from "../../services/duckdb";
import {
  DatabaseExplorer,
  type ExplorerNode,
} from "../../explorer/DatabaseExplorer";

suite("Database explorer catalog", function () {
  this.timeout(30_000);
  let service: DuckDBService;
  let explorer: DatabaseExplorer;
  let queries: string[];

  setup(async () => {
    service = new DuckDBService();
    await service.initialize();
    await service.run("CREATE TABLE example (id INTEGER, name VARCHAR)");
    await service.run(
      "CREATE VIEW expensive AS SELECT 1 AS id WHERE CAST(error('unexpected scan') AS BOOLEAN)",
    );
    queries = [];
    const query = service.query.bind(service);
    service.query = async (sql) => {
      queries.push(sql);
      return query(sql);
    };
    explorer = new DatabaseExplorer(
      async (sql) => ({ rows: await service.query(sql) }),
      service.catalog,
    );
  });

  teardown(async () => {
    await service.close();
  });

  test("Tables and Views share discovery without evaluating views", async () => {
    const tables = await explorer.getChildren({
      type: "tables-folder",
      name: "Tables",
      database: "memory",
      schema: "main",
    });
    const views = await explorer.getChildren({
      type: "views-folder",
      name: "Views",
      database: "memory",
      schema: "main",
    });
    assert.ok(tables.some((node) => node.name === "example"));
    assert.ok(views.some((node) => node.name === "expensive"));
    assert.strictEqual(
      queries.filter((sql) => sql.includes("information_schema.tables")).length,
      1,
    );
    assert.ok(!queries.some((sql) => /\b(COUNT|SUMMARIZE)\b/i.test(sql)));
  });

  test("columns are leaves and expanding a table never profiles it", async () => {
    const table: ExplorerNode = {
      type: "table",
      name: "example",
      database: "memory",
      schema: "main",
    };
    const columns = await explorer.getChildren(table);
    assert.deepStrictEqual(
      columns.map((node) => node.name),
      ["id", "name"],
    );
    assert.strictEqual(
      explorer.getTreeItem(columns[0]).collapsibleState,
      vscode.TreeItemCollapsibleState.None,
    );
    assert.deepStrictEqual(await explorer.getChildren(columns[0]), []);
    assert.ok(!queries.some((sql) => /\b(COUNT|SUMMARIZE)\b/i.test(sql)));
  });

  test("overview metadata does not execute views; exact counts are explicit", async () => {
    const metadata = await service.getTableMetadata(
      "memory",
      "main",
      "expensive",
    );
    assert.strictEqual(metadata.rowCount, undefined);
    assert.strictEqual(metadata.columns[0].name, "id");
    await assert.rejects(
      service.getTableRowCount("memory", "main", "expensive"),
      /unexpected scan/,
    );
    await assert.rejects(
      service.getTableSummaries("memory", "main", "expensive"),
      /unexpected scan/,
    );
  });

  test("refresh performs new discovery and schema changes appear immediately", async () => {
    await explorer.getChildren({
      type: "tables-folder",
      name: "Tables",
      database: "memory",
      schema: "main",
    });
    service.catalog.refresh("memory");
    await service.run("CREATE TABLE added (id INTEGER)");
    const tables = await explorer.getChildren({
      type: "tables-folder",
      name: "Tables",
      database: "memory",
      schema: "main",
    });
    assert.ok(tables.some((node) => node.name === "added"));
    assert.strictEqual(
      queries.filter((sql) => sql.includes("information_schema.tables")).length,
      2,
    );
  });
});
