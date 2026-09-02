/**
 * Unit tests for nested-column expansion (STRUCT → grouped sub-columns).
 *
 * Run with: npx tsx --test src/test/nestedColumns.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  parseStructFields,
  buildNestedColumns,
  getValueAtPath,
} from "../shared/nestedColumns";

describe("parseStructFields", () => {
  it("parses a flat struct", () => {
    assert.deepStrictEqual(parseStructFields("STRUCT(a INTEGER, b VARCHAR)"), [
      { name: "a", type: "INTEGER" },
      { name: "b", type: "VARCHAR" },
    ]);
  });

  it("parses nested structs", () => {
    assert.deepStrictEqual(
      parseStructFields("STRUCT(a INTEGER, b STRUCT(c VARCHAR, d DOUBLE))"),
      [
        { name: "a", type: "INTEGER" },
        { name: "b", type: "STRUCT(c VARCHAR, d DOUBLE)" },
      ],
    );
  });

  it("handles quoted identifiers with commas, parens, and escaped quotes", () => {
    assert.deepStrictEqual(
      parseStructFields('STRUCT("a, (b)" INTEGER, "say ""hi""" VARCHAR)'),
      [
        { name: "a, (b)", type: "INTEGER" },
        { name: 'say "hi"', type: "VARCHAR" },
      ],
    );
  });

  it("handles DECIMAL and parameterized types inside structs", () => {
    assert.deepStrictEqual(
      parseStructFields("STRUCT(x DECIMAL(18,3), y VARCHAR[])"),
      [
        { name: "x", type: "DECIMAL(18,3)" },
        { name: "y", type: "VARCHAR[]" },
      ],
    );
  });

  it("rejects non-structs and struct lists", () => {
    assert.strictEqual(parseStructFields("INTEGER"), null);
    assert.strictEqual(parseStructFields("MAP(VARCHAR, INTEGER)"), null);
    assert.strictEqual(parseStructFields("STRUCT(a INTEGER)[]"), null);
    assert.strictEqual(parseStructFields("STRUCT()"), null);
    // STRUCTs inside a list element type must not leak through.
    assert.strictEqual(parseStructFields("STRUCT(a INTEGER)[3]"), null);
  });
});

describe("buildNestedColumns", () => {
  it("keeps flat columns as a single header row", () => {
    const m = buildNestedColumns(["a", "b"], ["INTEGER", "VARCHAR"], 2);
    assert.strictEqual(m.hasNesting, false);
    assert.strictEqual(m.headerDepth, 1);
    assert.deepStrictEqual(
      m.leaves.map((l) => l.key),
      ["a", "b"],
    );
    assert.strictEqual(m.headerRows.length, 1);
    assert.deepStrictEqual(
      m.headerRows[0].map((c) => [c.label, c.colSpan, c.rowSpan, c.isGroup]),
      [
        ["a", 1, 1, false],
        ["b", 1, 1, false],
      ],
    );
  });

  it("expands a struct into grouped sub-columns", () => {
    const m = buildNestedColumns(
      ["id", "s"],
      ["INTEGER", "STRUCT(x INTEGER, y VARCHAR)"],
      2,
    );
    assert.strictEqual(m.hasNesting, true);
    assert.strictEqual(m.headerDepth, 2);
    assert.deepStrictEqual(
      m.leaves.map((l) => l.path),
      [["id"], ["s", "x"], ["s", "y"]],
    );
    // Row 0: id (rowSpan 2), s group (colSpan 2).
    assert.deepStrictEqual(
      m.headerRows[0].map((c) => [c.label, c.colSpan, c.rowSpan, c.isGroup]),
      [
        ["id", 1, 2, false],
        ["s", 2, 1, true],
      ],
    );
    // Row 1: x, y leaves.
    assert.deepStrictEqual(
      m.headerRows[1].map((c) => [c.label, c.colSpan, c.rowSpan, c.isGroup]),
      [
        ["x", 1, 1, false],
        ["y", 1, 1, false],
      ],
    );
  });

  it("stops expanding at maxDepth (default 2 = two struct levels)", () => {
    const type = "STRUCT(a STRUCT(b STRUCT(c INTEGER)))";
    const m2 = buildNestedColumns(["s"], [type], 2);
    // Level-2 leaf keeps its STRUCT type unexpanded.
    assert.deepStrictEqual(
      m2.leaves.map((l) => [l.path.join("."), l.type]),
      [["s.a.b", "STRUCT(c INTEGER)"]],
    );
    assert.strictEqual(m2.headerDepth, 3);

    const m3 = buildNestedColumns(["s"], [type], 3);
    assert.deepStrictEqual(
      m3.leaves.map((l) => l.path.join(".")),
      ["s.a.b.c"],
    );
  });

  it("maxDepth 0 disables expansion", () => {
    const m = buildNestedColumns(["s"], ["STRUCT(x INTEGER)"], 0);
    assert.strictEqual(m.hasNesting, false);
    assert.deepStrictEqual(
      m.leaves.map((l) => l.path),
      [["s"]],
    );
  });

  it("uses distinct keys for same-named fields in different structs", () => {
    const m = buildNestedColumns(
      ["a", "b"],
      ["STRUCT(x INTEGER)", "STRUCT(x INTEGER)"],
      2,
    );
    const keys = m.leaves.map((l) => l.key);
    assert.strictEqual(new Set(keys).size, keys.length);
  });
});

describe("getValueAtPath", () => {
  const row = {
    id: 7,
    s: { x: 1, y: { z: "deep" }, n: null },
  };

  it("reads top-level and nested values", () => {
    assert.strictEqual(getValueAtPath(row, ["id"]), 7);
    assert.strictEqual(getValueAtPath(row, ["s", "x"]), 1);
    assert.strictEqual(getValueAtPath(row, ["s", "y", "z"]), "deep");
  });

  it("returns null for null/missing intermediates", () => {
    assert.strictEqual(getValueAtPath(row, ["s", "n"]), null);
    assert.strictEqual(getValueAtPath(row, ["s", "n", "q"]), null);
    assert.strictEqual(getValueAtPath(row, ["missing", "x"]), null);
    assert.strictEqual(getValueAtPath({ s: null }, ["s", "x"]), null);
  });

  it("returns null when walking into a non-object", () => {
    assert.strictEqual(getValueAtPath({ s: 5 }, ["s", "x"]), null);
    assert.strictEqual(getValueAtPath({ s: [1, 2] }, ["s", "x"]), null);
  });
});
