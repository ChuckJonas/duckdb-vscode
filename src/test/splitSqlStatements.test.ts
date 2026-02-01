/**
 * Unit tests for splitSqlStatements
 *
 * Run with: npx tsx --test src/test/splitSqlStatements.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { splitSqlStatements } from "../services/duckdb";

describe("splitSqlStatements", () => {
  it("splits simple statements by semicolon", () => {
    const sql = "SELECT 1; SELECT 2;";
    const result = splitSqlStatements(sql, 2);
    assert.deepStrictEqual(result, ["SELECT 1", "SELECT 2"]);
  });

  it("handles statement without trailing semicolon", () => {
    const sql = "SELECT 1; SELECT 2";
    const result = splitSqlStatements(sql, 2);
    assert.deepStrictEqual(result, ["SELECT 1", "SELECT 2"]);
  });

  it("ignores semicolons inside single-quoted strings", () => {
    const sql = "SELECT 'hello; world'; SELECT 2;";
    const result = splitSqlStatements(sql, 2);
    assert.deepStrictEqual(result, ["SELECT 'hello; world'", "SELECT 2"]);
  });

  it("ignores semicolons inside double-quoted identifiers", () => {
    const sql = 'SELECT "col;name"; SELECT 2;';
    const result = splitSqlStatements(sql, 2);
    assert.deepStrictEqual(result, ['SELECT "col;name"', "SELECT 2"]);
  });

  it("ignores semicolons inside single-line comments", () => {
    const sql = "SELECT 1; -- comment with; semicolon\nSELECT 2;";
    const result = splitSqlStatements(sql, 2);
    assert.deepStrictEqual(result, [
      "SELECT 1",
      "-- comment with; semicolon\nSELECT 2",
    ]);
  });

  it("ignores semicolons inside multi-line comments", () => {
    const sql = "SELECT 1; /* comment; with; semicolons */ SELECT 2;";
    const result = splitSqlStatements(sql, 2);
    assert.deepStrictEqual(result, [
      "SELECT 1",
      "/* comment; with; semicolons */ SELECT 2",
    ]);
  });

  it("handles leading comments before a statement", () => {
    const sql = `-- CREATE SECRET...
-- );

SELECT * FROM table;`;
    // DuckDB's extractStatements would return count=1 for this
    // The comments are part of the statement since there's no ; separating them
    const result = splitSqlStatements(sql, 1);
    assert.strictEqual(result.length, 1);
    assert.ok(result[0].includes("SELECT * FROM table"));
  });

  it("filters out comment-only statements (with semicolon)", () => {
    const sql = `-- comment;
SELECT * FROM table;`;
    // The comment block ending with ; is filtered out (comment-only)
    // DuckDB would return count=1 for this
    const result = splitSqlStatements(sql, 1);
    assert.strictEqual(result.length, 1);
    assert.ok(result[0].includes("SELECT"));
  });

  it("handles escaped single quotes", () => {
    const sql = "SELECT 'it''s; here'; SELECT 2;";
    const result = splitSqlStatements(sql, 2);
    assert.deepStrictEqual(result, ["SELECT 'it''s; here'", "SELECT 2"]);
  });

  it("handles dollar-quoted strings", () => {
    const sql = "SELECT $$hello; world$$; SELECT 2;";
    const result = splitSqlStatements(sql, 2);
    assert.deepStrictEqual(result, ["SELECT $$hello; world$$", "SELECT 2"]);
  });

  it("handles tagged dollar-quoted strings", () => {
    const sql = "SELECT $tag$hello; world$tag$; SELECT 2;";
    const result = splitSqlStatements(sql, 2);
    assert.deepStrictEqual(result, [
      "SELECT $tag$hello; world$tag$",
      "SELECT 2",
    ]);
  });

  it("pads with placeholders when fewer statements found", () => {
    const sql = "SELECT 1;";
    // If DuckDB says there are 3 statements but we only find 1
    const result = splitSqlStatements(sql, 3);
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0], "SELECT 1");
    assert.strictEqual(result[1], "Statement 2");
    assert.strictEqual(result[2], "Statement 3");
  });

  it("truncates when more statements found than expected", () => {
    const sql = "SELECT 1; SELECT 2; SELECT 3;";
    // If DuckDB says there are only 2 statements
    const result = splitSqlStatements(sql, 2);
    assert.deepStrictEqual(result, ["SELECT 1", "SELECT 2"]);
  });

  it("handles empty input", () => {
    const result = splitSqlStatements("", 0);
    assert.deepStrictEqual(result, []);
  });

  it("handles whitespace-only input", () => {
    const result = splitSqlStatements("   \n\t  ", 0);
    assert.deepStrictEqual(result, []);
  });

  it("handles complex real-world example", () => {
    const sql = `
-- Setup tables
CREATE TABLE users (id INT, name VARCHAR);
INSERT INTO users VALUES (1, 'Alice; Bob');
SELECT * FROM users WHERE name LIKE '%Alice%';
`;
    const result = splitSqlStatements(sql, 3);
    assert.strictEqual(result.length, 3);
    assert.ok(result[0].includes("CREATE TABLE"));
    assert.ok(result[1].includes("INSERT INTO"));
    assert.ok(result[2].includes("SELECT"));
  });

  it("handles the exact bug report case", () => {
    const sql = `-- CREATE OR REPLACE SECRET secret (
--     TYPE s3,
--     PROVIDER credential_chain,
--     CHAIN config,
--     PROFILE 'eg-dev',
--     VALIDATION 'none'
-- );


SELECT * FROM 's3://dev-eg-radvice-code-interpeter-support/clients/user-21b9f634-da29-4f13-84d1-5127373bac45/_manifest.json';`;

    // DuckDB should see this as 1 statement (the SELECT)
    const result = splitSqlStatements(sql, 1);
    console.log("Result:", JSON.stringify(result, null, 2));
    assert.strictEqual(result.length, 1);
    assert.ok(result[0].includes("SELECT"), "Should contain SELECT");
  });
});
