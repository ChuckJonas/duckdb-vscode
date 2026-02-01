/**
 * Unit tests for SQL Context Analyzer (for autocomplete)
 *
 * Run with: npx tsx --test src/test/sqlContextAnalyzer.test.ts
 *
 * These tests define the expected behavior for analyzing SQL context
 * at a given cursor position to provide intelligent autocomplete suggestions.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  analyzeSQLContext,
  parseCursorPosition,
  type SQLContext,
  type TableReference,
  type CTEReference,
  type ClauseType,
} from "../services/sqlContextAnalyzer";

// ============================================================================
// TEST CASES
// ============================================================================

describe("SQL Context Analyzer", () => {
  describe("Clause Detection", () => {
    it("detects SELECT clause (empty)", () => {
      const { sql, cursor } = parseCursorPosition("SELECT |");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.clause, "select");
    });

    it("detects SELECT clause (partial column)", () => {
      const { sql, cursor } = parseCursorPosition("SELECT na|");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.clause, "select");
      assert.strictEqual(ctx.prefix, "na");
    });

    it("detects SELECT clause (after comma)", () => {
      const { sql, cursor } = parseCursorPosition("SELECT id, |");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.clause, "select");
      assert.strictEqual(ctx.prefix, "");
    });

    it("detects SELECT clause (middle of columns)", () => {
      const { sql, cursor } = parseCursorPosition(
        "SELECT id, |, created_at FROM users",
      );
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.clause, "select");
    });

    it("detects FROM clause (empty)", () => {
      const { sql, cursor } = parseCursorPosition("SELECT * FROM |");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.clause, "from");
    });

    it("detects FROM clause (partial)", () => {
      const { sql, cursor } = parseCursorPosition("SELECT * FROM us|");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.clause, "from");
      assert.strictEqual(ctx.prefix, "us");
    });

    it("detects JOIN clause", () => {
      const { sql, cursor } = parseCursorPosition("SELECT * FROM users JOIN |");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.clause, "join");
    });

    it("detects LEFT JOIN clause", () => {
      const { sql, cursor } = parseCursorPosition(
        "SELECT * FROM users LEFT JOIN |",
      );
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.clause, "join");
    });

    it("detects ON clause", () => {
      const { sql, cursor } = parseCursorPosition(
        "SELECT * FROM users u JOIN orders o ON |",
      );
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.clause, "on");
    });

    it("detects ON clause (partial)", () => {
      const { sql, cursor } = parseCursorPosition(
        "SELECT * FROM users u JOIN orders o ON u.id = o.user|",
      );
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.clause, "on");
      assert.strictEqual(ctx.prefix, "user");
    });

    it("detects WHERE clause", () => {
      const { sql, cursor } = parseCursorPosition(
        "SELECT * FROM users WHERE |",
      );
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.clause, "where");
    });

    it("detects WHERE clause (after AND)", () => {
      const { sql, cursor } = parseCursorPosition(
        "SELECT * FROM users WHERE id = 1 AND |",
      );
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.clause, "where");
    });

    it("detects GROUP BY clause", () => {
      const { sql, cursor } = parseCursorPosition(
        "SELECT * FROM users GROUP BY |",
      );
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.clause, "group_by");
    });

    it("detects HAVING clause", () => {
      const { sql, cursor } = parseCursorPosition(
        "SELECT * FROM users GROUP BY id HAVING |",
      );
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.clause, "having");
    });

    it("detects ORDER BY clause", () => {
      const { sql, cursor } = parseCursorPosition(
        "SELECT * FROM users ORDER BY |",
      );
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.clause, "order_by");
    });

    it("detects ORDER BY clause (after comma)", () => {
      const { sql, cursor } = parseCursorPosition(
        "SELECT * FROM users ORDER BY id, |",
      );
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.clause, "order_by");
    });
  });

  describe("Table Extraction - Simple Tables", () => {
    it("extracts single table from FROM", () => {
      const { sql, cursor } = parseCursorPosition("SELECT | FROM users");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.tables.length, 1);
      assert.strictEqual(ctx.tables[0].name, "users");
      assert.strictEqual(ctx.tables[0].type, "table");
    });

    it("extracts table with alias", () => {
      const { sql, cursor } = parseCursorPosition("SELECT | FROM users u");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.tables.length, 1);
      assert.strictEqual(ctx.tables[0].name, "users");
      assert.strictEqual(ctx.tables[0].alias, "u");
    });

    it("extracts table with AS alias", () => {
      const { sql, cursor } = parseCursorPosition("SELECT | FROM users AS u");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.tables.length, 1);
      assert.strictEqual(ctx.tables[0].name, "users");
      assert.strictEqual(ctx.tables[0].alias, "u");
    });

    it("extracts multiple tables from JOIN", () => {
      const { sql, cursor } = parseCursorPosition(
        "SELECT | FROM users u JOIN orders o ON u.id = o.user_id",
      );
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.tables.length, 2);
      assert.strictEqual(ctx.tables[0].name, "users");
      assert.strictEqual(ctx.tables[0].alias, "u");
      assert.strictEqual(ctx.tables[1].name, "orders");
      assert.strictEqual(ctx.tables[1].alias, "o");
    });

    it("extracts tables from multiple JOINs", () => {
      const { sql, cursor } = parseCursorPosition(`
        SELECT | 
        FROM users u 
        JOIN orders o ON u.id = o.user_id
        LEFT JOIN products p ON o.product_id = p.id
      `);
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.tables.length, 3);
      assert.strictEqual(ctx.tables[0].name, "users");
      assert.strictEqual(ctx.tables[1].name, "orders");
      assert.strictEqual(ctx.tables[2].name, "products");
    });

    it("extracts schema-qualified table", () => {
      const { sql, cursor } = parseCursorPosition("SELECT | FROM main.users");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.tables.length, 1);
      assert.strictEqual(ctx.tables[0].name, "main.users");
    });

    it("extracts fully-qualified table (database.schema.table)", () => {
      const { sql, cursor } = parseCursorPosition(
        "SELECT | FROM mydb.main.users",
      );
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.tables.length, 1);
      assert.strictEqual(ctx.tables[0].name, "mydb.main.users");
    });
  });

  describe("Table Extraction - File Paths (CSV, Parquet)", () => {
    it("extracts single-quoted file path", () => {
      const { sql, cursor } = parseCursorPosition(
        "SELECT | FROM 'data/users.csv'",
      );
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.tables.length, 1);
      assert.strictEqual(ctx.tables[0].name, "data/users.csv");
      assert.strictEqual(ctx.tables[0].type, "file");
    });

    it("extracts double-quoted file path", () => {
      const { sql, cursor } = parseCursorPosition(
        'SELECT | FROM "data/users.csv"',
      );
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.tables.length, 1);
      assert.strictEqual(ctx.tables[0].name, "data/users.csv");
      assert.strictEqual(ctx.tables[0].type, "file");
    });

    it("extracts file path with alias", () => {
      const { sql, cursor } = parseCursorPosition(
        "SELECT | FROM 'data/users.csv' u",
      );
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.tables[0].name, "data/users.csv");
      assert.strictEqual(ctx.tables[0].alias, "u");
      assert.strictEqual(ctx.tables[0].type, "file");
    });

    it("extracts S3 path", () => {
      const { sql, cursor } = parseCursorPosition(
        "SELECT | FROM 's3://bucket/data/users.parquet'",
      );
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.tables[0].name, "s3://bucket/data/users.parquet");
      assert.strictEqual(ctx.tables[0].type, "file");
    });

    it("extracts read_csv function", () => {
      const { sql, cursor } = parseCursorPosition(
        "SELECT | FROM read_csv('data/users.csv')",
      );
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.tables.length, 1);
      assert.strictEqual(ctx.tables[0].name, "read_csv('data/users.csv')");
      assert.strictEqual(ctx.tables[0].type, "function");
    });

    it("extracts read_csv with alias", () => {
      const { sql, cursor } = parseCursorPosition(
        "SELECT | FROM read_csv('data/users.csv') AS u",
      );
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.tables[0].name, "read_csv('data/users.csv')");
      assert.strictEqual(ctx.tables[0].alias, "u");
    });

    it("extracts read_parquet function", () => {
      const { sql, cursor } = parseCursorPosition(
        "SELECT | FROM read_parquet('s3://bucket/*.parquet')",
      );
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(
        ctx.tables[0].name,
        "read_parquet('s3://bucket/*.parquet')",
      );
      assert.strictEqual(ctx.tables[0].type, "function");
    });

    it("extracts read_csv with options", () => {
      const { sql, cursor } = parseCursorPosition(
        "SELECT | FROM read_csv('data.csv', header=true, delim=',')",
      );
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.tables[0].type, "function");
      // The name includes the full function call
      assert.ok(ctx.tables[0].name.startsWith("read_csv("));
    });

    it("handles mixed tables and files", () => {
      const { sql, cursor } = parseCursorPosition(`
        SELECT | 
        FROM 'data/users.csv' u 
        JOIN orders o ON u.id = o.user_id
      `);
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.tables.length, 2);
      assert.strictEqual(ctx.tables[0].type, "file");
      assert.strictEqual(ctx.tables[1].type, "table");
    });
  });

  describe("CTE (WITH clause) Extraction", () => {
    it("extracts single CTE", () => {
      const { sql, cursor } = parseCursorPosition(`
        WITH active_users AS (SELECT * FROM users WHERE active = true)
        SELECT | FROM active_users
      `);
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.ctes.length, 1);
      assert.strictEqual(ctx.ctes[0].name, "active_users");
      // The CTE should also appear in tables since we're selecting from it
      assert.ok(ctx.tables.some((t) => t.name === "active_users"));
    });

    it("extracts multiple CTEs", () => {
      const { sql, cursor } = parseCursorPosition(`
        WITH 
          active_users AS (SELECT * FROM users WHERE active = true),
          recent_orders AS (SELECT * FROM orders WHERE order_date > '2024-01-01')
        SELECT | FROM active_users u JOIN recent_orders o ON u.id = o.user_id
      `);
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.ctes.length, 2);
      assert.strictEqual(ctx.ctes[0].name, "active_users");
      assert.strictEqual(ctx.ctes[1].name, "recent_orders");
    });

    it("extracts recursive CTE", () => {
      const { sql, cursor } = parseCursorPosition(`
        WITH RECURSIVE nums AS (
          SELECT 1 AS n
          UNION ALL
          SELECT n + 1 FROM nums WHERE n < 10
        )
        SELECT | FROM nums
      `);
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.ctes.length, 1);
      assert.strictEqual(ctx.ctes[0].name, "nums");
    });
  });

  describe("Nested Queries (Subqueries)", () => {
    it("scopes to inner query in FROM subquery", () => {
      const { sql, cursor } = parseCursorPosition(`
        SELECT * FROM (
          SELECT | FROM users
        ) sub
      `);
      const ctx = analyzeSQLContext(sql, cursor);
      // Should only see 'users' table, not 'sub'
      assert.strictEqual(ctx.tables.length, 1);
      assert.strictEqual(ctx.tables[0].name, "users");
    });

    it("scopes to inner query in WHERE subquery", () => {
      const { sql, cursor } = parseCursorPosition(`
        SELECT * FROM orders WHERE user_id IN (
          SELECT | FROM users WHERE active = true
        )
      `);
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.tables.length, 1);
      assert.strictEqual(ctx.tables[0].name, "users");
    });

    it("handles deeply nested subqueries", () => {
      const { sql, cursor } = parseCursorPosition(`
        SELECT * FROM a WHERE id IN (
          SELECT id FROM b WHERE val IN (
            SELECT | FROM c
          )
        )
      `);
      const ctx = analyzeSQLContext(sql, cursor);
      // Should only see table 'c' at this nesting level
      assert.strictEqual(ctx.tables.length, 1);
      assert.strictEqual(ctx.tables[0].name, "c");
    });

    it("sees outer scope in correlated subquery (column reference)", () => {
      // This is tricky - when in WHERE of inner query, we might want outer tables
      // For simplicity, we'll focus on the innermost FROM clause
      const { sql, cursor } = parseCursorPosition(`
        SELECT * FROM orders o WHERE EXISTS (
          SELECT 1 FROM users u WHERE u.id = o.| AND u.active = true
        )
      `);
      const ctx = analyzeSQLContext(sql, cursor);
      // When referencing "o." we should recognize it's from outer scope
      assert.strictEqual(ctx.isAfterDot, true);
      assert.strictEqual(ctx.dotPrefix, "o");
    });
  });

  describe("Dot-qualified Column References", () => {
    it("detects alias.column pattern", () => {
      const { sql, cursor } = parseCursorPosition("SELECT u.| FROM users u");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.isAfterDot, true);
      assert.strictEqual(ctx.dotPrefix, "u");
      assert.strictEqual(ctx.prefix, "");
    });

    it("detects alias.partial_column pattern", () => {
      const { sql, cursor } = parseCursorPosition("SELECT u.na| FROM users u");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.isAfterDot, true);
      assert.strictEqual(ctx.dotPrefix, "u");
      assert.strictEqual(ctx.prefix, "na");
    });

    it("detects table.column pattern (no alias)", () => {
      const { sql, cursor } = parseCursorPosition("SELECT users.| FROM users");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.isAfterDot, true);
      assert.strictEqual(ctx.dotPrefix, "users");
    });

    it("handles dot in WHERE clause", () => {
      const { sql, cursor } = parseCursorPosition(
        "SELECT * FROM users u WHERE u.|",
      );
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.clause, "where");
      assert.strictEqual(ctx.isAfterDot, true);
      assert.strictEqual(ctx.dotPrefix, "u");
    });

    it("handles dot in JOIN ON clause", () => {
      const { sql, cursor } = parseCursorPosition(
        "SELECT * FROM users u JOIN orders o ON u.id = o.|",
      );
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.clause, "on");
      assert.strictEqual(ctx.isAfterDot, true);
      assert.strictEqual(ctx.dotPrefix, "o");
    });
  });

  describe("Prefix Extraction", () => {
    it("extracts empty prefix at word boundary", () => {
      const { sql, cursor } = parseCursorPosition("SELECT |");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.prefix, "");
    });

    it("extracts partial word prefix", () => {
      const { sql, cursor } = parseCursorPosition("SELECT na|");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.prefix, "na");
    });

    it("extracts prefix after comma", () => {
      const { sql, cursor } = parseCursorPosition("SELECT id, na|");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.prefix, "na");
    });

    it("extracts prefix in FROM clause", () => {
      const { sql, cursor } = parseCursorPosition("SELECT * FROM us|");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.prefix, "us");
    });

    it("handles prefix with underscore", () => {
      const { sql, cursor } = parseCursorPosition("SELECT user_|");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.prefix, "user_");
    });
  });

  describe("Edge Cases", () => {
    it("handles empty SQL", () => {
      const ctx = analyzeSQLContext("", 0);
      assert.strictEqual(ctx.clause, "unknown");
      assert.strictEqual(ctx.tables.length, 0);
    });

    it("handles SELECT only", () => {
      const { sql, cursor } = parseCursorPosition("SELECT|");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.clause, "select");
    });

    it("handles multiline SQL", () => {
      const { sql, cursor } = parseCursorPosition(`
        SELECT
          id,
          |
        FROM users
      `);
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.clause, "select");
      assert.strictEqual(ctx.tables[0].name, "users");
    });

    it("handles comments before cursor", () => {
      const { sql, cursor } = parseCursorPosition(`
        -- This is a comment
        SELECT | FROM users
      `);
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.clause, "select");
    });

    it("handles quoted identifiers", () => {
      const { sql, cursor } = parseCursorPosition('SELECT | FROM "My Table"');
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.tables[0].name, "My Table");
    });

    it("handles UNION query (cursor in first query)", () => {
      const { sql, cursor } = parseCursorPosition(`
        SELECT | FROM users
        UNION
        SELECT * FROM admins
      `);
      const ctx = analyzeSQLContext(sql, cursor);
      // Should only see 'users' table
      assert.strictEqual(ctx.tables.length, 1);
      assert.strictEqual(ctx.tables[0].name, "users");
    });

    it("handles UNION query (cursor in second query)", () => {
      const { sql, cursor } = parseCursorPosition(`
        SELECT * FROM users
        UNION
        SELECT | FROM admins
      `);
      const ctx = analyzeSQLContext(sql, cursor);
      // Should only see 'admins' table
      assert.strictEqual(ctx.tables.length, 1);
      assert.strictEqual(ctx.tables[0].name, "admins");
    });

    it("ignores incomplete FROM clause for SELECT completions", () => {
      // User is typing and hasn't finished the FROM yet
      const { sql, cursor } = parseCursorPosition("SELECT | FROM ");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.clause, "select");
      // No tables yet since FROM is incomplete
      assert.strictEqual(ctx.tables.length, 0);
    });

    it("handles INSERT INTO", () => {
      const { sql, cursor } = parseCursorPosition("INSERT INTO | ");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.clause, "insert_into");
    });

    it("handles UPDATE", () => {
      const { sql, cursor } = parseCursorPosition("UPDATE | SET");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.clause, "update");
    });

    it("handles SET clause in UPDATE", () => {
      const { sql, cursor } = parseCursorPosition(
        "UPDATE users SET | WHERE id = 1",
      );
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.clause, "set");
      assert.strictEqual(ctx.tables[0].name, "users");
    });
  });

  describe("Multiple Statements", () => {
    it("scopes to current statement only", () => {
      const { sql, cursor } = parseCursorPosition(`
        SELECT * FROM other_table;
        SELECT | FROM users;
      `);
      const ctx = analyzeSQLContext(sql, cursor);
      // Should only see 'users', not 'other_table'
      assert.strictEqual(ctx.tables.length, 1);
      assert.strictEqual(ctx.tables[0].name, "users");
    });

    it("handles cursor in first of multiple statements", () => {
      const { sql, cursor } = parseCursorPosition(`
        SELECT | FROM users;
        SELECT * FROM orders;
      `);
      const ctx = analyzeSQLContext(sql, cursor);
      assert.strictEqual(ctx.tables.length, 1);
      assert.strictEqual(ctx.tables[0].name, "users");
    });
  });

  describe("Subquery Extraction", () => {
    it("extracts subquery from FROM clause", () => {
      const { sql, cursor } = parseCursorPosition(`
        SELECT | FROM (SELECT id, name FROM users) sub
      `);
      const ctx = analyzeSQLContext(sql, cursor);

      // Should have one table reference of type "subquery"
      assert.strictEqual(ctx.tables.length, 1);
      assert.strictEqual(ctx.tables[0].type, "subquery");
      assert.strictEqual(ctx.tables[0].alias, "sub");
      assert.ok(ctx.tables[0].subquery?.includes("SELECT id, name FROM users"));
    });

    it("extracts subquery with complex content", () => {
      const { sql, cursor } = parseCursorPosition(`
        SELECT | FROM (
          SELECT u.id, u.name, COUNT(*) as order_count 
          FROM users u 
          JOIN orders o ON u.id = o.user_id 
          GROUP BY u.id, u.name
        ) summary
      `);
      const ctx = analyzeSQLContext(sql, cursor);

      assert.strictEqual(ctx.tables[0].type, "subquery");
      assert.strictEqual(ctx.tables[0].alias, "summary");
    });

    it("extracts subquery without alias", () => {
      const { sql, cursor } = parseCursorPosition(`
        SELECT | FROM (SELECT 1 as x)
      `);
      const ctx = analyzeSQLContext(sql, cursor);

      assert.strictEqual(ctx.tables[0].type, "subquery");
      // Should have a generated name
      assert.ok(ctx.tables[0].name.includes("subquery"));
    });
  });

  describe("Quote Context Detection", () => {
    it("detects cursor inside single-quoted string", () => {
      const { sql, cursor } = parseCursorPosition("SELECT * FROM '|'");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.ok(ctx.quoteContext?.inQuote, "Should detect inside quote");
      assert.strictEqual(ctx.quoteContext?.quoteChar, "'");
      assert.strictEqual(ctx.quoteContext?.pathPrefix, "");
    });

    it("detects cursor inside double-quoted string", () => {
      const { sql, cursor } = parseCursorPosition('SELECT * FROM "|"');
      const ctx = analyzeSQLContext(sql, cursor);
      assert.ok(ctx.quoteContext?.inQuote, "Should detect inside quote");
      assert.strictEqual(ctx.quoteContext?.quoteChar, '"');
    });

    it("extracts path prefix inside quote", () => {
      const { sql, cursor } = parseCursorPosition("SELECT * FROM './data/|'");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.ok(ctx.quoteContext?.inQuote);
      assert.strictEqual(ctx.quoteContext?.pathPrefix, "./data/");
    });

    it("extracts partial filename in quote", () => {
      const { sql, cursor } = parseCursorPosition("SELECT * FROM 'users|'");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.ok(ctx.quoteContext?.inQuote);
      assert.strictEqual(ctx.quoteContext?.pathPrefix, "users");
    });

    it("not in quote when cursor is outside quotes", () => {
      const { sql, cursor } = parseCursorPosition("SELECT * FROM |");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.ok(!ctx.quoteContext?.inQuote, "Should not be in quote");
    });

    it("not in quote after closing quote", () => {
      const { sql, cursor } = parseCursorPosition("SELECT * FROM 'file.csv' |");
      const ctx = analyzeSQLContext(sql, cursor);
      assert.ok(
        !ctx.quoteContext?.inQuote,
        "Should not be in quote after close",
      );
    });
  });
});

// ============================================================================
// Integration test with test fixtures
// ============================================================================
describe("SQL Context Analyzer - Integration", () => {
  it("should export analyzeSQLContext function", () => {
    assert.strictEqual(typeof analyzeSQLContext, "function");
  });
});
