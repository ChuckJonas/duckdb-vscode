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
 * Install a DuckDB extension (downloads if needed).
 * If `community` is true, installs from the community repository directly.
 * If `community` is "auto", tries core first then falls back to community.
 */
export async function installExtension(
  runFn: RunFn,
  name: string,
  community: boolean | "auto" = "auto"
): Promise<void> {
  if (community === true) {
    await runFn(`INSTALL ${name} FROM community`);
    return;
  }

  if (community === false) {
    await runFn(`INSTALL ${name}`);
    return;
  }

  // "auto" mode: try core first, then community as fallback
  try {
    await runFn(`INSTALL ${name}`);
  } catch (coreError) {
    const msg = String(coreError);
    // If it looks like a 404 / not-found error, retry from community
    if (
      msg.includes("404") ||
      msg.includes("Not Found") ||
      msg.includes("not found")
    ) {
      await runFn(`INSTALL ${name} FROM community`);
    } else {
      throw coreError;
    }
  }
}

/**
 * Load an installed extension into the current session
 */
export async function loadExtension(runFn: RunFn, name: string): Promise<void> {
  await runFn(`LOAD ${name}`);
}

/**
 * Install and load an extension in one operation.
 * Uses "auto" community detection by default: tries core, then community fallback.
 */
export async function installAndLoadExtension(
  runFn: RunFn,
  name: string,
  community: boolean | "auto" = "auto"
): Promise<void> {
  await installExtension(runFn, name, community);
  await loadExtension(runFn, name);
}

/**
 * Get all extensions (installed or loaded)
 */
export async function getExtensions(
  queryFn: QueryFn
): Promise<ExtensionInfo[]> {
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

  return rows.map((row) => ({
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
  return rows.map((row) => row.extension_name as string);
}

/**
 * Get only installed extensions
 */
export async function getInstalledExtensions(
  queryFn: QueryFn
): Promise<string[]> {
  const rows = await queryFn(
    `SELECT extension_name FROM duckdb_extensions() WHERE installed = true`
  );
  return rows.map((row) => row.extension_name as string);
}

/**
 * Check if an extension is loaded
 */
export async function isExtensionLoaded(
  queryFn: QueryFn,
  name: string
): Promise<boolean> {
  const rows = await queryFn(
    `SELECT loaded FROM duckdb_extensions() WHERE extension_name = '${name}'`
  );
  return rows.length > 0 && rows[0].loaded === true;
}

// Common DuckDB extensions with descriptions
export const COMMON_EXTENSIONS = [
  { name: "httpfs", description: "HTTP/S3 file system support" },
  { name: "postgres", description: "PostgreSQL database connector" },
  { name: "mysql", description: "MySQL database connector" },
  { name: "sqlite", description: "SQLite database connector" },
  { name: "json", description: "JSON file support" },
  { name: "parquet", description: "Parquet file support" },
  { name: "excel", description: "Excel file support (.xlsx)" },
  { name: "spatial", description: "Geospatial functions and types" },
  { name: "fts", description: "Full-text search" },
  { name: "iceberg", description: "Apache Iceberg support" },
  { name: "delta", description: "Delta Lake support" },
  { name: "aws", description: "AWS credentials and services" },
  { name: "azure", description: "Azure Blob Storage support" },
  {
    name: "cache_httpfs",
    description: "Local caching for HTTP/S3 requests (community)",
  },
] as const;
