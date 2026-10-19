import * as vscode from "vscode";
import {
  getSchemas,
  getTables,
  getCurrentDatabase,
  getCombinedDatabases,
  CombinedDatabaseInfo,
} from "../services/databaseManager";
import { type CatalogService } from "../services/catalogService";

/**
 * Node types in the database explorer tree
 */
export type ExplorerNodeType =
  | "database"
  | "database-detached"
  | "schema"
  | "tables-folder"
  | "views-folder"
  | "table"
  | "view"
  | "column";

/**
 * Represents a node in the database explorer tree
 */
export interface ExplorerNode {
  type: ExplorerNodeType;
  name: string;
  database?: string;
  schema?: string;
  tableName?: string;
  dataType?: string;
  isNullable?: boolean;
  rowCount?: number;
  isCurrent?: boolean; // Is this the current database?
  isReadOnly?: boolean; // Is this database read-only?
  isAttached?: boolean; // Is this database currently attached?
  isConfigured?: boolean; // Is this database in workspace settings?
  dbPath?: string; // Path to database file
  engineType?: string; // DuckDB engine type: 'duckdb', 'postgres', 'sqlite', 'motherduck', etc.
}

/**
 * TreeDataProvider for the DuckDB Database Explorer
 */
export class DatabaseExplorer implements vscode.TreeDataProvider<ExplorerNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    ExplorerNode | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private currentDatabase: string = "memory";

  constructor(
    private queryFn: (
      sql: string
    ) => Promise<{ rows: Record<string, unknown>[] }>,
    private readonly catalog: CatalogService
  ) {
    this.refreshCurrentDatabase();
  }

  /**
   * Refresh the current database name
   */
  async refreshCurrentDatabase(): Promise<void> {
    try {
      this.currentDatabase = await getCurrentDatabase(this.queryFn);
    } catch {
      this.currentDatabase = "memory";
    }
  }

  /**
   * Refresh the entire tree
   */
  refresh(): void {
    this.refreshCurrentDatabase();
    this._onDidChangeTreeData.fire();
  }

  /**
   * Get the tree item representation of a node
   */
  getTreeItem(element: ExplorerNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      this.getLabel(element),
      this.getCollapsibleState(element)
    );

    // Set context value for menu visibility
    // For databases, include state info for proper menu items
    if (element.type === "database") {
      // Attached database - can detach, use, etc.
      item.contextValue = element.isConfigured
        ? "database-attached-configured"
        : "database-attached";
    } else if (element.type === "database-detached") {
      // Detached database - can attach or forget
      item.contextValue = "database-detached";
    } else {
      item.contextValue = element.type;
    }

    item.iconPath = this.getIcon(element);
    item.tooltip = this.getTooltip(element);
    item.description = this.getDescription(element);

    // Double-click tables/views to open the overview panel
    if (element.type === "table" || element.type === "view") {
      item.command = {
        command: "duckdb.explorer.openOverview",
        title: "Open Overview",
        arguments: [element],
      };
    }

    return item;
  }

  /**
   * Get children of a node (or root nodes if no element)
   */
  async getChildren(element?: ExplorerNode): Promise<ExplorerNode[]> {
    if (!element) {
      return this.getRootNodes();
    }

    switch (element.type) {
      case "database": {
        const schemas = await this.getSchemaNodes(element.name);
        // If there's only one schema, skip the schema level and show
        // Tables/Views folders directly under the database
        if (schemas.length === 1) {
          const schema = schemas[0];
          return [
            {
              type: "tables-folder" as const,
              name: "Tables",
              database: schema.database,
              schema: schema.name,
            },
            {
              type: "views-folder" as const,
              name: "Views",
              database: schema.database,
              schema: schema.name,
            },
          ];
        }
        return schemas;
      }

      case "database-detached":
        // Detached databases have no children (can't query them)
        return [];

      case "schema":
        return [
          {
            type: "tables-folder",
            name: "Tables",
            database: element.database,
            schema: element.name,
          },
          {
            type: "views-folder",
            name: "Views",
            database: element.database,
            schema: element.name,
          },
        ];

      case "tables-folder":
        return this.getTableNodes(element.database!, element.schema!, "table");

      case "views-folder":
        return this.getTableNodes(element.database!, element.schema!, "view");

      case "table":
      case "view":
        return this.getColumnNodes(
          element.database!,
          element.schema!,
          element.name
        );

      default:
        return [];
    }
  }

  /**
   * Get root level nodes: databases (both attached and detached)
   */
  private async getRootNodes(): Promise<ExplorerNode[]> {
    const nodes: ExplorerNode[] = [];

    try {
      // Get combined database state from DuckDB and settings
      const databases = await getCombinedDatabases(this.queryFn);
      await this.refreshCurrentDatabase();

      // Sort: attached first, then detached; within each group, sort alphabetically
      databases.sort((a, b) => {
        if (a.isAttached !== b.isAttached) {
          return a.isAttached ? -1 : 1;
        }
        return a.alias.localeCompare(b.alias);
      });

      for (const db of databases) {
        nodes.push({
          type: db.isAttached ? "database" : "database-detached",
          name: db.alias,
          isCurrent: db.isAttached && db.alias === this.currentDatabase,
          isReadOnly: db.isReadOnly,
          isAttached: db.isAttached,
          isConfigured: db.isConfigured,
          dbPath: db.path || undefined,
          engineType: db.engineType,
        });
      }
    } catch (error) {
      console.error("🦆 Failed to get root nodes:", error);
    }

    return nodes;
  }

  /**
   * Get schema nodes for a database
   */
  private async getSchemaNodes(database: string): Promise<ExplorerNode[]> {
    try {
      const schemas = await getSchemas(this.queryFn, database, this.catalog);
      return schemas.map((s) => ({
        type: "schema" as const,
        name: s.name,
        database,
      }));
    } catch (error) {
      console.error("🦆 Failed to get schemas:", error);
      return [];
    }
  }

  /**
   * Get table or view nodes
   */
  private async getTableNodes(
    database: string,
    schema: string,
    type: "table" | "view"
  ): Promise<ExplorerNode[]> {
    try {
      const tables = await getTables(this.queryFn, database, schema, this.catalog);
      return tables
        .filter((t) => t.type === type)
        .map((t) => ({
          type: t.type as "table" | "view",
          name: t.name,
          database,
          schema,
          rowCount: t.rowCount,
        }));
    } catch (error) {
      console.error("🦆 Failed to get tables:", error);
      return [];
    }
  }

  /**
   * Get column nodes for a table
   */
  private async getColumnNodes(
    database: string,
    schema: string,
    tableName: string
  ): Promise<ExplorerNode[]> {
    try {
      const columns = await this.catalog.getColumns(database, schema, tableName);
      return columns.map((column) => ({
        type: "column" as const,
        name: column.name,
        database,
        schema,
        tableName,
        dataType: column.type,
        isNullable: column.isNullable,
      }));
    } catch (error) {
      console.error("🦆 Failed to get columns:", error);
      return [];
    }
  }

  /**
   * Get the display label for a node
   */
  private getLabel(element: ExplorerNode): string {
    if (element.type === "database") {
      // Show :memory: for the in-memory database
      let label = element.name === "memory" ? ":memory:" : element.name;
      if (element.isCurrent) label += " ★";
      if (element.isReadOnly) label += " 🔒";
      return label;
    }
    if (element.type === "database-detached") {
      return element.name === "memory" ? ":memory:" : element.name;
    }
    if (element.type === "column") {
      return element.name;
    }
    return element.name;
  }

  /**
   * Get description (shown to the right of label)
   */
  private getDescription(element: ExplorerNode): string | undefined {
    if (element.type === "database") {
      if (this.catalog.isValidating(element.name)) {
        return "cached · validating";
      }
      // Show engine type for non-duckdb databases (e.g. postgres, sqlite, motherduck)
      if (element.engineType && element.engineType !== "duckdb") {
        return element.engineType;
      }
      return undefined;
    }
    if (element.type === "database-detached") {
      return "(detached)";
    }
    if (element.type === "column") {
      return element.dataType;
    }
    if (
      (element.type === "table" || element.type === "view") &&
      element.rowCount !== undefined
    ) {
      return `~${this.formatRowCount(element.rowCount)}`;
    }
    return undefined;
  }

  /**
   * Format row count with K/M suffixes
   */
  private formatRowCount(count: number): string {
    if (count >= 1_000_000) {
      return `${(count / 1_000_000).toFixed(1)}M rows`;
    }
    if (count >= 1_000) {
      return `${(count / 1_000).toFixed(1)}K rows`;
    }
    return `${count} rows`;
  }

  /**
   * Get collapsible state for a node
   */
  private getCollapsibleState(
    element: ExplorerNode
  ): vscode.TreeItemCollapsibleState {
    switch (element.type) {
      case "database":
      case "schema":
      case "tables-folder":
      case "views-folder":
      case "table":
      case "view":
        return vscode.TreeItemCollapsibleState.Collapsed;
      case "database-detached":
      case "column":
        return vscode.TreeItemCollapsibleState.None;
    }
  }

  /**
   * Get the icon color for a database based on its engine type
   */
  private getDatabaseIconColor(
    element: ExplorerNode
  ): vscode.ThemeColor | undefined {
    if (element.isCurrent) {
      return new vscode.ThemeColor("charts.green");
    }
    // Use distinct colors for non-duckdb engines so they stand out
    if (element.engineType && element.engineType !== "duckdb") {
      switch (element.engineType) {
        case "postgres":
          return new vscode.ThemeColor("charts.blue");
        case "sqlite":
          return new vscode.ThemeColor("charts.orange");
        case "motherduck":
          return new vscode.ThemeColor("charts.yellow");
        case "mysql":
          return new vscode.ThemeColor("charts.orange");
        default:
          // Any other external engine type
          return new vscode.ThemeColor("charts.purple");
      }
    }
    return undefined;
  }

  /**
   * Get icon for a node
   */
  private getIcon(element: ExplorerNode): vscode.ThemeIcon {
    switch (element.type) {
      case "database": {
        const color = this.getDatabaseIconColor(element);
        return color
          ? new vscode.ThemeIcon("database", color)
          : new vscode.ThemeIcon("database");
      }
      case "database-detached":
        // Gray/dimmed icon for detached
        return new vscode.ThemeIcon(
          "database",
          new vscode.ThemeColor("disabledForeground")
        );
      case "schema":
        return new vscode.ThemeIcon("symbol-namespace");
      case "tables-folder":
      case "views-folder":
        return new vscode.ThemeIcon("folder");
      case "table":
        return new vscode.ThemeIcon("table");
      case "view":
        return new vscode.ThemeIcon("eye");
      case "column":
        return new vscode.ThemeIcon("symbol-field");
    }
  }

  /**
   * Get tooltip for a node
   */
  private getTooltip(element: ExplorerNode): string {
    switch (element.type) {
      case "database": {
        const parts = [`Database: ${element.name}`];
        if (element.name === "memory") {
          parts.push("(in-memory)");
        }
        if (element.isCurrent) parts.push("(current)");
        if (element.isReadOnly) parts.push("(read-only)");
        if (element.engineType && element.engineType !== "duckdb") {
          parts.push(`\nEngine: ${element.engineType}`);
        }
        if (element.dbPath) parts.push(`\nPath: ${element.dbPath}`);
        return parts.join(" ");
      }
      case "database-detached": {
        const parts = [`Database: ${element.name}`, "(detached)"];
        if (element.dbPath) parts.push(`\nPath: ${element.dbPath}`);
        return parts.join(" ");
      }
      case "schema":
        return `Schema: ${element.database}.${element.name}`;
      case "table":
        return `Table: ${element.database}.${element.schema}.${element.name}`;
      case "view":
        return `View: ${element.database}.${element.schema}.${element.name}`;
      case "column":
        const nullable = element.isNullable ? "NULL" : "NOT NULL";
        return `${element.dataType} ${nullable}`;
      default:
        return element.name;
    }
  }
}

/**
 * Get the CREATE TABLE DDL for a table
 */
export async function getTableDefinition(
  queryFn: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>,
  database: string,
  schema: string,
  tableName: string
): Promise<string> {
  const result = await queryFn(`
    SELECT
      column_name,
      data_type,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_catalog = '${database}'
      AND table_schema = '${schema}'
      AND table_name = '${tableName}'
    ORDER BY ordinal_position
  `);

  const columns = result.rows.map((row) => {
    let col = `    "${row.column_name}" ${row.data_type}`;
    if (row.is_nullable === "NO") {
      col += " NOT NULL";
    }
    if (row.column_default !== null && row.column_default !== undefined) {
      col += ` DEFAULT ${row.column_default}`;
    }
    return col;
  });

  return `CREATE TABLE "${schema}"."${tableName}" (\n${columns.join(
    ",\n"
  )}\n);`;
}

/**
 * Get the CREATE VIEW SQL for a view
 */
export async function getViewDefinition(
  queryFn: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>,
  database: string,
  schema: string,
  viewName: string
): Promise<string> {
  const result = await queryFn(`
    SELECT sql
    FROM duckdb_views()
    WHERE database_name = '${database}'
      AND schema_name = '${schema}'
      AND view_name = '${viewName}'
  `);

  if (result.rows.length > 0) {
    return result.rows[0].sql as string;
  }

  return `-- Could not find definition for view: ${viewName}`;
}
