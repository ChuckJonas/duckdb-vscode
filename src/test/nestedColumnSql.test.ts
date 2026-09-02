/**
 * Integration tests: nested STRUCT column references must produce valid SQL
 * against a real DuckDB connection (sort / filter / stats / distinct).
 *
 * Run with: npx tsx --test src/test/nestedColumnSql.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";
import { quoteColumnRef, columnRefLabel } from "../shared/columnRef";
import { buildNestedColumns } from "../shared/nestedColumns";

describe("nested column SQL", () => {
  let instance: DuckDBInstance;
  let connection: DuckDBConnection;

  before(async () => {
    instance = await DuckDBInstance.create(":memory:");
    connection = await instance.connect();
    // A struct column with a nested struct, plus an awkward field name
    // containing a dot and a quote to prove segment-wise quoting works.
    await connection.run(`
      CREATE TABLE t AS
      SELECT * FROM (VALUES
        (1, {'x': 10, 'y': {'z': 'alpha'}, 'we.ird': 'a'}),
        (2, {'x': 30, 'y': {'z': 'beta'},  'we.ird': 'b'}),
        (3, {'x': 20, 'y': {'z': 'alpha'}, 'we.ird': 'a'})
      ) AS v(id, s)
    `);
  });

  after(async () => {
    connection?.closeSync();
    instance?.closeSync();
  });

  async function rows(sql: string): Promise<Record<string, unknown>[]> {
    const reader = await connection.runAndReadAll(sql);
    return reader.getRowObjectsJS() as Record<string, unknown>[];
  }

  it("derives leaf paths from the real DESCRIBE type string", async () => {
    const described = await rows(`DESCRIBE t`);
    const names = described.map((r) => String(r.column_name));
    const types = described.map((r) => String(r.column_type));

    // Depth 2 expands two struct levels: s -> {x,y,we.ird}, then s.y -> z.
    const deep = buildNestedColumns(names, types, 2);
    assert.deepStrictEqual(
      deep.leaves.map((l) => columnRefLabel(l.path)),
      ["id", "s.x", "s.y.z", "s.we.ird"],
    );

    // Depth 1 stops after the first level, leaving s.y as a STRUCT leaf.
    const shallow = buildNestedColumns(names, types, 1);
    assert.deepStrictEqual(
      shallow.leaves.map((l) => columnRefLabel(l.path)),
      ["id", "s.x", "s.y", "s.we.ird"],
    );
    assert.match(
      shallow.leaves.find((l) => columnRefLabel(l.path) === "s.y")!.type,
      /^STRUCT/i,
    );
  });

  it("sorts by a nested field", async () => {
    const col = quoteColumnRef(["s", "x"]);
    const result = await rows(
      `SELECT id FROM t ORDER BY ${col} DESC NULLS LAST`,
    );
    assert.deepStrictEqual(
      result.map((r) => Number(r.id)),
      [2, 3, 1],
    );
  });

  it("sorts by a doubly-nested field", async () => {
    const col = quoteColumnRef(["s", "y", "z"]);
    const result = await rows(`SELECT id FROM t ORDER BY ${col} ASC, id ASC`);
    assert.deepStrictEqual(
      result.map((r) => Number(r.id)),
      [1, 3, 2],
    );
  });

  it("filters on a nested field", async () => {
    const col = quoteColumnRef(["s", "y", "z"]);
    const result = await rows(`SELECT id FROM t WHERE ${col} = 'alpha'`);
    assert.deepStrictEqual(result.map((r) => Number(r.id)).sort(), [1, 3]);
  });

  it("handles a field name containing a dot", async () => {
    const col = quoteColumnRef(["s", "we.ird"]);
    const result = await rows(`SELECT id FROM t WHERE ${col} = 'b'`);
    assert.deepStrictEqual(
      result.map((r) => Number(r.id)),
      [2],
    );
    // The naive `"s.we.ird"` form must NOT resolve — this is the bug the
    // segment-wise quoting exists to prevent.
    await assert.rejects(() => rows(`SELECT "s.we.ird" FROM t`));
  });

  it("computes distinct values and cardinality on a nested field", async () => {
    const col = quoteColumnRef(["s", "y", "z"]);
    const distinct = await rows(`
      SELECT ${col}::VARCHAR as value, COUNT(*) as count
      FROM t WHERE ${col} IS NOT NULL
      GROUP BY 1 ORDER BY count DESC, value ASC
    `);
    assert.deepStrictEqual(
      distinct.map((r) => [String(r.value), Number(r.count)]),
      [
        ["alpha", 2],
        ["beta", 1],
      ],
    );

    const card = await rows(
      `SELECT COUNT(DISTINCT ${col}) as cardinality FROM t`,
    );
    assert.strictEqual(Number(card[0].cardinality), 2);
  });

  it("computes aggregate stats on a nested numeric field", async () => {
    const col = quoteColumnRef(["s", "x"]);
    const stats = await rows(`
      SELECT COUNT(*) as total, COUNT(${col}) as non_null,
             COUNT(DISTINCT ${col}) as unique_count,
             MIN(${col})::VARCHAR as min_val, MAX(${col})::VARCHAR as max_val,
             AVG(${col}) as mean_val
      FROM t
    `);
    const row = stats[0];
    assert.strictEqual(Number(row.total), 3);
    assert.strictEqual(Number(row.non_null), 3);
    assert.strictEqual(Number(row.unique_count), 3);
    assert.strictEqual(String(row.min_val), "10");
    assert.strictEqual(String(row.max_val), "30");
    assert.strictEqual(Number(row.mean_val), 20);
  });

  it("SUMMARIZEs a nested-leaf projection under dotted aliases", async () => {
    const described = await rows(`DESCRIBE t`);
    const model = buildNestedColumns(
      described.map((r) => String(r.column_name)),
      described.map((r) => String(r.column_type)),
      3,
    );
    const nestedLeaves = model.leaves.filter((l) => l.isNested);
    const projection = nestedLeaves
      .map(
        (l) =>
          `${quoteColumnRef(l.path)} AS "${columnRefLabel(l.path).replace(
            /"/g,
            '""',
          )}"`,
      )
      .join(", ");

    const summary = await rows(`SUMMARIZE (SELECT ${projection} FROM "t")`);
    const names = summary.map((r) => String(r.column_name));
    assert.deepStrictEqual(names, ["s.x", "s.y.z", "s.we.ird"]);
    const sx = summary.find((r) => String(r.column_name) === "s.x")!;
    assert.strictEqual(Number(sx.approx_unique), 3);
  });
});
