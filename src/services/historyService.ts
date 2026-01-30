/**
 * Query History Service
 * Tracks executed queries with metadata, supports optional persistence
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface HistoryEntry {
  id: number;
  sql: string;
  executedAt: Date;
  durationMs: number;
  rowCount: number | null;      // null if error
  columnCount: number | null;   // null if error
  error: string | null;         // null if successful
  databaseName: string;
  sourceFile: string | null;    // Source document URI
}

type QueryFn = (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;
type RunFn = (sql: string) => Promise<void>;

/**
 * Query History Manager
 */
export class HistoryService {
  private entries: HistoryEntry[] = [];
  private nextId = 1;
  private persistDb: { query: QueryFn; run: RunFn } | null = null;
  private dbPath: string | null = null;
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor() {}

  /**
   * Initialize the history service
   * If persistence is enabled, opens/creates the history database
   */
  async initialize(
    createConnection: (dbPath: string) => Promise<{ query: QueryFn; run: RunFn }>
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration('duckdb');
    const persistEnabled = config.get<boolean>('history.persist', false);

    if (persistEnabled) {
      await this.initPersistence(createConnection);
    }
  }

  /**
   * Initialize persistence database
   */
  private async initPersistence(
    createConnection: (dbPath: string) => Promise<{ query: QueryFn; run: RunFn }>
  ): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      console.log('🦆 History: No workspace folder, using in-memory only');
      return;
    }

    // Create .vscode folder if it doesn't exist
    const vscodeDir = path.join(workspaceFolder.uri.fsPath, '.vscode');
    if (!fs.existsSync(vscodeDir)) {
      try {
        fs.mkdirSync(vscodeDir, { recursive: true });
      } catch (e) {
        console.error('🦆 History: Failed to create .vscode folder:', e);
        return;
      }
    }

    this.dbPath = path.join(vscodeDir, 'duckdb-history.db');

    try {
      this.persistDb = await createConnection(this.dbPath);

      // Create schema if needed
      await this.persistDb.run(`
        CREATE TABLE IF NOT EXISTS query_history (
          id INTEGER PRIMARY KEY,
          sql TEXT NOT NULL,
          executed_at TIMESTAMP NOT NULL,
          duration_ms DOUBLE,
          row_count INTEGER,
          column_count INTEGER,
          error TEXT,
          database_name VARCHAR,
          source_file VARCHAR
        )
      `);

      await this.persistDb.run(`
        CREATE INDEX IF NOT EXISTS idx_history_time 
        ON query_history(executed_at DESC)
      `);

      // Load existing history
      await this.loadFromDb();
      console.log(`🦆 History: Loaded ${this.entries.length} entries from ${this.dbPath}`);
    } catch (e) {
      console.error('🦆 History: Failed to initialize persistence:', e);
      this.persistDb = null;
    }
  }

  /**
   * Load history entries from persistent storage
   */
  private async loadFromDb(): Promise<void> {
    if (!this.persistDb) return;

    const result = await this.persistDb.query(`
      SELECT * FROM query_history
      ORDER BY executed_at DESC
      LIMIT 1000
    `);

    this.entries = result.rows.map(row => ({
      id: row.id as number,
      sql: row.sql as string,
      executedAt: new Date(row.executed_at as string),
      durationMs: row.duration_ms as number,
      rowCount: row.row_count as number | null,
      columnCount: row.column_count as number | null,
      error: row.error as string | null,
      databaseName: row.database_name as string,
      sourceFile: row.source_file as string | null,
    }));

    // Update nextId
    if (this.entries.length > 0) {
      this.nextId = Math.max(...this.entries.map(e => e.id)) + 1;
    }
  }

  /**
   * Add a query to history
   * If an identical query exists, updates its timestamp and stats
   */
  async addEntry(entry: Omit<HistoryEntry, 'id'>): Promise<void> {
    // Normalize SQL for comparison (trim whitespace)
    const normalizedSql = entry.sql.trim();

    // Check for duplicate (same SQL text)
    const existingIndex = this.entries.findIndex(
      e => e.sql.trim() === normalizedSql
    );

    if (existingIndex >= 0) {
      // Update existing entry
      const existing = this.entries[existingIndex];
      existing.executedAt = entry.executedAt;
      existing.durationMs = entry.durationMs;
      existing.rowCount = entry.rowCount;
      existing.columnCount = entry.columnCount;
      existing.error = entry.error;
      existing.databaseName = entry.databaseName;
      existing.sourceFile = entry.sourceFile;

      // Move to front (most recent)
      this.entries.splice(existingIndex, 1);
      this.entries.unshift(existing);

      // Update in DB
      if (this.persistDb) {
        await this.persistDb.run(`
          UPDATE query_history SET
            executed_at = '${entry.executedAt.toISOString()}',
            duration_ms = ${entry.durationMs},
            row_count = ${entry.rowCount ?? 'NULL'},
            column_count = ${entry.columnCount ?? 'NULL'},
            error = ${entry.error ? `'${entry.error.replace(/'/g, "''")}'` : 'NULL'},
            database_name = '${entry.databaseName}',
            source_file = ${entry.sourceFile ? `'${entry.sourceFile.replace(/'/g, "''")}'` : 'NULL'}
          WHERE id = ${existing.id}
        `);
      }
    } else {
      // Add new entry
      const newEntry: HistoryEntry = {
        ...entry,
        id: this.nextId++,
        sql: normalizedSql,
      };

      this.entries.unshift(newEntry);

      // Persist to DB
      if (this.persistDb) {
        await this.persistDb.run(`
          INSERT INTO query_history (id, sql, executed_at, duration_ms, row_count, column_count, error, database_name, source_file)
          VALUES (
            ${newEntry.id},
            '${newEntry.sql.replace(/'/g, "''")}',
            '${newEntry.executedAt.toISOString()}',
            ${newEntry.durationMs},
            ${newEntry.rowCount ?? 'NULL'},
            ${newEntry.columnCount ?? 'NULL'},
            ${newEntry.error ? `'${newEntry.error.replace(/'/g, "''")}'` : 'NULL'},
            '${newEntry.databaseName}',
            ${newEntry.sourceFile ? `'${newEntry.sourceFile.replace(/'/g, "''")}'` : 'NULL'}
          )
        `);
      }

      // Prune old entries
      await this.pruneOldEntries();
    }

    this._onDidChange.fire();
  }

  /**
   * Remove old entries beyond max limit
   */
  private async pruneOldEntries(): Promise<void> {
    const config = vscode.workspace.getConfiguration('duckdb');
    const maxEntries = config.get<number>('history.maxEntries', 1000);

    if (this.entries.length > maxEntries) {
      const toRemove = this.entries.splice(maxEntries);
      
      if (this.persistDb && toRemove.length > 0) {
        const ids = toRemove.map(e => e.id).join(',');
        await this.persistDb.run(`DELETE FROM query_history WHERE id IN (${ids})`);
      }
    }
  }

  /**
   * Get all history entries
   */
  getEntries(): HistoryEntry[] {
    return [...this.entries];
  }

  /**
   * Get entries grouped by date
   */
  getEntriesGroupedByDate(): Map<string, HistoryEntry[]> {
    const groups = new Map<string, HistoryEntry[]>();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    for (const entry of this.entries) {
      const entryDate = new Date(entry.executedAt);
      entryDate.setHours(0, 0, 0, 0);

      let groupKey: string;
      if (entryDate.getTime() === today.getTime()) {
        groupKey = 'Today';
      } else if (entryDate.getTime() === yesterday.getTime()) {
        groupKey = 'Yesterday';
      } else {
        groupKey = entryDate.toLocaleDateString('en-US', { 
          month: 'short', 
          day: 'numeric',
          year: entryDate.getFullYear() !== today.getFullYear() ? 'numeric' : undefined
        });
      }

      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey)!.push(entry);
    }

    return groups;
  }

  /**
   * Search history by SQL text
   */
  search(query: string): HistoryEntry[] {
    const lowerQuery = query.toLowerCase();
    return this.entries.filter(e => 
      e.sql.toLowerCase().includes(lowerQuery)
    );
  }

  /**
   * Delete a specific entry
   */
  async deleteEntry(id: number): Promise<void> {
    const index = this.entries.findIndex(e => e.id === id);
    if (index >= 0) {
      this.entries.splice(index, 1);
      
      if (this.persistDb) {
        await this.persistDb.run(`DELETE FROM query_history WHERE id = ${id}`);
      }
      
      this._onDidChange.fire();
    }
  }

  /**
   * Clear all history
   */
  async clearAll(): Promise<void> {
    this.entries = [];
    
    if (this.persistDb) {
      await this.persistDb.run(`DELETE FROM query_history`);
    }
    
    this._onDidChange.fire();
  }

  /**
   * Get entry by ID
   */
  getEntry(id: number): HistoryEntry | undefined {
    return this.entries.find(e => e.id === id);
  }
}

// Singleton instance
let historyServiceInstance: HistoryService | null = null;

export function getHistoryService(): HistoryService {
  if (!historyServiceInstance) {
    historyServiceInstance = new HistoryService();
  }
  return historyServiceInstance;
}
