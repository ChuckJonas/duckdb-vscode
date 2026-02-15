/**
 * Result Cache Service
 *
 * Stores recent query results in memory, keyed by document URI + statement offset.
 * Used by the peek-results feature to show inline result previews without
 * re-executing queries.
 */

import { StatementCacheMeta, PageData } from "./duckdb";

// ============================================================================
// Types
// ============================================================================

export interface CachedResult {
  meta: StatementCacheMeta;
  page: PageData;
  /** When this result was cached */
  cachedAt: number;
}

interface CacheKey {
  docUri: string;
  startOffset: number;
}

// ============================================================================
// Cache
// ============================================================================

const MAX_ENTRIES = 50;

/** Map from "docUri::startOffset" to cached result */
const cache = new Map<string, CachedResult>();

function makeKey(docUri: string, startOffset: number): string {
  return `${docUri}::${startOffset}`;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Store a query result in the cache.
 */
export function cacheResult(
  docUri: string,
  startOffset: number,
  meta: StatementCacheMeta,
  page: PageData
): void {
  const key = makeKey(docUri, startOffset);
  cache.set(key, { meta, page, cachedAt: Date.now() });

  // Evict oldest entries if over limit
  if (cache.size > MAX_ENTRIES) {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [k, v] of cache) {
      if (v.cachedAt < oldestTime) {
        oldestTime = v.cachedAt;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      cache.delete(oldestKey);
    }
  }
}

/**
 * Get a cached result for a specific statement.
 */
export function getCachedResult(
  docUri: string,
  startOffset: number
): CachedResult | undefined {
  return cache.get(makeKey(docUri, startOffset));
}

/**
 * Get all cached results for a document.
 * Returns entries with their startOffset for matching against parsed statements.
 */
export function getCachedResultsForDoc(
  docUri: string
): Map<number, CachedResult> {
  const results = new Map<number, CachedResult>();
  const prefix = `${docUri}::`;
  for (const [key, value] of cache) {
    if (key.startsWith(prefix)) {
      const offset = parseInt(key.slice(prefix.length), 10);
      results.set(offset, value);
    }
  }
  return results;
}

/**
 * Clear cached results for a specific document, or all results.
 */
export function clearResultCache(docUri?: string): void {
  if (!docUri) {
    cache.clear();
    return;
  }
  const prefix = `${docUri}::`;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}
