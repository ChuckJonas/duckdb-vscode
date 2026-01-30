/**
 * DuckDB Extensions Service
 * Manages installation, loading, and querying of DuckDB extensions
 */

type RunFn = (sql: string) => Promise<void>;
type QueryFn = (sql: string) => Promise<Record<string, unknown>[]>;

export interface ExtensionInfo {
  name: string;
  loaded: boolean;
  installed: boolean;
  installPath?: string;
  description?: string;
}

/**
 * Install a DuckDB extension (downloads if needed)
 */
export async function installExtension(runFn: RunFn, name: string): Promise<void> {
  await runFn(`INSTALL ${name}`);
}

/**
 * Load an installed extension into the current session
 */
export async function loadExtension(runFn: RunFn, name: string): Promise<void> {
  await runFn(`LOAD ${name}`);
}

/**
 * Install and load an extension in one operation
 */
export async function installAndLoadExtension(runFn: RunFn, name: string): Promise<void> {
  await installExtension(runFn, name);
  await loadExtension(runFn, name);
}

/**
 * Get all extensions (installed or loaded)
 */
export async function getExtensions(queryFn: QueryFn): Promise<ExtensionInfo[]> {
  const rows = await queryFn(`
    SELECT 
      extension_name,
      loaded,
      installed,
      install_path,
      description
    FROM duckdb_extensions()
    ORDER BY extension_name
  `);

  return rows.map(row => ({
    name: row.extension_name as string,
    loaded: row.loaded as boolean,
    installed: row.installed as boolean,
    installPath: row.install_path as string | undefined,
    description: row.description as string | undefined,
  }));
}

/**
 * Get only loaded extensions
 */
export async function getLoadedExtensions(queryFn: QueryFn): Promise<string[]> {
  const rows = await queryFn(
    `SELECT extension_name FROM duckdb_extensions() WHERE loaded = true`
  );
  return rows.map(row => row.extension_name as string);
}

/**
 * Get only installed extensions
 */
export async function getInstalledExtensions(queryFn: QueryFn): Promise<string[]> {
  const rows = await queryFn(
    `SELECT extension_name FROM duckdb_extensions() WHERE installed = true`
  );
  return rows.map(row => row.extension_name as string);
}

/**
 * Check if an extension is loaded
 */
export async function isExtensionLoaded(queryFn: QueryFn, name: string): Promise<boolean> {
  const rows = await queryFn(
    `SELECT loaded FROM duckdb_extensions() WHERE extension_name = '${name}'`
  );
  return rows.length > 0 && rows[0].loaded === true;
}

// Common DuckDB extensions with descriptions
export const COMMON_EXTENSIONS = [
  { name: 'httpfs', description: 'HTTP/S3 file system support' },
  { name: 'postgres', description: 'PostgreSQL database connector' },
  { name: 'mysql', description: 'MySQL database connector' },
  { name: 'sqlite', description: 'SQLite database connector' },
  { name: 'json', description: 'JSON file support' },
  { name: 'parquet', description: 'Parquet file support' },
  { name: 'excel', description: 'Excel file support (.xlsx)' },
  { name: 'spatial', description: 'Geospatial functions and types' },
  { name: 'fts', description: 'Full-text search' },
  { name: 'iceberg', description: 'Apache Iceberg support' },
  { name: 'delta', description: 'Delta Lake support' },
  { name: 'aws', description: 'AWS credentials and services' },
  { name: 'azure', description: 'Azure Blob Storage support' },
] as const;
