/**
 * Shared database management functions
 * Used by both status bar commands and Database Explorer
 */

import * as vscode from "vscode";
import {
  discoverSchemas,
  discoverTables,
  type CatalogService,
} from "./catalogService";

export interface DatabaseInfo {
  name: string;
  type: string; // 'duckdb', 'motherduck', etc.
  path: string | null;
  isInternal: boolean;
  isReadOnly: boolean;
}

export interface SchemaInfo {
  database: string;
  name: string;
}

export interface TableInfo {
  database: string;
  schema: string;
  name: string;
  type: "table" | "view";
  rowCount?: number;
}

export interface ExtensionInfo {
  name: string;
  loaded: boolean;
  installed: boolean;
  description?: string;
}

type QueryFn = (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;
type RunFn = (sql: string) => Promise<void>;

/**
 * Get all attached databases
 */
export async function getAttachedDatabases(
  queryFn: QueryFn
): Promise<DatabaseInfo[]> {
  const result = await queryFn(`
    SELECT 
      database_name,
      type,
      path,
      internal,
      readonly
    FROM duckdb_databases()
    ORDER BY database_name
  `);

  return result.rows.map((row) => ({
    name: row.database_name as string,
    type: row.type as string,
    path: row.path as string | null,
    isInternal: row.internal as boolean,
    isReadOnly: row.readonly as boolean,
  }));
}

/**
 * Get the list of user-configured ignored schemas
 */
export function getIgnoredSchemas(): string[] {
  const config = getWorkspaceConfig();
  return config.get<string[]>("explorer.ignoredSchemas", []);
}

/**
 * Add a schema to the ignored list in workspace settings
 */
export async function addIgnoredSchema(schemaName: string): Promise<void> {
  const config = getWorkspaceConfig();
  const ignored = config.get<string[]>("explorer.ignoredSchemas", []);
  if (!ignored.includes(schemaName)) {
    ignored.push(schemaName);
    await config.update(
      "explorer.ignoredSchemas",
      ignored,
      vscode.ConfigurationTarget.Workspace
    );
  }
}

/**
 * Get all schemas in a database
 */
export async function getSchemas(
  queryFn: QueryFn,
  database: string,
  catalog?: CatalogService
): Promise<SchemaInfo[]> {
  const ignored = new Set(getIgnoredSchemas());
  const schemas = catalog
    ? await catalog.getSchemas(database)
    : await discoverSchemas(async (sql) => (await queryFn(sql)).rows, database);
  return schemas.filter((schema) => !ignored.has(schema.name));
}

/** Get tables and views without counting rows or evaluating views. */
export async function getTables(
  queryFn: QueryFn,
  database: string,
  schema: string,
  catalog?: CatalogService
): Promise<TableInfo[]> {
  const tables = catalog
    ? await catalog.getTables(database, schema)
    : (await discoverTables(async (sql) => (await queryFn(sql)).rows, database))
        .filter((table) => table.schema === schema);
  return tables;
}

/**
 * Get loaded extensions
 */
export async function getLoadedExtensions(
  queryFn: QueryFn
): Promise<ExtensionInfo[]> {
  const result = await queryFn(`
    SELECT 
      extension_name,
      loaded,
      installed
    FROM duckdb_extensions()
    WHERE installed = true OR loaded = true
    ORDER BY extension_name
  `);

  return result.rows.map((row) => ({
    name: row.extension_name as string,
    loaded: row.loaded as boolean,
    installed: row.installed as boolean,
  }));
}

/**
 * Get the current database (from USE statement)
 */
export async function getCurrentDatabase(queryFn: QueryFn): Promise<string> {
  const result = await queryFn(`SELECT current_database() as db`);
  return (result.rows[0]?.db as string) || "memory";
}

/**
 * Switch to a different database
 */
export async function switchDatabase(
  runFn: RunFn,
  database: string
): Promise<void> {
  await runFn(`USE "${database}"`);
}

/**
 * Attach a database file
 */
export async function attachDatabase(
  runFn: RunFn,
  path: string,
  alias: string,
  readOnly: boolean = false
): Promise<void> {
  const mode = readOnly ? " (READ_ONLY)" : "";
  await runFn(`ATTACH '${path.replace(/'/g, "''")}' AS "${alias}"${mode}`);
}

/**
 * Detach a database
 */
export async function detachDatabase(
  runFn: RunFn,
  database: string
): Promise<void> {
  await runFn(`DETACH "${database}"`);
}

/**
 * Attach a memory database with an alias
 */
export async function attachMemoryDatabase(
  runFn: RunFn,
  alias: string
): Promise<void> {
  await runFn(`ATTACH ':memory:' AS "${alias}"`);
}

/**
 * Attach a database and switch to it
 */
export async function attachDatabaseAndUse(
  runFn: RunFn,
  filePath: string,
  alias: string,
  readOnly: boolean = false
): Promise<void> {
  await attachDatabase(runFn, filePath, alias, readOnly);
  await switchDatabase(runFn, alias);
}

/**
 * Create a new schema in a database
 */
export async function createSchema(
  runFn: RunFn,
  database: string,
  schemaName: string
): Promise<void> {
  await runFn(`CREATE SCHEMA "${database}"."${schemaName}"`);
}

/**
 * Drop a table or view
 */
export async function dropObject(
  runFn: RunFn,
  objectType: "TABLE" | "VIEW",
  database: string,
  schema: string,
  name: string
): Promise<void> {
  const qualifiedName = `"${database}"."${schema}"."${name}"`;
  await runFn(`DROP ${objectType} ${qualifiedName}`);
}

/**
 * Run arbitrary SQL (for manual database attach commands)
 */
export async function runManualSql(runFn: RunFn, sql: string): Promise<void> {
  await runFn(sql);
}

// ============================================================================
// SQL BUILDERS
// ============================================================================

/**
 * Build SQL to describe a table or view (schema metadata)
 * Wrapped in SELECT to work with caching mechanisms
 */
export function buildDescribeSql(
  database: string,
  schema: string,
  tableName: string
): string {
  const qualifiedName = `"${database}"."${schema}"."${tableName}"`;
  return `SELECT * FROM (DESCRIBE ${qualifiedName})`;
}

/**
 * Build SQL to create a new schema
 */
export function buildCreateSchemaSql(
  database: string,
  schemaName: string
): string {
  return `CREATE SCHEMA "${database}"."${schemaName}"`;
}

/**
 * Build SQL to drop a table or view
 */
export function buildDropSql(
  objectType: "TABLE" | "VIEW",
  database: string,
  schema: string,
  name: string
): string {
  const qualifiedName = `"${database}"."${schema}"."${name}"`;
  return `DROP ${objectType} ${qualifiedName}`;
}

/**
 * Build SQL to select top N rows from a table
 */
export function buildSelectTopSql(
  database: string,
  schema: string,
  tableName: string,
  limit: number = 100
): string {
  const qualifiedName = `"${database}"."${schema}"."${tableName}"`;
  return `SELECT * FROM ${qualifiedName} LIMIT ${limit}`;
}

/**
 * Build boilerplate SQL for creating a new table
 */
export function buildNewTableBoilerplate(
  database: string,
  schema: string
): string {
  return `USE "${database}";

CREATE TABLE "${schema}"."new_table" (
    id INTEGER PRIMARY KEY,
    name VARCHAR,
    created_at TIMESTAMP DEFAULT current_timestamp
);
`;
}

/**
 * Build boilerplate SQL for creating a new view
 */
export function buildNewViewBoilerplate(
  database: string,
  schema: string
): string {
  return `USE "${database}";

CREATE VIEW "${schema}"."new_view" AS
SELECT
    *
FROM "${schema}"."source_table"
WHERE 1=1;
`;
}

/**
 * Workspace settings helpers
 */
export function getWorkspaceConfig() {
  return vscode.workspace.getConfiguration("duckdb");
}

export async function updateWorkspaceConfig(
  key: string,
  value: unknown
): Promise<void> {
  const config = getWorkspaceConfig();
  await config.update(key, value, vscode.ConfigurationTarget.Workspace);
}

export interface DatabaseConfig {
  alias: string;
  type: "memory" | "file" | "manual";
  path?: string;
  readOnly?: boolean;
  sql?: string;
  attached?: boolean; // Attach on startup based on last state (default true)
}

/**
 * Get all configured databases from workspace settings
 */
export function getConfiguredDatabases(): DatabaseConfig[] {
  const config = getWorkspaceConfig();
  return config.get<DatabaseConfig[]>("databases", []);
}

/**
 * Add or update a database in settings
 */
export async function addDatabaseToSettings(
  dbConfig: DatabaseConfig
): Promise<void> {
  const config = getWorkspaceConfig();
  const databases = config.get<DatabaseConfig[]>("databases", []);

  // Set defaults for new databases
  if (dbConfig.attached === undefined) {
    dbConfig.attached = true;
  }

  // Check if already exists
  const existingIndex = databases.findIndex((d) => d.alias === dbConfig.alias);
  if (existingIndex >= 0) {
    databases[existingIndex] = dbConfig;
  } else {
    databases.push(dbConfig);
  }

  await config.update(
    "databases",
    databases,
    vscode.ConfigurationTarget.Workspace
  );
}

/**
 * Update the attached state of a database in settings
 */
export async function updateDatabaseAttachedState(
  alias: string,
  attached: boolean
): Promise<void> {
  const config = getWorkspaceConfig();
  const databases = config.get<DatabaseConfig[]>("databases", []);

  const db = databases.find((d) => d.alias === alias);
  if (db) {
    db.attached = attached;
    await config.update(
      "databases",
      databases,
      vscode.ConfigurationTarget.Workspace
    );
  }
}

/**
 * Update the readOnly state of a database in settings
 */
export async function updateDatabaseReadOnlyState(
  alias: string,
  readOnly: boolean
): Promise<void> {
  const config = getWorkspaceConfig();
  const databases = config.get<DatabaseConfig[]>("databases", []);

  const db = databases.find((d) => d.alias === alias);
  if (db) {
    db.readOnly = readOnly;
    await config.update(
      "databases",
      databases,
      vscode.ConfigurationTarget.Workspace
    );
  }
}

/**
 * Remove a database from settings (forget it completely)
 */
export async function removeDatabaseFromSettings(alias: string): Promise<void> {
  const config = getWorkspaceConfig();
  const databases = config.get<DatabaseConfig[]>("databases", []);
  const filtered = databases.filter((d) => d.alias !== alias);
  await config.update(
    "databases",
    filtered,
    vscode.ConfigurationTarget.Workspace
  );
}

/**
 * Combined database state: merges DuckDB runtime state with settings state
 */
export interface CombinedDatabaseInfo {
  alias: string;
  type: string;
  path: string | null;
  isAttached: boolean; // Currently attached to DuckDB
  isReadOnly: boolean;
  isConfigured: boolean; // In workspace settings
  config?: DatabaseConfig; // Original config if from settings
  engineType?: string; // DuckDB engine type: 'duckdb', 'postgres', 'sqlite', 'motherduck', etc.
}

/**
 * Get combined database state from both DuckDB and settings
 */
export async function getCombinedDatabases(
  queryFn: QueryFn
): Promise<CombinedDatabaseInfo[]> {
  // Get currently attached databases from DuckDB
  const attachedDbs = await getAttachedDatabases(queryFn);

  // Get configured databases from settings
  const configuredDbs = getConfiguredDatabases();

  const result: CombinedDatabaseInfo[] = [];
  const seenAliases = new Set<string>();

  // Add all attached databases
  for (const db of attachedDbs) {
    if (db.isInternal) continue;

    const config = configuredDbs.find((c) => c.alias === db.name);
    seenAliases.add(db.name);

    result.push({
      alias: db.name,
      type: config?.type || "file",
      path: db.path,
      isAttached: true,
      isReadOnly: db.isReadOnly,
      isConfigured: !!config,
      config,
      engineType: db.type, // DuckDB-native engine type (e.g. 'duckdb', 'postgres', 'sqlite')
    });
  }

  // Add configured but not attached databases
  for (const config of configuredDbs) {
    if (seenAliases.has(config.alias)) continue;

    result.push({
      alias: config.alias,
      type: config.type,
      path: config.path || null,
      isAttached: false,
      isReadOnly: config.readOnly ?? false,
      isConfigured: true,
      config,
    });
  }

  return result;
}

export async function setDefaultDatabase(database: string): Promise<void> {
  await updateWorkspaceConfig("defaultDatabase", database);
}

export async function addExtensionToAutoLoad(extension: string): Promise<void> {
  const config = getWorkspaceConfig();
  const extensions = config.get<string[]>("extensions.autoLoad", []);
  if (!extensions.includes(extension)) {
    extensions.push(extension);
    await config.update(
      "extensions.autoLoad",
      extensions,
      vscode.ConfigurationTarget.Workspace
    );
  }
}

export async function removeExtensionFromAutoLoad(
  extension: string
): Promise<void> {
  const config = getWorkspaceConfig();
  const extensions = config.get<string[]>("extensions.autoLoad", []);
  const filtered = extensions.filter((e) => e !== extension);
  await config.update(
    "extensions.autoLoad",
    filtered,
    vscode.ConfigurationTarget.Workspace
  );
}

export function getAutoLoadExtensions(): string[] {
  const config = getWorkspaceConfig();
  return config.get<string[]>("extensions.autoLoad", []);
}

/**
 * Migrate legacy `duckdb.extensions` (array) setting to `duckdb.extensions.autoLoad`.
 * This handles users who configured the old setting name.
 */
export async function migrateExtensionsSetting(): Promise<void> {
  const config = getWorkspaceConfig();
  // Check workspace-level for old setting
  const inspection = config.inspect<string[]>("extensions");
  const oldValue =
    inspection?.workspaceValue ?? inspection?.workspaceFolderValue;
  if (oldValue && Array.isArray(oldValue) && oldValue.length > 0) {
    const current = config.get<string[]>("extensions.autoLoad", []);
    // Merge old values into new setting (dedup)
    const merged = [...new Set([...current, ...oldValue])];
    await config.update(
      "extensions.autoLoad",
      merged,
      vscode.ConfigurationTarget.Workspace
    );
    // Clear the old setting
    await config.update(
      "extensions",
      undefined,
      vscode.ConfigurationTarget.Workspace
    );
    console.log(
      `🦆 Migrated ${oldValue.length} extension(s) from duckdb.extensions to duckdb.extensions.autoLoad`
    );
  }
}
