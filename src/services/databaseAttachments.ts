/**
 * Reference-counted ATTACH pool for database files opened in the file viewer.
 *
 * A `.duckdb` file can only be inspected once it is attached to the shared
 * connection, so previewing one has to ATTACH it. Several editors may point at
 * the same file, and the Database Explorer (or auto-attach) may already own an
 * attachment for it, so holds are pooled:
 *
 * - an attachment created here is detached when the last holder releases it;
 * - an attachment that already existed is reused and never detached.
 */
import * as path from "path";
import * as vscode from "vscode";
import { getDuckDBService } from "./duckdb";
import { getAttachedDatabases } from "./databaseManager";

export interface DatabaseAttachment {
  /** Catalog name the file is attached under. */
  readonly alias: string;
  /** Whether this preview created the attachment. */
  readonly owned: boolean;
  /** Drop this hold; detaches once the last hold is released. */
  release(): Promise<void>;
}

interface PoolEntry {
  alias: string;
  /** False when the attachment predates the first preview hold. */
  owned: boolean;
  refCount: number;
}

/** Keyed by resolved absolute file path. */
const pool = new Map<string, Promise<PoolEntry>>();

/**
 * Attach `filePath` (or reuse an existing attachment) and return a hold on it.
 * Always pair with `release()` — typically from the webview panel's dispose.
 */
export async function acquireDatabaseAttachment(
  filePath: string
): Promise<DatabaseAttachment> {
  const key = path.resolve(filePath);

  let pending = pool.get(key);
  if (!pending) {
    pending = attachFile(key).catch((error) => {
      // A failed attach must not poison later attempts.
      pool.delete(key);
      throw error;
    });
    pool.set(key, pending);
  }

  const entry = await pending;
  entry.refCount++;

  let released = false;
  return {
    alias: entry.alias,
    owned: entry.owned,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      entry.refCount--;
      if (entry.refCount > 0) return;

      pool.delete(key);
      if (!entry.owned) return;

      const db = getDuckDBService();
      try {
        await db.run(`DETACH "${entry.alias.replace(/"/g, '""')}"`);
      } catch {
        // Detach can legitimately fail (e.g. the catalog is the current
        // database, or the connection is already gone) — nothing to recover.
        return;
      }
      refreshExplorer();
    },
  };
}

async function attachFile(filePath: string): Promise<PoolEntry> {
  const db = getDuckDBService();
  const queryFn = async (sql: string) => ({ rows: await db.query(sql) });
  const attached = await getAttachedDatabases(queryFn);

  const existing = attached.find(
    (info) => info.path && path.resolve(info.path) === filePath
  );
  if (existing) {
    return { alias: existing.name, owned: false, refCount: 0 };
  }

  const alias = uniqueAlias(
    path.basename(filePath, path.extname(filePath)),
    new Set(attached.map((info) => info.name))
  );
  const escapedPath = filePath.replace(/'/g, "''");
  const escapedAlias = alias.replace(/"/g, '""');

  try {
    await db.run(
      `ATTACH '${escapedPath}' AS "${escapedAlias}" (READ_ONLY)`
    );
  } catch (readOnlyError) {
    // Read-only attach fails when the file carries an unreplayed WAL. The
    // viewer itself never writes, so fall back to a normal attach and
    // surface the original error if that fails too.
    try {
      await db.run(`ATTACH '${escapedPath}' AS "${escapedAlias}"`);
    } catch {
      throw readOnlyError;
    }
  }

  refreshExplorer();
  return { alias, owned: true, refCount: 0 };
}

/**
 * Turn a file basename into a catalog name that is unique among the currently
 * attached databases. DuckDB accepts quoted identifiers, but keeping the alias
 * plain makes the generated SQL readable in the "Open in Editor" hand-off.
 */
function uniqueAlias(base: string, taken: Set<string>): string {
  const sanitized = base.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+/, "");
  const root = /^[A-Za-z_]/.test(sanitized) ? sanitized : `db_${sanitized}`;
  if (!taken.has(root)) return root;
  for (let i = 2; ; i++) {
    const candidate = `${root}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function refreshExplorer(): void {
  void vscode.commands.executeCommand("duckdb.explorer.refresh").then(
    () => {},
    () => {}
  );
}
