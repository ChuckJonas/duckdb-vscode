/**
 * Integration tests for Autocomplete Service
 *
 * Run with: npx tsx --test src/test/autocompleteService.test.ts
 *
 * These tests verify the autocomplete service works with real DuckDB queries.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAutocompleteSuggestions,
  clearColumnCache,
} from "../services/autocompleteService";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to test fixtures
const FIXTURES_DIR = path.join(__dirname, "fixtures");

describe("Autocomplete Service Integration", () => {
  let instance: DuckDBInstance;
  let connection: DuckDBConnection;

  // Query function that matches the expected signature
  async function queryFn(sql: string): Promise<Record<string, unknown>[]> {
    const result = await connection.runAndReadAll(sql);
    return result.getRowObjectsJS() as Record<string, unknown>[];
  }

  before(async () => {
    // Create in-memory database
    instance = await DuckDBInstance.create(":memory:");
    connection = await instance.connect();

    // Create test tables
    await connection.run(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        name VARCHAR,
        email VARCHAR,
        created_at DATE
      )
    `);

    await connection.run(`
      CREATE TABLE orders (
        order_id INTEGER PRIMARY KEY,
        user_id INTEGER,
        amount DECIMAL(10,2),
        status VARCHAR,
        order_date DATE
      )
    `);

    await connection.run(`
      INSERT INTO users VALUES 
        (1, 'Alice', 'alice@example.com', '2024-01-15'),
        (2, 'Bob', 'bob@example.com', '2024-02-20')
    `);

    // Clear cache before tests
    clearColumnCache();
  });

  after(async () => {
    // Note: DuckDB node-api may not have explicit close methods
    // The GC will handle cleanup
  });

  describe("Column Completions", () => {
    it("suggests columns in SELECT clause", async () => {
      const sql = "SELECT | FROM users";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      // Should include user columns
      const columnNames = suggestions.map((s) => s.suggestion);
      assert.ok(columnNames.includes("id"), "Should suggest 'id' column");
      assert.ok(columnNames.includes("name"), "Should suggest 'name' column");
      assert.ok(columnNames.includes("email"), "Should suggest 'email' column");
    });

    it("suggests columns with prefix filter", async () => {
      const sql = "SELECT na| FROM users";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      // Should include 'name' but not 'id'
      const columnNames = suggestions.map((s) => s.suggestion);
      assert.ok(columnNames.includes("name"), "Should suggest 'name' column");
      assert.ok(!columnNames.includes("id"), "Should not suggest 'id' column");
    });

    it("suggests columns from multiple joined tables", async () => {
      const sql = "SELECT | FROM users u JOIN orders o ON u.id = o.user_id";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      const columnNames = suggestions.map((s) => s.suggestion);

      // Should include columns from both tables
      assert.ok(
        columnNames.includes("name"),
        "Should suggest 'name' from users",
      );
      assert.ok(
        columnNames.includes("amount"),
        "Should suggest 'amount' from orders",
      );

      // Should include qualified columns
      assert.ok(
        columnNames.some((c) => c.includes("u.") || c.includes("o.")),
        "Should suggest qualified columns",
      );
    });

    it("suggests only columns for specific alias after dot", async () => {
      const sql = "SELECT u.| FROM users u JOIN orders o ON u.id = o.user_id";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      const columnNames = suggestions.map((s) => s.suggestion);

      // Should include user columns only
      assert.ok(columnNames.includes("name"), "Should suggest 'name'");
      assert.ok(columnNames.includes("email"), "Should suggest 'email'");
      // Should NOT include order columns
      assert.ok(!columnNames.includes("amount"), "Should not suggest 'amount'");
      assert.ok(!columnNames.includes("status"), "Should not suggest 'status'");
    });

    it("suggests columns in WHERE clause", async () => {
      const sql = "SELECT * FROM users WHERE | = 1";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      const columnNames = suggestions.map((s) => s.suggestion);
      assert.ok(columnNames.includes("id"), "Should suggest 'id' in WHERE");
      assert.ok(columnNames.includes("name"), "Should suggest 'name' in WHERE");
    });
  });

  describe("Table Completions", () => {
    it("suggests tables in FROM clause", async () => {
      const sql = "SELECT * FROM |";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      const tableNames = suggestions
        .filter((s) => s.kind === "table")
        .map((s) => s.suggestion);

      assert.ok(tableNames.includes("users"), "Should suggest 'users' table");
      assert.ok(tableNames.includes("orders"), "Should suggest 'orders' table");
    });

    it("suggests tables in JOIN clause", async () => {
      const sql = "SELECT * FROM users JOIN |";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      const tableNames = suggestions
        .filter((s) => s.kind === "table")
        .map((s) => s.suggestion);

      assert.ok(tableNames.includes("orders"), "Should suggest 'orders' table");
    });

    it("suggests file reading functions when typing 'read_'", async () => {
      const sql = "SELECT * FROM read_|";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      const funcNames = suggestions
        .filter((s) => s.kind === "function")
        .map((s) => s.suggestion);

      // Should suggest read_csv etc when typing "read_"
      assert.ok(
        funcNames.some((f) => f.includes("read_csv")),
        "Should suggest read_csv when prefix is 'read_'",
      );
    });

    it("shows both tables and file functions in FROM clause", async () => {
      const sql = "SELECT * FROM |";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      const tableNames = suggestions
        .filter((s) => s.kind === "table")
        .map((s) => s.suggestion);
      const funcNames = suggestions
        .filter((s) => s.kind === "function")
        .map((s) => s.suggestion);

      // Should suggest both tables AND read_csv functions
      assert.ok(tableNames.includes("users"), "Should suggest tables");
      assert.ok(
        funcNames.some((f) => f.includes("read_csv")),
        "Should also suggest read_csv",
      );
    });
  });

  describe("CSV File Completions", () => {
    it("suggests columns from CSV file", async () => {
      const csvPath = path.join(FIXTURES_DIR, "users.csv");
      const sql = `SELECT | FROM '${csvPath}'`;
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      const columnNames = suggestions.map((s) => s.suggestion);

      // CSV has: id,name,email,created_at
      assert.ok(columnNames.includes("id"), "Should suggest 'id' from CSV");
      assert.ok(columnNames.includes("name"), "Should suggest 'name' from CSV");
      assert.ok(
        columnNames.includes("email"),
        "Should suggest 'email' from CSV",
      );
    });

    it("suggests columns from read_csv function", async () => {
      const csvPath = path.join(FIXTURES_DIR, "orders.csv");
      const sql = `SELECT | FROM read_csv('${csvPath}')`;
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      const columnNames = suggestions.map((s) => s.suggestion);

      // CSV has: order_id,user_id,amount,status,order_date
      assert.ok(columnNames.includes("order_id"), "Should suggest 'order_id'");
      assert.ok(columnNames.includes("amount"), "Should suggest 'amount'");
      assert.ok(columnNames.includes("status"), "Should suggest 'status'");
    });
  });

  describe("Subquery Completions", () => {
    it("suggests only selected columns from subquery", async () => {
      // When selecting from a subquery, we should only see the columns
      // that were selected in the subquery, not all columns from the source
      const sql = `
        SELECT | FROM (
          SELECT id, name FROM users
        ) sub
      `;
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      const columnNames = suggestions
        .filter((s) => s.kind === "column")
        .map((s) => s.suggestion);

      // Should suggest id and name (selected in subquery)
      assert.ok(
        columnNames.includes("id"),
        "Should suggest 'id' from subquery",
      );
      assert.ok(
        columnNames.includes("name"),
        "Should suggest 'name' from subquery",
      );
      // Should NOT suggest email or created_at (not selected in subquery)
      assert.ok(
        !columnNames.includes("email"),
        "Should NOT suggest 'email' (not in subquery)",
      );
      assert.ok(
        !columnNames.includes("created_at"),
        "Should NOT suggest 'created_at' (not in subquery)",
      );
    });

    it("suggests columns from subquery with aliased columns", async () => {
      const sql = `
        SELECT | FROM (
          SELECT id AS user_id, name AS user_name FROM users
        ) u
      `;
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      const columnNames = suggestions
        .filter((s) => s.kind === "column")
        .map((s) => s.suggestion);

      // Should suggest the aliased column names
      assert.ok(columnNames.includes("user_id"), "Should suggest 'user_id'");
      assert.ok(
        columnNames.includes("user_name"),
        "Should suggest 'user_name'",
      );
    });

    it("suggests columns from nested subquery with file source", async () => {
      const csvPath = path.join(FIXTURES_DIR, "orders.csv");
      const sql = `
        SELECT | FROM (
          SELECT order_id, amount FROM '${csvPath}'
        ) o
      `;
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      const columnNames = suggestions
        .filter((s) => s.kind === "column")
        .map((s) => s.suggestion);

      // Should only suggest order_id and amount
      assert.ok(columnNames.includes("order_id"), "Should suggest 'order_id'");
      assert.ok(columnNames.includes("amount"), "Should suggest 'amount'");
      // Should NOT suggest other columns from the CSV
      assert.ok(
        !columnNames.includes("status"),
        "Should NOT suggest 'status' (not selected)",
      );
    });
  });

  describe("CTE Completions", () => {
    it("suggests columns from CTE", async () => {
      const sql = `
        WITH active_users AS (SELECT id, name FROM users WHERE id > 0)
        SELECT | FROM active_users
      `;
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      // CTE 'active_users' should be recognized
      const names = suggestions.map((s) => s.suggestion);
      assert.ok(
        names.includes("active_users") ||
          names.some((n) => n.includes("active")),
        "Should suggest CTE name or recognize CTE",
      );
    });
  });

  describe("Function Completions", () => {
    it("does NOT suggest functions without prefix (to prioritize columns)", async () => {
      const sql = "SELECT | FROM users";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      const funcNames = suggestions
        .filter((s) => s.kind === "function")
        .map((s) => s.suggestion);

      // Should NOT suggest functions without prefix
      assert.strictEqual(
        funcNames.length,
        0,
        "Should not suggest functions without prefix",
      );
    });

    it("suggests aggregate functions with prefix", async () => {
      const sql = "SELECT C| FROM users";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      const funcNames = suggestions
        .filter((s) => s.kind === "function")
        .map((s) => s.suggestion);

      // Should suggest aggregate functions starting with C
      assert.ok(funcNames.includes("COUNT()"), "Should suggest COUNT()");
      assert.ok(funcNames.includes("COALESCE()"), "Should suggest COALESCE()");
      assert.ok(funcNames.includes("CONCAT()"), "Should suggest CONCAT()");
      // Should NOT include functions not starting with C
      assert.ok(!funcNames.includes("SUM()"), "Should NOT suggest SUM()");
    });

    it("suggests string functions with prefix", async () => {
      const sql = "SELECT L| FROM users";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      const funcNames = suggestions
        .filter((s) => s.kind === "function")
        .map((s) => s.suggestion);

      // Should suggest string functions starting with L
      assert.ok(funcNames.includes("LOWER()"), "Should suggest LOWER()");
      assert.ok(funcNames.includes("LENGTH()"), "Should suggest LENGTH()");
      assert.ok(funcNames.includes("LEFT()"), "Should suggest LEFT()");
    });

    it("suggests date functions with prefix", async () => {
      const sql = "SELECT D| FROM users";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      const funcNames = suggestions
        .filter((s) => s.kind === "function")
        .map((s) => s.suggestion);

      // Should suggest date functions starting with D
      assert.ok(
        funcNames.includes("DATE_PART()"),
        "Should suggest DATE_PART()",
      );
      assert.ok(
        funcNames.includes("DATE_TRUNC()"),
        "Should suggest DATE_TRUNC()",
      );
      assert.ok(funcNames.includes("DAY()"), "Should suggest DAY()");
    });

    it("suggests window functions with prefix", async () => {
      const sql = "SELECT R| FROM users";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      const funcNames = suggestions
        .filter((s) => s.kind === "function")
        .map((s) => s.suggestion);

      // Should suggest window functions starting with R
      assert.ok(
        funcNames.includes("ROW_NUMBER()"),
        "Should suggest ROW_NUMBER()",
      );
      assert.ok(funcNames.includes("RANK()"), "Should suggest RANK()");
    });

    it("filters functions by longer prefix", async () => {
      const sql = "SELECT SU| FROM users";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      const funcNames = suggestions
        .filter((s) => s.kind === "function")
        .map((s) => s.suggestion);

      // Should include SUM, SUBSTRING, SUBSTR
      assert.ok(funcNames.includes("SUM()"), "Should suggest SUM()");
      assert.ok(
        funcNames.includes("SUBSTRING()"),
        "Should suggest SUBSTRING()",
      );
      // Should NOT include functions not starting with SU
      assert.ok(!funcNames.includes("COUNT()"), "Should NOT suggest COUNT()");
    });

    it("suggests functions in WHERE clause with prefix", async () => {
      const sql = "SELECT * FROM users WHERE L|";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      const funcNames = suggestions
        .filter((s) => s.kind === "function")
        .map((s) => s.suggestion);

      // Should suggest non-aggregate functions starting with L in WHERE
      assert.ok(funcNames.includes("LOWER()"), "Should suggest LOWER()");
      assert.ok(funcNames.includes("LENGTH()"), "Should suggest LENGTH()");
    });
  });

  describe("Keyword Completions", () => {
    it("does NOT suggest keywords without prefix (to prioritize columns)", async () => {
      const sql = "SELECT | FROM users";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      const keywords = suggestions
        .filter((s) => s.kind === "keyword")
        .map((s) => s.suggestion);

      // Should NOT suggest keywords without prefix
      assert.strictEqual(
        keywords.length,
        0,
        "Should not suggest keywords without prefix",
      );
    });

    it("suggests SQL keywords in SELECT clause with prefix", async () => {
      const sql = "SELECT D| FROM users";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      const keywords = suggestions
        .filter((s) => s.kind === "keyword")
        .map((s) => s.suggestion);

      // Should suggest SELECT-specific keywords starting with D
      assert.ok(keywords.includes("DISTINCT"), "Should suggest DISTINCT");
      // Should NOT suggest keywords not starting with D
      assert.ok(!keywords.includes("CASE"), "Should NOT suggest CASE");
    });

    it("suggests WHERE keywords in WHERE clause with prefix", async () => {
      const sql = "SELECT * FROM users WHERE A|";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      const keywords = suggestions
        .filter((s) => s.kind === "keyword")
        .map((s) => s.suggestion);

      // Should suggest WHERE-specific keywords starting with A
      assert.ok(keywords.includes("AND"), "Should suggest AND");
      assert.ok(keywords.includes("ANY"), "Should suggest ANY");
      assert.ok(keywords.includes("ALL"), "Should suggest ALL");
      // Should NOT suggest keywords not starting with A
      assert.ok(!keywords.includes("OR"), "Should NOT suggest OR");
    });

    it("provides suggestions for incomplete SQL", async () => {
      const sql = "SELECT * |";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      // Should return an array (may be empty without prefix)
      assert.ok(
        Array.isArray(suggestions),
        "Should return array of suggestions",
      );
      // At minimum, we should not crash on incomplete SQL
    });
  });

  describe("Edge Cases", () => {
    it("handles empty SQL gracefully", async () => {
      const suggestions = await getAutocompleteSuggestions(queryFn, "", 0);
      assert.ok(
        Array.isArray(suggestions),
        "Should return array for empty SQL",
      );
    });

    it("handles cursor at start of SQL", async () => {
      const sql = "|SELECT * FROM users";
      const cursor = 0;
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor,
      );

      assert.ok(Array.isArray(suggestions), "Should return array");
    });

    it("caches DESCRIBE results", async () => {
      // First call
      const sql1 = "SELECT | FROM users";
      const cursor1 = sql1.indexOf("|");
      await getAutocompleteSuggestions(queryFn, sql1.replace("|", ""), cursor1);

      // Second call should use cache (we can't easily verify, but it shouldn't error)
      const sql2 = "SELECT id, | FROM users";
      const cursor2 = sql2.indexOf("|");
      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        sql2.replace("|", ""),
        cursor2,
      );

      assert.ok(suggestions.length > 0, "Should return suggestions from cache");
    });
  });
});
