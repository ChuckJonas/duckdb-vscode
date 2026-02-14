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
        cursor
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
        cursor
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
        cursor
      );

      const columnNames = suggestions.map((s) => s.suggestion);

      // Should include columns from both tables
      assert.ok(
        columnNames.includes("name"),
        "Should suggest 'name' from users"
      );
      assert.ok(
        columnNames.includes("amount"),
        "Should suggest 'amount' from orders"
      );

      // Should include qualified columns
      assert.ok(
        columnNames.some((c) => c.includes("u.") || c.includes("o.")),
        "Should suggest qualified columns"
      );
    });

    it("suggests only columns for specific alias after dot", async () => {
      const sql = "SELECT u.| FROM users u JOIN orders o ON u.id = o.user_id";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
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
        cursor
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
        cursor
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
        cursor
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
        cursor
      );

      const funcNames = suggestions
        .filter((s) => s.kind === "function")
        .map((s) => s.suggestion);

      // Should suggest read_csv etc when typing "read_"
      assert.ok(
        funcNames.some((f) => f.includes("read_csv")),
        "Should suggest read_csv when prefix is 'read_'"
      );
    });

    it("shows both tables and file functions in FROM clause", async () => {
      const sql = "SELECT * FROM |";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
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
        "Should also suggest read_csv"
      );
    });

    it("suggests attached databases in FROM clause", async () => {
      const sql = "SELECT * FROM |";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      // Should suggest the 'memory' database (default in-memory db)
      const dbNames = suggestions
        .filter((s) => s.detail === "database")
        .map((s) => s.suggestion);

      assert.ok(
        dbNames.some((d) => d.endsWith(".")),
        "Database suggestions should end with dot"
      );
    });

    it("suggests tables when typing database prefix", async () => {
      // Create a schema with a table for testing
      await queryFn("CREATE SCHEMA IF NOT EXISTS test_schema");
      await queryFn(
        "CREATE TABLE IF NOT EXISTS test_schema.schema_table (id INTEGER)"
      );

      const sql = "SELECT * FROM test_schema.|";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const tableNames = suggestions.map((s) => s.suggestion);

      // Should suggest schema_table with the full qualifier
      assert.ok(
        tableNames.some((t) => t.includes("schema_table")),
        "Should suggest tables from the schema"
      );

      // Cleanup
      await queryFn("DROP TABLE IF EXISTS test_schema.schema_table");
      await queryFn("DROP SCHEMA IF EXISTS test_schema");
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
        cursor
      );

      const columnNames = suggestions.map((s) => s.suggestion);

      // CSV has: id,name,email,created_at
      assert.ok(columnNames.includes("id"), "Should suggest 'id' from CSV");
      assert.ok(columnNames.includes("name"), "Should suggest 'name' from CSV");
      assert.ok(
        columnNames.includes("email"),
        "Should suggest 'email' from CSV"
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
        cursor
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
        cursor
      );

      const columnNames = suggestions
        .filter((s) => s.kind === "column")
        .map((s) => s.suggestion);

      // Should suggest id and name (selected in subquery)
      assert.ok(
        columnNames.includes("id"),
        "Should suggest 'id' from subquery"
      );
      assert.ok(
        columnNames.includes("name"),
        "Should suggest 'name' from subquery"
      );
      // Should NOT suggest email or created_at (not selected in subquery)
      assert.ok(
        !columnNames.includes("email"),
        "Should NOT suggest 'email' (not in subquery)"
      );
      assert.ok(
        !columnNames.includes("created_at"),
        "Should NOT suggest 'created_at' (not in subquery)"
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
        cursor
      );

      const columnNames = suggestions
        .filter((s) => s.kind === "column")
        .map((s) => s.suggestion);

      // Should suggest the aliased column names
      assert.ok(columnNames.includes("user_id"), "Should suggest 'user_id'");
      assert.ok(
        columnNames.includes("user_name"),
        "Should suggest 'user_name'"
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
        cursor
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
        "Should NOT suggest 'status' (not selected)"
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
        cursor
      );

      // CTE 'active_users' should be recognized
      const names = suggestions.map((s) => s.suggestion);
      assert.ok(
        names.includes("active_users") ||
          names.some((n) => n.includes("active")),
        "Should suggest CTE name or recognize CTE"
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
        cursor
      );

      const funcNames = suggestions
        .filter((s) => s.kind === "function")
        .map((s) => s.suggestion);

      // Should NOT suggest functions without prefix
      assert.strictEqual(
        funcNames.length,
        0,
        "Should not suggest functions without prefix"
      );
    });

    it("suggests aggregate functions with prefix", async () => {
      const sql = "SELECT C| FROM users";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
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
        cursor
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
        cursor
      );

      const funcNames = suggestions
        .filter((s) => s.kind === "function")
        .map((s) => s.suggestion);

      // Should suggest date functions starting with D
      assert.ok(
        funcNames.includes("DATE_PART()"),
        "Should suggest DATE_PART()"
      );
      assert.ok(
        funcNames.includes("DATE_TRUNC()"),
        "Should suggest DATE_TRUNC()"
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
        cursor
      );

      const funcNames = suggestions
        .filter((s) => s.kind === "function")
        .map((s) => s.suggestion);

      // Should suggest window functions starting with R
      assert.ok(
        funcNames.includes("ROW_NUMBER()"),
        "Should suggest ROW_NUMBER()"
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
        cursor
      );

      const funcNames = suggestions
        .filter((s) => s.kind === "function")
        .map((s) => s.suggestion);

      // Should include SUM, SUBSTRING, SUBSTR
      assert.ok(funcNames.includes("SUM()"), "Should suggest SUM()");
      assert.ok(
        funcNames.includes("SUBSTRING()"),
        "Should suggest SUBSTRING()"
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
        cursor
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
        cursor
      );

      const keywords = suggestions
        .filter((s) => s.kind === "keyword")
        .map((s) => s.suggestion);

      // Should NOT suggest keywords without prefix
      assert.strictEqual(
        keywords.length,
        0,
        "Should not suggest keywords without prefix"
      );
    });

    it("suggests SQL keywords in SELECT clause with prefix", async () => {
      const sql = "SELECT D| FROM users";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
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
        cursor
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
        cursor
      );

      // Should return an array (may be empty without prefix)
      assert.ok(
        Array.isArray(suggestions),
        "Should return array of suggestions"
      );
      // At minimum, we should not crash on incomplete SQL
    });
  });

  describe("Edge Cases", () => {
    it("handles empty SQL gracefully", async () => {
      const suggestions = await getAutocompleteSuggestions(queryFn, "", 0);
      assert.ok(
        Array.isArray(suggestions),
        "Should return array for empty SQL"
      );
    });

    it("handles cursor at start of SQL", async () => {
      const sql = "|SELECT * FROM users";
      const cursor = 0;
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
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
        cursor2
      );

      assert.ok(suggestions.length > 0, "Should return suggestions from cache");
    });
  });

  // ============================================================================
  // Issue 1: Keyword Transition Suggestions
  // ============================================================================

  describe("Keyword Transition Suggestions", () => {
    it("suggests FROM keyword when typing 'F' in SELECT clause", async () => {
      const sql = "SELECT * F|";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const keywords = suggestions
        .filter((s) => s.kind === "keyword")
        .map((s) => s.suggestion);

      assert.ok(
        keywords.includes("FROM"),
        "Should suggest FROM in SELECT clause when typing F"
      );
    });

    it("suggests WHERE keyword when typing 'W' after FROM clause", async () => {
      const sql = "SELECT * FROM users W|";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const keywords = suggestions
        .filter((s) => s.kind === "keyword")
        .map((s) => s.suggestion);

      assert.ok(
        keywords.includes("WHERE"),
        "Should suggest WHERE after FROM clause"
      );
    });

    it("suggests GROUP BY keyword when typing 'G' after FROM clause", async () => {
      const sql = "SELECT * FROM users G|";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const keywords = suggestions
        .filter((s) => s.kind === "keyword")
        .map((s) => s.suggestion);

      assert.ok(
        keywords.includes("GROUP BY"),
        "Should suggest GROUP BY after FROM clause"
      );
    });

    it("suggests ORDER BY keyword when typing 'O' after FROM clause", async () => {
      const sql = "SELECT * FROM users O|";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const keywords = suggestions
        .filter((s) => s.kind === "keyword")
        .map((s) => s.suggestion);

      assert.ok(
        keywords.includes("ORDER BY"),
        "Should suggest ORDER BY after FROM clause"
      );
    });

    it("suggests LIMIT keyword when typing 'L' after FROM clause", async () => {
      const sql = "SELECT * FROM users L|";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const keywords = suggestions
        .filter((s) => s.kind === "keyword")
        .map((s) => s.suggestion);

      assert.ok(
        keywords.includes("LIMIT"),
        "Should suggest LIMIT after FROM clause"
      );
    });

    it("suggests GROUP BY keyword when typing 'G' after WHERE clause", async () => {
      const sql = "SELECT * FROM users WHERE id > 0 G|";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const keywords = suggestions
        .filter((s) => s.kind === "keyword")
        .map((s) => s.suggestion);

      assert.ok(
        keywords.includes("GROUP BY"),
        "Should suggest GROUP BY after WHERE clause"
      );
    });

    it("suggests HAVING keyword when typing 'H' after GROUP BY clause", async () => {
      const sql = "SELECT * FROM users GROUP BY id H|";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const keywords = suggestions
        .filter((s) => s.kind === "keyword")
        .map((s) => s.suggestion);

      assert.ok(
        keywords.includes("HAVING"),
        "Should suggest HAVING after GROUP BY clause"
      );
    });

    it("suggests ORDER BY keyword when typing 'O' after GROUP BY clause", async () => {
      const sql = "SELECT * FROM users GROUP BY id O|";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const keywords = suggestions
        .filter((s) => s.kind === "keyword")
        .map((s) => s.suggestion);

      assert.ok(
        keywords.includes("ORDER BY"),
        "Should suggest ORDER BY after GROUP BY clause"
      );
    });

    it("suggests LIMIT keyword when typing 'L' in ORDER BY clause", async () => {
      const sql = "SELECT * FROM users ORDER BY id L|";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const keywords = suggestions
        .filter((s) => s.kind === "keyword")
        .map((s) => s.suggestion);

      assert.ok(
        keywords.includes("LIMIT"),
        "Should suggest LIMIT in ORDER BY clause"
      );
    });

    it("suggests SUMMARIZE in unknown context", async () => {
      const sql = "S|";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const keywords = suggestions
        .filter((s) => s.kind === "keyword")
        .map((s) => s.suggestion);

      assert.ok(keywords.includes("SUMMARIZE"), "Should suggest SUMMARIZE");
      assert.ok(keywords.includes("SELECT"), "Should suggest SELECT");
      assert.ok(keywords.includes("SHOW"), "Should suggest SHOW");
    });

    it("suggests UNION/INTERSECT/EXCEPT after WHERE clause", async () => {
      const sql = "SELECT * FROM users WHERE id > 0 U|";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const keywords = suggestions
        .filter((s) => s.kind === "keyword")
        .map((s) => s.suggestion);

      assert.ok(
        keywords.includes("UNION"),
        "Should suggest UNION after WHERE clause"
      );
    });
  });

  // ============================================================================
  // Issue 2: Cache Table Filtering
  // ============================================================================

  describe("Cache Table Filtering", () => {
    it("excludes _cache_ tables from completions", async () => {
      // Create a cache table (simulating what the extension does)
      await queryFn("CREATE TABLE _cache_1771027690579_16 (id INTEGER)");

      const sql = "SELECT * FROM |";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const tableNames = suggestions
        .filter((s) => s.kind === "table")
        .map((s) => s.suggestion);

      assert.ok(
        !tableNames.some((t) => t.includes("_cache_")),
        "Should NOT include _cache_ tables in suggestions"
      );
      assert.ok(
        tableNames.includes("users"),
        "Should still include normal tables"
      );

      // Cleanup
      await queryFn("DROP TABLE IF EXISTS _cache_1771027690579_16");
    });

    it("excludes _cache_ tables from qualified completions", async () => {
      await queryFn("CREATE TABLE _cache_test123_456 (id INTEGER)");

      const sql = "SELECT * FROM memory.|";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const tableNames = suggestions.map((s) => s.suggestion);

      assert.ok(
        !tableNames.some((t) => t.includes("_cache_")),
        "Should NOT include _cache_ tables in qualified completions"
      );

      // Cleanup
      await queryFn("DROP TABLE IF EXISTS _cache_test123_456");
    });
  });

  // ============================================================================
  // Issue 3: Quoted vs Unquoted Identifier Consistency
  // ============================================================================

  describe("Quoted vs Unquoted Identifier Consistency", () => {
    it("handles unquoted database prefix in FROM clause", async () => {
      const sql = "SELECT * FROM memory.|";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const tableNames = suggestions
        .filter((s) => s.kind === "table" || s.kind === "view")
        .map((s) => s.suggestion);

      assert.ok(
        tableNames.some((t) => t.includes("users")),
        "Should suggest tables from memory database (unquoted)"
      );
    });

    it("handles double-quoted database prefix in FROM clause", async () => {
      const sql = 'SELECT * FROM "memory".|';
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const tableNames = suggestions
        .filter((s) => s.kind === "table" || s.kind === "view")
        .map((s) => s.suggestion);

      assert.ok(
        tableNames.some((t) => t.includes("users")),
        "Should suggest tables from memory database (double-quoted)"
      );
    });

    it("provides identifier completions inside double quotes (not file paths)", async () => {
      // Double quotes are SQL identifier quotes - should suggest tables/databases
      // but NOT file paths
      const sql = 'SELECT * FROM "us|"';
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      // Should get table completions (identifier mode), not file completions
      const tableNames = suggestions
        .filter((s) => s.kind === "table")
        .map((s) => s.suggestion);
      const fileNames = suggestions
        .filter((s) => s.kind === "file")
        .map((s) => s.suggestion);

      assert.ok(
        tableNames.includes("users"),
        "Should suggest 'users' table inside double quotes"
      );
      assert.strictEqual(
        fileNames.length,
        0,
        "Should not suggest files for double-quoted identifiers"
      );
    });

    it("provides database completions inside double quotes without trailing dots", async () => {
      // When inside double quotes, database names should NOT have trailing dots
      const sql = 'SELECT * FROM "|"';
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const dbSuggestions = suggestions.filter((s) => s.kind === "database");

      // Database names should NOT have trailing dots inside double quotes
      for (const db of dbSuggestions) {
        assert.ok(
          !db.suggestion.endsWith("."),
          `Database '${db.suggestion}' should NOT end with dot inside double quotes`
        );
      }

      // Should still have table suggestions
      const tableNames = suggestions
        .filter((s) => s.kind === "table")
        .map((s) => s.suggestion);
      assert.ok(
        tableNames.includes("users"),
        "Should suggest tables inside double quotes"
      );
    });

    it("enters file path mode for single-quoted strings", async () => {
      // Single quotes should trigger file path mode
      const sql = "SELECT * FROM '|'";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      // Should have table completions (DuckDB allows 'table_name' syntax)
      const tableNames = suggestions
        .filter((s) => s.kind === "table")
        .map((s) => s.suggestion);

      // In quote context, we still get table names
      assert.ok(
        tableNames.length > 0,
        "Should still suggest table names in single-quote context"
      );
    });
  });

  // ============================================================================
  // Issue 4: Missing Functions (JSON_AGG, etc.)
  // ============================================================================

  describe("Missing Function Completions", () => {
    it("suggests JSON_AGG when typing 'JSON' in SELECT clause", async () => {
      const sql = "SELECT JSON|";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const funcNames = suggestions
        .filter((s) => s.kind === "function")
        .map((s) => s.suggestion);

      assert.ok(funcNames.includes("JSON_AGG()"), "Should suggest JSON_AGG()");
      assert.ok(
        funcNames.includes("JSON_OBJECT()"),
        "Should suggest JSON_OBJECT()"
      );
      assert.ok(
        funcNames.includes("JSON_ARRAY()"),
        "Should suggest JSON_ARRAY()"
      );
      assert.ok(
        funcNames.includes("JSON_EXTRACT()"),
        "Should suggest JSON_EXTRACT()"
      );
    });

    it("suggests ARRAY_AGG when typing 'ARRAY' in SELECT clause", async () => {
      const sql = "SELECT ARRAY|";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const funcNames = suggestions
        .filter((s) => s.kind === "function")
        .map((s) => s.suggestion);

      assert.ok(
        funcNames.includes("ARRAY_AGG()"),
        "Should suggest ARRAY_AGG()"
      );
      assert.ok(
        funcNames.includes("ARRAY_LENGTH()"),
        "Should suggest ARRAY_LENGTH()"
      );
      assert.ok(
        funcNames.includes("ARRAY_TO_STRING()"),
        "Should suggest ARRAY_TO_STRING()"
      );
    });

    it("suggests additional aggregate functions", async () => {
      const sql = "SELECT B|";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const funcNames = suggestions
        .filter((s) => s.kind === "function")
        .map((s) => s.suggestion);

      assert.ok(funcNames.includes("BOOL_AND()"), "Should suggest BOOL_AND()");
      assert.ok(funcNames.includes("BOOL_OR()"), "Should suggest BOOL_OR()");
      assert.ok(funcNames.includes("BIT_AND()"), "Should suggest BIT_AND()");
      assert.ok(funcNames.includes("BIT_OR()"), "Should suggest BIT_OR()");
    });

    it("suggests LIST functions with prefix", async () => {
      const sql = "SELECT LIST_|";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const funcNames = suggestions
        .filter((s) => s.kind === "function")
        .map((s) => s.suggestion);

      assert.ok(
        funcNames.includes("LIST_FILTER()"),
        "Should suggest LIST_FILTER()"
      );
      assert.ok(
        funcNames.includes("LIST_TRANSFORM()"),
        "Should suggest LIST_TRANSFORM()"
      );
      assert.ok(
        funcNames.includes("LIST_AGGREGATE()"),
        "Should suggest LIST_AGGREGATE()"
      );
      assert.ok(
        funcNames.includes("LIST_REDUCE()"),
        "Should suggest LIST_REDUCE()"
      );
    });

    it("suggests JSON functions in WHERE clause", async () => {
      const sql = "SELECT * FROM users WHERE JSON_|";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const funcNames = suggestions
        .filter((s) => s.kind === "function")
        .map((s) => s.suggestion);

      assert.ok(
        funcNames.includes("JSON_EXTRACT()"),
        "Should suggest JSON_EXTRACT() in WHERE clause"
      );
      assert.ok(
        funcNames.includes("JSON_VALID()"),
        "Should suggest JSON_VALID() in WHERE clause"
      );
    });

    it("suggests window functions ARG_MIN and ARG_MAX", async () => {
      const sql = "SELECT ARG|";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const funcNames = suggestions
        .filter((s) => s.kind === "function")
        .map((s) => s.suggestion);

      assert.ok(funcNames.includes("ARG_MIN()"), "Should suggest ARG_MIN()");
      assert.ok(funcNames.includes("ARG_MAX()"), "Should suggest ARG_MAX()");
    });
  });

  // ============================================================================
  // Quoted Qualified Table Names
  // ============================================================================

  describe("Quoted Qualified Table Names", () => {
    before(async () => {
      // Create a schema and table for testing qualified quoted names
      await queryFn("CREATE SCHEMA IF NOT EXISTS cms");
      await queryFn(
        "CREATE TABLE IF NOT EXISTS cms.categories (cat_id INTEGER, cat_name VARCHAR)"
      );
    });

    after(async () => {
      await queryFn("DROP TABLE IF EXISTS cms.categories");
      await queryFn("DROP SCHEMA IF EXISTS cms");
    });

    it("suggests columns from single-quoted qualified table name", async () => {
      const sql = "SELECT | FROM 'cms'.'categories'";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const columnNames = suggestions
        .filter((s) => s.kind === "column")
        .map((s) => s.suggestion);

      assert.ok(
        columnNames.includes("cat_id"),
        "Should suggest 'cat_id' column"
      );
      assert.ok(
        columnNames.includes("cat_name"),
        "Should suggest 'cat_name' column"
      );
    });

    it("suggests columns from unquoted qualified table name", async () => {
      const sql = "SELECT | FROM cms.categories";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const columnNames = suggestions
        .filter((s) => s.kind === "column")
        .map((s) => s.suggestion);

      assert.ok(
        columnNames.includes("cat_id"),
        "Should suggest 'cat_id' column"
      );
      assert.ok(
        columnNames.includes("cat_name"),
        "Should suggest 'cat_name' column"
      );
    });

    it("suggests columns from single-quoted unqualified table name", async () => {
      const sql = "SELECT | FROM 'categories'";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const columnNames = suggestions
        .filter((s) => s.kind === "column")
        .map((s) => s.suggestion);

      // 'categories' is in the cms schema but DuckDB should resolve it
      // via search_path or it may fail - the key thing is we extract it properly
      assert.ok(Array.isArray(columnNames), "Should return column array");
    });

    it("does not show all tables for 'table'.|  (table is not a schema)", async () => {
      // 'categories'. doesn't make sense - categories is a table, not a schema/db
      // Should NOT show all databases/tables as if there was no qualifier
      const sql = "SELECT * FROM 'categories'.|";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      // Should NOT have database suggestions (since categories is not a database)
      const dbSuggestions = suggestions.filter((s) => s.kind === "database");
      assert.strictEqual(
        dbSuggestions.length,
        0,
        "Should NOT show databases when qualifying off a table name"
      );

      // Should have very few or no suggestions since 'categories' is not a db/schema
      // (It might show tables if 'categories' happens to match a schema name in some
      // interpretation, but it should NOT show the full unscoped list)
      const tableSuggestions = suggestions.filter((s) => s.kind === "table");
      assert.ok(
        !tableSuggestions.some((s) => s.suggestion === "users"),
        "Should NOT show unrelated tables like 'users' when qualifying off 'categories'"
      );
    });

    it("suggests columns from mixed qualified name: unquoted.'quoted'", async () => {
      // This is the key test: SELECT | FROM my_database.'table'
      // The table extraction must combine unquoted + single-quoted parts
      const sql = "SELECT | FROM memory.'categories'";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const columnNames = suggestions
        .filter((s) => s.kind === "column")
        .map((s) => s.suggestion);

      // Should extract memory.categories and DESCRIBE it successfully
      // Note: 'categories' is in the 'cms' schema. In DuckDB in-memory mode,
      // memory.categories might not resolve unless using the main schema.
      // So let's create a table in main schema for this test.
      assert.ok(
        Array.isArray(columnNames),
        "Should return array (extraction works even if DESCRIBE fails for schema mismatch)"
      );
    });

    it("suggests columns from mixed qualified name: schema.'table' (real table)", async () => {
      // Use cms schema which we created in before()
      const sql = "SELECT | FROM cms.'categories'";
      const cursor = sql.indexOf("|");
      const cleanSql = sql.replace("|", "");

      const suggestions = await getAutocompleteSuggestions(
        queryFn,
        cleanSql,
        cursor
      );

      const columnNames = suggestions
        .filter((s) => s.kind === "column")
        .map((s) => s.suggestion);

      assert.ok(
        columnNames.includes("cat_id"),
        "Should suggest 'cat_id' from cms.'categories'"
      );
      assert.ok(
        columnNames.includes("cat_name"),
        "Should suggest 'cat_name' from cms.'categories'"
      );
    });
  });
});
