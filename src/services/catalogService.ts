/**
 * Metadata-only catalog discovery shared by the explorer and autocomplete.
 * Persistent snapshots contain no data, SQL definitions, or connection secrets.
 */
import * as fs from "fs/promises";
import * as path from "path";
import { createHash, randomUUID } from "crypto";

export type CatalogQuery = (sql: string) => Promise<Record<string, unknown>[]>;

export interface CatalogDatabase {
  name: string;
  path: string | null;
  type: string;
}

export interface CatalogSchema {
  database: string;
  name: string;
}

export interface CatalogTable {
  database: string;
  schema: string;
  name: string;
  type: "table" | "view";
  rowCount?: number;
}

export interface CatalogColumn {
  name: string;
  type: string;
  isNullable: boolean;
}

export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function sqlIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export async function discoverSchemas(
  query: CatalogQuery,
  database: string,
): Promise<CatalogSchema[]> {
  const rows = await query(`
    SELECT schema_name AS name FROM information_schema.schemata
    WHERE catalog_name = ${sqlString(database)}
      AND schema_name NOT IN ('pg_catalog', 'information_schema')
    ORDER BY schema_name
  `);
  return rows.map((row) => ({ database, name: String(row.name) }));
}

export async function discoverTables(
  query: CatalogQuery,
  database: string,
): Promise<CatalogTable[]> {
  // Views are listed without evaluating them. estimated_size is a row estimate,
  // not a byte size; exact counts belong to an explicit user action.
  const rows = await query(`
    SELECT t.table_schema AS schema, t.table_name AS name, t.table_type,
           d.estimated_size AS row_count
    FROM information_schema.tables t
    LEFT JOIN duckdb_tables() d
      ON d.database_name = t.table_catalog AND d.schema_name = t.table_schema
      AND d.table_name = t.table_name
    WHERE t.table_catalog = ${sqlString(database)}
      AND t.table_schema NOT IN ('pg_catalog', 'information_schema')
      AND t.table_type IN ('BASE TABLE', 'VIEW', 'LOCAL TEMPORARY')
      AND NOT starts_with(t.table_name, '_cache_')
    ORDER BY t.table_type, t.table_name
  `);
  return rows.map((row) => {
    const count =
      row.row_count === null || row.row_count === undefined
        ? undefined
        : Number(row.row_count);
    return {
      database,
      schema: String(row.schema),
      name: String(row.name),
      type: row.table_type === "VIEW" ? "view" : "table",
      ...(count !== undefined && Number.isSafeInteger(count) && count >= 0
        ? { rowCount: count }
        : {}),
    };
  });
}

export async function discoverColumns(
  query: CatalogQuery,
  database: string,
  schema: string,
  table: string,
): Promise<CatalogColumn[]> {
  const rows = await query(`
    SELECT column_name AS name, data_type AS type, is_nullable
    FROM information_schema.columns
    WHERE table_catalog = ${sqlString(database)} AND table_schema = ${sqlString(schema)}
      AND table_name = ${sqlString(table)}
    ORDER BY ordinal_position
  `);
  return rows.map((row) => ({
    name: String(row.name),
    type: String(row.type),
    isNullable: row.is_nullable === "YES",
  }));
}

type PageValue = CatalogSchema[] | CatalogTable[] | CatalogColumn[];
interface Page {
  value: PageValue;
  updatedAt: number;
  restored: boolean;
  retryAt?: number;
}
interface DatabaseState {
  source: CatalogDatabase;
  fingerprint: string | undefined;
  pages: Map<string, Page>;
  pending: Map<string, Promise<PageValue>>;
  revision: number;
}
interface Snapshot {
  version: number;
  fingerprint: string;
  pages: [string, PageValue][];
}

export interface CatalogOptions {
  storagePath?: string;
  persist?: boolean;
  maxBytes?: number;
  /** Revalidate live metadata periodically, including sources without local files. */
  ttlMs?: number;
  onDidChange?: () => void;
  onError?: (error: unknown) => void;
}

const SNAPSHOT_VERSION = 1;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export class CatalogService {
  private options: CatalogOptions;
  private states = new Map<string, DatabaseState>();
  private loading = new Map<string, Promise<DatabaseState>>();
  private databases?: { value: CatalogDatabase[]; updatedAt: number };
  private databaseRequest?: Promise<CatalogDatabase[]>;
  private generation = 0;
  private allowRestore = true;
  private inTransaction = false;
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  private queuedSnapshots = new Set<DatabaseState>();

  constructor(
    private readonly query: CatalogQuery,
    options: CatalogOptions = {},
  ) {
    this.options = options;
  }

  configure(options: CatalogOptions): void {
    if (this.options.storagePath) {
      this.invalidate();
    }
    this.options = options;
  }

  async getDatabases(): Promise<CatalogDatabase[]> {
    if (this.closed) {
      throw new Error("Catalog service is closed");
    }
    // Attachment state is never restored from disk.
    if (this.databases && Date.now() - this.databases.updatedAt < 1000) {
      return this.databases.value;
    }
    if (this.databaseRequest) {
      return this.databaseRequest;
    }
    const generation = this.generation;
    const request = this.query(
      `
      SELECT database_name AS name, path, type FROM duckdb_databases()
      WHERE database_name != 'system' ORDER BY database_name
    `,
    )
      .then((rows) => {
        const value = rows.map((row) => ({
          name: String(row.name),
          path: row.path ? String(row.path) : null,
          type: String(row.type),
        }));
        if (generation === this.generation) {
          this.databases = { value, updatedAt: Date.now() };
        }
        return value;
      })
      .finally(() => {
        if (this.databaseRequest === request) {
          this.databaseRequest = undefined;
        }
      });
    this.databaseRequest = request;
    return request;
  }

  async getSchemas(database: string): Promise<CatalogSchema[]> {
    return this.getPage(database, '["schemas"]', () =>
      discoverSchemas(this.query, database),
    ) as Promise<CatalogSchema[]>;
  }

  async getTables(database: string, schema?: string): Promise<CatalogTable[]> {
    const tables = (await this.getPage(database, '["tables"]', () =>
      discoverTables(this.query, database),
    )) as CatalogTable[];
    return schema === undefined
      ? tables
      : tables.filter((table) => table.schema === schema);
  }

  async getColumns(
    database: string,
    schema: string,
    table: string,
  ): Promise<CatalogColumn[]> {
    return this.getPage(
      database,
      JSON.stringify(["columns", schema, table]),
      () => discoverColumns(this.query, database, schema, table),
    ) as Promise<CatalogColumn[]>;
  }

  async getAllTables(): Promise<CatalogTable[]> {
    const tables: CatalogTable[] = [];
    for (const db of await this.getDatabases()) {
      tables.push(...(await this.getTables(db.name)));
    }
    return tables;
  }

  async getAllSchemas(): Promise<CatalogSchema[]> {
    const schemas: CatalogSchema[] = [];
    for (const db of await this.getDatabases()) {
      schemas.push(...(await this.getSchemas(db.name)));
    }
    return schemas;
  }

  isValidating(database: string): boolean {
    const state = this.states.get(database);
    return (
      !!state &&
      state.pending.size > 0 &&
      [...state.pages.values()].some((page) => page.restored)
    );
  }

  /** Force discovery of one database, or the entire catalog. */
  refresh(database?: string): void {
    if (this.closed) {
      return;
    }
    const state = database ? this.states.get(database) : undefined;
    if (!state) {
      this.invalidate();
      return;
    }
    state.revision++;
    state.pages.clear();
    state.pending.clear();
    if (state.fingerprint && this.options.storagePath) {
      const file = this.snapshotPath(state);
      this.enqueueWrite(() => fs.rm(file, { force: true }));
    }
    this.options.onDidChange?.();
  }

  /** Drop cached metadata; an older request may neither publish nor persist its result.
   * Attachment/context changes preserve snapshots; mutations and forced refresh do not.
   */
  invalidate(clearPersistent = true): void {
    if (this.closed) {
      return;
    }
    this.generation++;
    this.states.clear();
    this.loading.clear();
    this.databases = undefined;
    this.databaseRequest = undefined;
    if (clearPersistent) {
      this.allowRestore = false;
    }
    const directory = this.options.storagePath;
    if (clearPersistent && directory) {
      this.enqueueWrite(async () => {
        await fs.rm(directory, { recursive: true, force: true });
      });
    }
    this.options.onDidChange?.();
  }

  /** Called after each successfully executed user statement, including partial batches. */
  statementExecuted(sql: string): void {
    const normalized = sql.replace(
      /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/,
      "",
    );
    if (/^(BEGIN|START\s+TRANSACTION)\b/i.test(normalized)) {
      this.inTransaction = true;
      this.invalidate();
    } else if (/^(COMMIT|END|ROLLBACK|ABORT)\b/i.test(normalized)) {
      this.inTransaction = false;
      this.invalidate();
    } else if (/^(ATTACH|DETACH|USE|SET|RESET|LOAD)\b/i.test(normalized)) {
      this.invalidate(false);
    } else if (
      /^(CREATE|ALTER|DROP|IMPORT|INSERT|UPDATE|DELETE|MERGE|TRUNCATE|COPY|CALL|PRAGMA)\b/i.test(
        normalized,
      )
    ) {
      this.invalidate();
    }
  }

  /** Wait for background validation and atomic snapshot writes (also used during shutdown). */
  async flush(): Promise<void> {
    await Promise.allSettled(
      [...this.states.values()].flatMap((state) => [...state.pending.values()]),
    );
    await this.writes;
  }

  /** Drain known snapshot writes without waiting on potentially remote queries. */
  async close(): Promise<void> {
    this.closed = true;
    await this.writes;
    this.generation++;
    this.states.clear();
    this.loading.clear();
  }

  private async getPage(
    database: string,
    key: string,
    load: () => Promise<PageValue>,
  ): Promise<PageValue> {
    const generation = this.generation;
    const state = await this.getState(database);
    if (this.closed) {
      throw new Error("Catalog service is closed");
    }
    if (generation !== this.generation) {
      return this.getPage(database, key, load);
    }
    const cached = state.pages.get(key);
    if (cached) {
      if (
        (cached.restored ||
          Date.now() - cached.updatedAt >= (this.options.ttlMs ?? 30000)) &&
        Date.now() >= (cached.retryAt ?? 0)
      ) {
        // A usable snapshot can render immediately while live metadata is checked.
        void this.loadPage(database, state, key, load).catch((error) => {
          if (!this.closed) {
            this.options.onError?.(error);
          }
        });
      }
      return cached.value;
    }
    return this.loadPage(database, state, key, load);
  }

  private loadPage(
    database: string,
    state: DatabaseState,
    key: string,
    load: () => Promise<PageValue>,
  ): Promise<PageValue> {
    const existing = state.pending.get(key);
    if (existing) {
      return existing;
    }
    const generation = this.generation;
    const revision = state.revision;
    const restored = state.pages.get(key)?.restored;
    const request = load()
      .then(async (value) => {
        if (this.closed) {
          return value;
        }
        if (generation !== this.generation || revision !== state.revision) {
          return this.getPage(database, key, load);
        }
        const old = state.pages.get(key);
        state.pages.set(key, { value, updatedAt: Date.now(), restored: false });
        this.persist(state);
        if (
          old &&
          !restored &&
          JSON.stringify(old.value) !== JSON.stringify(value)
        ) {
          this.options.onDidChange?.();
        }
        return value;
      })
      .catch((error) => {
        const cached = state.pages.get(key);
        if (cached) {
          cached.retryAt =
            Date.now() + Math.max(this.options.ttlMs ?? 30000, 1000);
        }
        throw error;
      })
      .finally(() => {
        if (state.pending.get(key) === request) {
          state.pending.delete(key);
          if (restored && !this.closed) {
            this.options.onDidChange?.();
          }
        }
      });
    state.pending.set(key, request);
    if (restored) {
      this.options.onDidChange?.();
    }
    return request;
  }

  private async getState(database: string): Promise<DatabaseState> {
    // Resolve attachment identity before using persisted metadata. An alias can
    // be reused for a different file, or disappear when an attachment fails.
    const source = (await this.getDatabases()).find(
      (db) => db.name === database,
    );
    if (!source) {
      throw new Error(`Database is not attached: ${database}`);
    }
    let state = this.states.get(database);
    const fingerprint = await this.fingerprint(source);
    if (
      state &&
      (state.source.path !== source.path ||
        state.source.type !== source.type ||
        state.fingerprint !== fingerprint)
    ) {
      state.revision++;
      state.pages.clear();
      state.pending.clear();
      state.source = source;
      state.fingerprint = fingerprint;
    }
    if (state) {
      return state;
    }
    const existing = this.loading.get(database);
    if (existing) {
      return existing;
    }
    const generation = this.generation;
    const request = (async () => {
      state = {
        source,
        fingerprint,
        pages: new Map(),
        pending: new Map(),
        revision: 0,
      };
      if (this.allowRestore && this.canPersist(state)) {
        await this.restore(state);
      }
      if (!this.closed && generation === this.generation) {
        this.states.set(database, state);
      }
      return state;
    })().finally(() => {
      if (this.loading.get(database) === request) {
        this.loading.delete(database);
      }
    });
    this.loading.set(database, request);
    return request;
  }

  private canPersist(state: DatabaseState): boolean {
    return (
      !!this.options.storagePath &&
      this.options.persist !== false &&
      !this.inTransaction &&
      state.source.type === "duckdb" &&
      !!state.fingerprint
    );
  }

  private async fingerprint(
    source: CatalogDatabase,
  ): Promise<string | undefined> {
    if (
      source.type !== "duckdb" ||
      !source.path ||
      source.path === ":memory:"
    ) {
      return undefined;
    }
    try {
      const realPath = await fs.realpath(source.path);
      const stat = await fs.stat(realPath);
      if (!stat.isFile()) {
        return undefined;
      }
      const wal = await fs
        .stat(`${realPath}.wal`)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") {
            throw error;
          }
          return undefined;
        });
      return JSON.stringify([
        realPath,
        stat.dev,
        stat.ino,
        stat.size,
        stat.mtimeMs,
        stat.ctimeMs,
        wal && [wal.size, wal.mtimeMs, wal.ctimeMs],
      ]);
    } catch {
      // Unavailable or non-local files still support live discovery, without persistence.
      return undefined;
    }
  }

  private snapshotPath(state: DatabaseState): string {
    const canonicalPath = JSON.parse(state.fingerprint!)[0] as string;
    const key = createHash("sha256").update(canonicalPath).digest("hex");
    return path.join(this.options.storagePath!, `${key}.json`);
  }

  private async restore(state: DatabaseState): Promise<void> {
    try {
      const file = this.snapshotPath(state);
      if (
        (await fs.stat(file)).size >
        (this.options.maxBytes ?? DEFAULT_MAX_BYTES)
      ) {
        return;
      }
      const snapshot: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      if (
        !validSnapshot(snapshot) ||
        snapshot.fingerprint !== state.fingerprint
      ) {
        return;
      }
      for (const [key, value] of snapshot.pages) {
        // Rebind the runtime alias: a file may be attached under a new name.
        const rebound = value.map((row) =>
          "database" in row ? { ...row, database: state.source.name } : row,
        ) as PageValue;
        state.pages.set(key, { value: rebound, updatedAt: 0, restored: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.options.onError?.(error);
      }
    }
  }

  private persist(state: DatabaseState): void {
    if (!this.canPersist(state) || this.queuedSnapshots.has(state)) {
      return;
    }
    // Coalesce discoveries while disk writes are queued. Build the snapshot
    // when the task starts rather than retaining a JSON copy for every column.
    this.queuedSnapshots.add(state);
    this.enqueueWrite(async () => {
      this.queuedSnapshots.delete(state);
      if (
        !this.canPersist(state) ||
        this.states.get(state.source.name) !== state
      ) {
        return;
      }
      const generation = this.generation;
      const revision = state.revision;
      const fingerprint = state.fingerprint!;
      const file = this.snapshotPath(state);
      const directory = this.options.storagePath!;
      const maxBytes = this.options.maxBytes ?? DEFAULT_MAX_BYTES;
      const snapshot: Snapshot = {
        version: SNAPSHOT_VERSION,
        fingerprint,
        pages: [...state.pages].map(([key, page]) => [key, page.value]),
      };
      const content = JSON.stringify(snapshot);
      if (
        Buffer.byteLength(content) > maxBytes ||
        (await this.fingerprint(state.source)) !== fingerprint
      ) {
        return;
      }
      await fs.mkdir(directory, { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, content, { mode: 0o600 });
        if (generation === this.generation && revision === state.revision) {
          await fs.rename(temporary, file);
          await this.prune(directory, maxBytes);
        }
      } finally {
        await fs.rm(temporary, { force: true });
      }
    });
  }

  private enqueueWrite(write: () => Promise<void>): void {
    this.writes = this.writes
      .then(write)
      .catch((error) => this.options.onError?.(error));
  }

  private async prune(directory: string, maxBytes: number): Promise<void> {
    const files = await Promise.all(
      (await fs.readdir(directory))
        .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .map(async (name) => {
          const file = path.join(directory, name);
          const stat = await fs.stat(file);
          return { file, size: stat.size, modified: stat.mtimeMs };
        }),
    );
    files.sort((a, b) => b.modified - a.modified);
    let total = 0;
    for (const file of files) {
      total += file.size;
      if (total > maxBytes) {
        await fs.rm(file.file, { force: true });
      }
    }
  }
}

/** Validate disk input before allowing it into tree nodes or completion results. */
function validSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const snapshot = value as Snapshot;
  return (
    snapshot.version === SNAPSHOT_VERSION &&
    typeof snapshot.fingerprint === "string" &&
    Array.isArray(snapshot.pages) &&
    snapshot.pages.every((entry: unknown) => {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        !Array.isArray(entry[1])
      ) {
        return false;
      }
      let key: unknown;
      try {
        key = JSON.parse(entry[0]);
      } catch {
        return false;
      }
      if (
        !Array.isArray(key) ||
        !key.every((part) => typeof part === "string")
      ) {
        return false;
      }
      const kind = key[0];
      if (
        !((kind === "schemas" || kind === "tables") && key.length === 1) &&
        !(kind === "columns" && key.length === 3)
      ) {
        return false;
      }
      return entry[1].every((value: unknown) => {
        const row = value as Record<string, unknown>;
        if (!row || typeof row !== "object" || typeof row.name !== "string") {
          return false;
        }
        if (kind === "schemas") {
          return typeof row.database === "string";
        }
        if (kind === "columns") {
          return (
            typeof row.type === "string" && typeof row.isNullable === "boolean"
          );
        }
        return (
          typeof row.database === "string" &&
          typeof row.schema === "string" &&
          (row.type === "table" || row.type === "view") &&
          (row.rowCount === undefined ||
            (typeof row.rowCount === "number" &&
              Number.isSafeInteger(row.rowCount) &&
              row.rowCount >= 0))
        );
      });
    })
  );
}
