import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  CatalogService,
  sqlString,
  type CatalogOptions,
  type CatalogQuery,
} from "../services/catalogService";
import { DuckDBService } from "../services/duckdb";
import {
  getAutocompleteSuggestions,
  clearColumnCache,
} from "../services/autocompleteService";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  clearColumnCache();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "duckdb-catalog-test-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "source.duckdb");
  const storagePath = path.join(root, "cache");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  cleanups.push(async () => {
    connection.closeSync();
    instance.closeSync();
  });
  await connection.run(`ATTACH ${sqlString(file)} AS data`);
  await connection.run(
    "CREATE TABLE data.main.items (id INTEGER NOT NULL, name VARCHAR)",
  );
  await connection.run(
    "INSERT INTO data.main.items VALUES (1, 'first'), (2, NULL)",
  );
  await connection.run(
    "CREATE VIEW data.main.expensive AS SELECT CAST(error('view was evaluated') AS INTEGER) AS id",
  );
  await connection.run("CHECKPOINT data");
  const queries: string[] = [];
  const query: CatalogQuery = async (sql) => {
    queries.push(sql);
    return (await connection.runAndReadAll(sql)).getRowObjectsJS();
  };
  function catalog(options: CatalogOptions = {}, queryFn = query) {
    const service = new CatalogService(queryFn, { storagePath, ...options });
    cleanups.push(() => service.flush());
    return service;
  }
  return {
    root,
    file,
    storagePath,
    instance,
    connection,
    queries,
    query,
    catalog,
  };
}

async function cacheFiles(directory: string): Promise<string[]> {
  return (await fs.readdir(directory).catch(() => []))
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(directory, name));
}

function metadataQueries(queries: string[]) {
  return queries.filter((sql) =>
    /information_schema\.(tables|schemata|columns)/.test(sql),
  );
}

describe("Catalog discovery", () => {
  it("lists tables, views and columns without evaluating data", async () => {
    const f = await fixture();
    const catalog = f.catalog();
    assert.deepEqual(await catalog.getSchemas("data"), [
      { database: "data", name: "main" },
    ]);
    const tables = await catalog.getTables("data", "main");
    assert.equal(tables.find((table) => table.name === "items")?.rowCount, 2);
    assert.equal(
      tables.find((table) => table.name === "expensive")?.rowCount,
      undefined,
    );
    assert.deepEqual(await catalog.getColumns("data", "main", "items"), [
      { name: "id", type: "INTEGER", isNullable: false },
      { name: "name", type: "VARCHAR", isNullable: true },
    ]);
    assert.equal(
      (await catalog.getColumns("data", "main", "expensive"))[0].name,
      "id",
    );
    assert.ok(!f.queries.some((sql) => /\b(COUNT|SUMMARIZE)\s*\(/i.test(sql)));
  });

  it("uses one discovery query for a large catalog and coalesces concurrent requests", async () => {
    const f = await fixture();
    await f.connection.run("BEGIN");
    for (let i = 0; i < 200; i++) {
      await f.connection.run(`CREATE TABLE data.main.table_${i} (id INTEGER)`);
    }
    await f.connection.run("COMMIT");
    const catalog = f.catalog();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => catalog.getTables("data", "main")),
    );
    assert.equal(results[0].length, 202);
    assert.ok(results.every((rows) => rows.length === 202));
    assert.equal(metadataQueries(f.queries).length, 1);
    await catalog.getTables("data", "main");
    assert.equal(metadataQueries(f.queries).length, 1);
  });

  it("escapes catalog names and keeps dotted identifiers separate", async () => {
    const f = await fixture();
    await f.connection.run(`CREATE SCHEMA data."odd's.schema"`);
    await f.connection.run(
      `CREATE TABLE data."odd's.schema"."a'b.c" ("quoted""column" INTEGER)`,
    );
    const catalog = f.catalog();
    assert.equal(
      (await catalog.getTables("data", "odd's.schema"))[0].name,
      "a'b.c",
    );
    assert.equal(
      (await catalog.getColumns("data", "odd's.schema", "a'b.c"))[0].name,
      'quoted"column',
    );
    assert.deepEqual(await catalog.getColumns("data", "main", "a'b.c"), []);
  });

  it("does not cache failed discovery as an empty catalog", async () => {
    const f = await fixture();
    let fail = true;
    const catalog = f.catalog({}, async (sql) => {
      if (fail && sql.includes("information_schema.tables")) {
        fail = false;
        throw new Error("temporary failure");
      }
      return f.query(sql);
    });
    await assert.rejects(catalog.getTables("data"), /temporary failure/);
    assert.equal((await catalog.getTables("data")).length, 2);
  });

  it("shares catalog objects and fully qualified columns with autocomplete", async () => {
    const f = await fixture();
    const catalog = f.catalog();
    await catalog.getTables("data");
    await catalog.getColumns("data", "main", "items");
    const before = metadataQueries(f.queries).length;
    const sql = "SELECT  FROM data.main.items";
    const columns = await getAutocompleteSuggestions(
      f.query,
      sql,
      7,
      undefined,
      false,
      catalog,
    );
    assert.ok(columns.some((column) => column.suggestion === "id"));
    const tables = await getAutocompleteSuggestions(
      f.query,
      "SELECT * FROM data.main.",
      24,
      undefined,
      false,
      catalog,
    );
    assert.ok(tables.some((table) => table.suggestion === "data.main.items"));
    assert.equal(metadataQueries(f.queries).length, before);
    await f.connection.run("CREATE SCHEMA data.custom");
    await f.connection.run("CREATE TABLE data.custom.schema_item (id INTEGER)");
    catalog.invalidate();
    const schemas = await getAutocompleteSuggestions(
      f.query,
      "SELECT * FROM custom.",
      21,
      undefined,
      false,
      catalog,
    );
    assert.ok(
      schemas.some((table) => table.suggestion === "custom.schema_item"),
    );
  });
});

describe("Persistent catalog snapshots", () => {
  it("restores discovered pages across service restarts before validation finishes", async () => {
    const f = await fixture();
    const first = f.catalog();
    await first.getSchemas("data");
    const tables = await first.getTables("data");
    const columns = await first.getColumns("data", "main", "items");
    await first.flush();
    assert.equal((await cacheFiles(f.storagePath)).length, 1);
    const gate = deferred();
    const second = f.catalog({}, async (sql) => {
      if (/information_schema\./.test(sql)) {
        await gate.promise;
      }
      return f.query(sql);
    });
    try {
      assert.deepEqual(await second.getTables("data"), tables);
      assert.equal(second.isValidating("data"), true);
      assert.deepEqual(
        await second.getColumns("data", "main", "items"),
        columns,
      );
    } finally {
      gate.resolve();
      await second.flush();
    }
    assert.equal(second.isValidating("data"), false);
    // Validating one page must not discard other previously discovered pages.
    const third = f.catalog();
    assert.deepEqual(await third.getColumns("data", "main", "items"), columns);
  });

  it("survives the extension's initialization and auto-attach lifecycle", async () => {
    const f = await fixture();
    const first = f.catalog();
    await first.getTables("data");
    await first.flush();
    const service = new DuckDBService();
    cleanups.push(() => service.close());
    service.catalog.configure({ storagePath: f.storagePath });
    await service.initialize();
    await service.run("SET threads=2");
    await service.run(`ATTACH ${sqlString(f.file)} AS data`);
    const gate = deferred();
    const query = service.query.bind(service);
    service.query = async (sql) => {
      if (/information_schema\./.test(sql)) {
        await gate.promise;
      }
      return query(sql);
    };
    try {
      assert.equal((await service.catalog.getTables("data")).length, 2);
      assert.equal(service.catalog.isValidating("data"), true);
    } finally {
      gate.resolve();
      await service.catalog.flush();
    }
  });

  it("does not use an old snapshot after the database or WAL changes", async () => {
    const f = await fixture();
    const first = f.catalog();
    await first.getTables("data");
    await first.flush();
    await f.connection.run("CREATE TABLE data.main.new_table (id INTEGER)");
    const second = f.catalog();
    assert.ok(
      (await second.getTables("data")).some(
        (table) => table.name === "new_table",
      ),
    );
    assert.equal(second.isValidating("data"), false);
    await f.connection.run("CHECKPOINT data");
    assert.ok(
      (await first.getTables("data")).some(
        (table) => table.name === "new_table",
      ),
    );
  });

  it("rebinds an unchanged file to its new alias", async () => {
    const f = await fixture();
    const first = f.catalog();
    await first.getTables("data");
    await first.flush();
    await f.connection.run("DETACH data");
    await f.connection.run(`ATTACH ${sqlString(f.file)} AS renamed`);
    const second = f.catalog();
    assert.ok(
      (await second.getTables("renamed")).every(
        (table) => table.database === "renamed",
      ),
    );
    await assert.rejects(second.getTables("data"), /not attached/);
  });

  it("recovers from corrupt, incompatible, malformed and oversized snapshots", async () => {
    const f = await fixture();
    const first = f.catalog();
    await first.getTables("data");
    await first.flush();
    const [file] = await cacheFiles(f.storagePath);
    const original = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(original);
    const invalid = [
      "{broken",
      JSON.stringify({ ...parsed, version: -1 }),
      JSON.stringify({ ...parsed, pages: [['["tables"]', [{ name: 42 }]]] }),
      JSON.stringify({ ...parsed, pages: [['["unknown"]', []]] }),
    ];
    for (const content of invalid) {
      await fs.writeFile(file, content);
      const catalog = f.catalog();
      assert.equal((await catalog.getTables("data")).length, 2);
      await catalog.flush();
    }
    await fs.writeFile(file, original);
    const limited = f.catalog({ maxBytes: 10 });
    assert.equal((await limited.getTables("data")).length, 2);
    assert.equal(limited.isValidating("data"), false);
  });

  it("keeps persistence optional and excludes in-memory objects and result caches", async () => {
    const f = await fixture();
    await f.connection.run("CREATE TABLE local_memory (id INTEGER)");
    await f.connection.run("CREATE TEMP TABLE _cache_result (id INTEGER)");
    await f.connection.run(
      "CREATE TEMP TABLE temporary_user_table (id INTEGER)",
    );
    const memory = f.catalog();
    await memory.getTables("memory");
    await memory.flush();
    assert.deepEqual(await cacheFiles(f.storagePath), []);
    const disabled = f.catalog({ persist: false });
    await disabled.getTables("data");
    await disabled.flush();
    assert.deepEqual(await cacheFiles(f.storagePath), []);
    const tables = await disabled.getAllTables();
    assert.ok(!tables.some((table) => table.name === "_cache_result"));
    assert.ok(tables.some((table) => table.name === "temporary_user_table"));
  });

  it("continues discovery when cache storage is unwritable", async () => {
    const f = await fixture();
    const blocked = path.join(f.root, "not-a-directory");
    await fs.writeFile(blocked, "file");
    const errors: unknown[] = [];
    const catalog = f.catalog({
      storagePath: path.join(blocked, "cache"),
      onError: (error) => errors.push(error),
    });
    assert.equal((await catalog.getTables("data")).length, 2);
    await catalog.flush();
    assert.ok(errors.length > 0);
  });
});

describe("Catalog invalidation", () => {
  it("force refresh bypasses persisted pages and rejects stale in-flight results", async () => {
    const f = await fixture();
    const gate = deferred();
    const started = deferred();
    let block = true;
    const catalog = f.catalog({}, async (sql) => {
      const rows = await f.query(sql);
      if (block && sql.includes("information_schema.tables")) {
        block = false;
        started.resolve();
        await gate.promise;
      }
      return rows;
    });
    const old = catalog.getTables("data");
    await started.promise;
    catalog.invalidate();
    await f.connection.run("CREATE TABLE data.main.after_refresh (id INTEGER)");
    try {
      assert.ok(
        (await catalog.getTables("data")).some(
          (table) => table.name === "after_refresh",
        ),
      );
    } finally {
      gate.resolve();
    }
    assert.ok((await old).some((table) => table.name === "after_refresh"));
    await catalog.flush();
    assert.ok(
      (await f.catalog().getTables("data")).some(
        (table) => table.name === "after_refresh",
      ),
    );
  });

  it("never persists metadata discovered inside a transaction", async () => {
    const f = await fixture();
    const catalog = f.catalog();
    await catalog.getColumns("data", "main", "items");
    await catalog.flush();
    await f.connection.run("BEGIN");
    catalog.statementExecuted("/* user transaction */ BEGIN");
    await f.connection.run(
      "ALTER TABLE data.main.items ADD COLUMN private_change BOOLEAN",
    );
    catalog.statementExecuted(
      "ALTER TABLE data.main.items ADD COLUMN private_change BOOLEAN",
    );
    assert.equal((await catalog.getColumns("data", "main", "items")).length, 3);
    await catalog.flush();
    assert.deepEqual(await cacheFiles(f.storagePath), []);
    await f.connection.run("ROLLBACK");
    catalog.statementExecuted("ROLLBACK");
    assert.equal((await catalog.getColumns("data", "main", "items")).length, 2);
  });

  it("revalidates cached metadata in the background after its TTL", async () => {
    const f = await fixture();
    let changes = 0;
    const catalog = f.catalog({ ttlMs: 0, onDidChange: () => changes++ });
    await catalog.getTables("data");
    // Memory-only catalog changes need the live revalidation path, not file stat.
    await f.connection.run("CREATE TABLE another (id INTEGER)");
    await catalog.getTables("memory");
    await f.connection.run("CREATE TABLE additional (id INTEGER)");
    const cached = await catalog.getTables("memory");
    assert.ok(!cached.some((table) => table.name === "additional"));
    await catalog.flush();
    assert.ok(changes > 0);
    assert.ok(
      (await catalog.getTables("memory")).some(
        (table) => table.name === "additional",
      ),
    );
  });

  it("invalidates successful statements before a later statement in a batch fails", async () => {
    const service = new DuckDBService();
    cleanups.push(() => service.close());
    await service.initialize();
    await service.catalog.getTables("memory");
    await assert.rejects(
      service.executeQuery(
        "CREATE TABLE new_table (id INTEGER); SELECT * FROM does_not_exist",
        10,
      ),
    );
    assert.ok(
      (await service.catalog.getTables("memory")).some(
        (table) => table.name === "new_table",
      ),
    );
    await service.executeQuery(
      "ALTER TABLE new_table ADD COLUMN name VARCHAR",
      10,
    );
    assert.equal(
      (await service.catalog.getColumns("memory", "main", "new_table")).length,
      2,
    );
  });
});

describe("Catalog cache boundaries", () => {
  it("evicts old snapshots to enforce the total disk budget", async () => {
    const f = await fixture();
    await f.connection.run(
      `ATTACH ${sqlString(path.join(f.root, "second.duckdb"))} AS second`,
    );
    await f.connection.run("CREATE TABLE second.main.a (id INTEGER)");
    await f.connection.run("CREATE TABLE second.main.b (id INTEGER)");
    await f.connection.run("CHECKPOINT second");
    const catalog = f.catalog();
    await catalog.getTables("data");
    await catalog.flush();
    const [firstFile] = await cacheFiles(f.storagePath);
    const budget = (await fs.stat(firstFile)).size + 100;
    catalog.configure({ storagePath: f.storagePath, maxBytes: budget });
    await catalog.getTables("data");
    await catalog.flush();
    await catalog.getTables("second");
    await catalog.flush();
    const files = await cacheFiles(f.storagePath);
    assert.equal(files.length, 1);
    const bytes = await Promise.all(
      files.map(async (file) => (await fs.stat(file)).size),
    );
    assert.ok(bytes.reduce((total, size) => total + size, 0) <= budget);
  });

  it("preserves unrelated databases during a targeted refresh", async () => {
    const f = await fixture();
    const catalog = f.catalog();
    await catalog.getTables("data");
    await catalog.getTables("memory");
    const before = metadataQueries(f.queries).length;
    catalog.refresh("data");
    await catalog.getTables("memory");
    assert.equal(metadataQueries(f.queries).length, before);
    await catalog.getTables("data");
    assert.equal(metadataQueries(f.queries).length, before + 1);
  });

  it("does not reuse a snapshot when an alias points to a different file", async () => {
    const f = await fixture();
    const catalog = f.catalog();
    await catalog.getTables("data");
    await catalog.flush();
    await f.connection.run("DETACH data");
    await f.connection.run(
      `ATTACH ${sqlString(path.join(f.root, "replacement.duckdb"))} AS data`,
    );
    await f.connection.run("CREATE TABLE data.main.replacement (id INTEGER)");
    await f.connection.run("CHECKPOINT data");
    catalog.statementExecuted("ATTACH 'replacement.duckdb' AS data");
    const tables = await catalog.getTables("data");
    assert.deepEqual(
      tables.map((table) => table.name),
      ["replacement"],
    );
    assert.equal(catalog.isValidating("data"), false);
  });

  it("keeps remote catalogs in memory even if their path resembles a local file", async () => {
    const f = await fixture();
    const catalog = f.catalog({}, async (sql) => {
      const rows = await f.query(sql);
      return sql.includes("duckdb_databases()")
        ? rows.map((row) => ({ ...row, type: "postgres" }))
        : rows;
    });
    await catalog.getTables("data");
    await catalog.flush();
    assert.deepEqual(await cacheFiles(f.storagePath), []);
  });

  it("does not retry failed background validation on every tree redraw", async () => {
    const f = await fixture();
    const first = f.catalog();
    await first.getTables("data");
    await first.flush();
    let validations = 0;
    const second = f.catalog({}, async (sql) => {
      if (sql.includes("information_schema.tables")) {
        validations++;
        throw new Error("unavailable");
      }
      return f.query(sql);
    });
    assert.equal((await second.getTables("data")).length, 2);
    await second.flush();
    assert.equal(second.isValidating("data"), false);
    assert.equal((await second.getTables("data")).length, 2);
    assert.equal(validations, 1);
  });
});

describe("Catalog shutdown", () => {
  it("drains snapshot writes without waiting for a blocked validation query", async () => {
    const f = await fixture();
    const first = f.catalog();
    await first.getTables("data");
    await first.flush();
    const gate = deferred();
    const started = deferred();
    let changes = 0;
    const second = f.catalog({ onDidChange: () => changes++ }, async (sql) => {
      if (sql.includes("information_schema.tables")) {
        started.resolve();
        await gate.promise;
      }
      return f.query(sql);
    });
    const pending = second.getTables("data");
    await started.promise;
    const validating = second.flush();
    try {
      await second.close();
      await pending;
      const before = changes;
      gate.resolve();
      await validating;
      assert.equal(changes, before);
      await assert.rejects(second.getTables("data"), /closed/);
    } finally {
      gate.resolve();
    }
  });

  it("writes discovered metadata when closed immediately after discovery", async () => {
    const f = await fixture();
    const first = f.catalog();
    await first.getTables("data");
    await first.close();
    assert.equal((await cacheFiles(f.storagePath)).length, 1);
    assert.equal((await f.catalog().getTables("data")).length, 2);
  });
});
