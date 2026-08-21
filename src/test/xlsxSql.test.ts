/** Unit tests for XLSX SQL construction. */
import assert from "node:assert";
import { describe, it } from "node:test";
import { buildReadXlsxSource } from "../services/duckdb";

describe("buildReadXlsxSource", () => {
  it("lets DuckDB select the first sheet when no name is available", () => {
    assert.strictEqual(
      buildReadXlsxSource("/tmp/book.xlsx"),
      "read_xlsx('/tmp/book.xlsx', ignore_errors = true)"
    );
  });

  it("escapes file and sheet names when selecting a discovered sheet", () => {
    assert.strictEqual(
      buildReadXlsxSource("/tmp/O'Brien.xlsx", "Owner's data"),
      "read_xlsx('/tmp/O''Brien.xlsx', sheet = 'Owner''s data', ignore_errors = true)"
    );
  });
});
