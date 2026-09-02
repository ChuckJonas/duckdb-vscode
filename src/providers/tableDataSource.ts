/**
 * Shared OverviewDataSource for a database table or view.
 *
 * Used by the table editor (duckdb-table: URIs opened from the explorer) and
 * by the file viewer when drilling into a table inside an attached database
 * file, so both render identical schema/stats/SELECT behaviour.
 */
import { getDuckDBService } from "../services/duckdb";
import type { OverviewDataSource, DataOverviewMetadata } from "./overviewHandler";

export interface TableSourceRef {
  database: string;
  schema: string;
  tableName: string;
  isView: boolean;
  /** Header label; defaults to the table name. */
  displayName?: string;
}

export function createTableSource(ref: TableSourceRef): OverviewDataSource {
  const { database, schema, tableName, isView } = ref;
  const displayName = ref.displayName ?? tableName;
  const db = getDuckDBService();
  const qualifiedName = `"${database}"."${schema}"."${tableName}"`;

  return {
    async getMetadata(): Promise<DataOverviewMetadata> {
      const metadata = await db.getTableMetadata(database, schema, tableName);
      return {
        sourceKind: "table",
        displayName,
        database,
        schema,
        tableName,
        isView,
        rowCount: metadata.rowCount,
        columns: metadata.columns,
      };
    },

    async getSummaries() {
      return db.getTableSummaries(database, schema, tableName);
    },

    async getColumnStats(column: string) {
      return db.getTableColumnStats(database, schema, tableName, column);
    },

    buildSelectSql(columns?: string[], limit?: number): string {
      const colList =
        columns && columns.length > 0
          ? columns.map((c) => `"${c}"`).join(", ")
          : "*";
      let sql = `SELECT ${colList} FROM ${qualifiedName}`;
      if (limit) {
        sql += ` LIMIT ${limit}`;
      }
      return sql;
    },
  };
}
