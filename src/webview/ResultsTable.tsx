import React, {
  useState,
  useMemo,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
} from "react";
import type { ColumnStats, StatementCacheMeta, PageData } from './types';
import { ColumnsPanel } from './ColumnsPanel';
import { Modal } from './ui/Modal';
import { SqlModal } from './ui/SqlModal';
import { JsonSyntaxHighlight } from './ui/JsonHighlight';
import { CellValue } from './ui/CellValue';
import { SqlPreview } from './ui/SqlHighlight';
import {
  FilterBar,
  FilterState,
  ColumnFilter,
  createInitialFilterState,
  filtersToWhereClause,
} from './ui/FilterBar';
import { ColumnFilterPopover } from './ui/ColumnFilterPopover';
import { formatValue, formatTableAsText } from './utils/format';
import {
  buildNestedColumns,
  getValueAtPath,
  type HeaderCell,
  type LeafColumn,
} from "../shared/nestedColumns";
import {
  type ColumnRef,
  columnRefLabel,
  quoteColumnRef,
} from "../shared/columnRef";
import {
  Copy,
  Download,
  ExternalLink,
  ChevronDown,
  Filter,
  BarChart2,
  ArrowUp,
  ArrowDown,
  ChevronsUpDown,
  RefreshCw,
  Save,
} from "lucide-react";
import { CopyButton } from './ui/CopyButton';
import { IconButton } from './ui/IconButton';
import { PopoverMenu } from './ui/PopoverMenu';
import { useToast } from './ui/useToast';
import { Toast } from './ui/Toast';
import './styles.css';

// Get VS Code API (exposed globally from index.tsx)
function getVscodeApi() {
  return (
    window as unknown as { vscodeApi: { postMessage: (msg: unknown) => void } }
  ).vscodeApi;
}

// ============================================================================
// VIRTUALIZATION CONSTANTS
// ============================================================================

/** Initial row-height guess; replaced by measurement after first paint. */
const DEFAULT_ROW_HEIGHT = 33;
/** Rows rendered above/below the visible viewport for smooth scrolling. */
const OVERSCAN_ROWS = 40;
/**
 * Max chunks held in the in-memory row cache. Older/farther chunks are
 * evicted when this is exceeded. 80 chunks * 100 rows ≈ 8k rows resident.
 */
const MAX_CACHED_CHUNKS = 80;
/**
 * Browsers cap the rendered pixel height of a single element. In the Chromium
 * build backing the VS Code webview that ceiling is 2^24 = 16,777,216px
 * (elements taller than this are silently clamped, which would map the full
 * scrollbar onto only part of the data). A naive `totalRows * rowHeight`
 * scroll surface hits this around ~440k rows at ~38px/row, leaving everything
 * past it unreachable (issue #10).
 *
 * We keep the scroll surface safely under that ceiling and, when the ideal
 * height exceeds it, compress: DOM scroll is scaled up to a virtual scroll
 * position so the full result set stays reachable (the scrollbar just becomes
 * coarser the larger the result). Staying strictly below 2^24 guarantees the
 * browser never clamps, so the scaled mapping is exact end-to-end.
 */
const MAX_SCROLL_SURFACE = 16_000_000;

// ============================================================================
// RESULTS TABLE - Display component for a single statement's results
// ============================================================================

export interface ResultsTableProps {
  meta: StatementCacheMeta;
  initialPage: PageData;
  /** Chunk size used for virtualized fetches. Server returns pages of this size. */
  pageSize: number;
  maxCopyRows: number;
  /**
   * Max depth to expand STRUCT columns into nested sub-columns (grouped
   * header). 0 renders structs as JSON in a single column.
   */
  nestedColumnMaxDepth?: number;
  /**
   * When true, the cell expansion modal exposes a Save button that persists
   * edits back to the source. Only set by the host when the cache is the
   * full unbounded source and the format supports DuckDB COPY write-back.
   */
  editable?: boolean;
  hasResults?: boolean;
  statementIndex?: number;
  totalStatements?: number;
  // Collapsible mode props
  isCollapsible?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}

type SortDirection = 'asc' | 'desc' | null;

export function ResultsTable({
  meta,
  initialPage,
  pageSize,
  maxCopyRows,
  nestedColumnMaxDepth = 2,
  editable = false,
  hasResults = true,
  statementIndex,
  totalStatements,
  isCollapsible = false,
  isExpanded = true,
  onToggleExpand,
}: ResultsTableProps) {
  const { cacheId, sql, columns, columnTypes, totalRows, executionTime } = meta;

  // Expand STRUCT columns into nested leaf columns with a grouped header.
  const nested = useMemo(
    () => buildNestedColumns(columns, columnTypes, nestedColumnMaxDepth),
    [columns, columnTypes, nestedColumnMaxDepth],
  );
  const leaves = nested.leaves;

  // ---- Sort / filter state ----
  // `column` is the dotted leaf label (e.g. "s.x"); `path` is the SQL
  // column reference sent to the host.
  const [sort, setSort] = useState<{
    column: string | null;
    path: ColumnRef | null;
    direction: SortDirection;
  }>({
    column: initialPage.sortColumn
      ? columnRefLabel(initialPage.sortColumn)
      : null,
    path: initialPage.sortColumn ?? null,
    direction: initialPage.sortDirection || null,
  });
  const [filterState, setFilterState] = useState<FilterState>(
    createInitialFilterState(),
  );
  const [filteredRowCount, setFilteredRowCount] = useState<number>(totalRows);
  const [filterPopover, setFilterPopover] = useState<{
    column: string;
    columnPath: ColumnRef;
    columnType: string;
    position: { top: number; left: number };
  } | null>(null);
  const [distinctValues, setDistinctValues] = useState<
    { value: string; count: number }[]
  >([]);
  const [columnCardinality, setColumnCardinality] = useState<number>(0);
  const [loadingDistinct, setLoadingDistinct] = useState(false);

  // ---- Virtualized chunk cache ----
  // Map<chunkIndex, rows[]> — chunk i covers rows [i*pageSize .. i*pageSize + pageSize - 1].
  const [chunks, setChunks] = useState<Map<number, Record<string, unknown>[]>>(
    () => {
      const m = new Map<number, Record<string, unknown>[]>();
      if (initialPage.rows.length > 0) {
        // Server may return more than one chunk's worth in initialPage; split.
        for (let i = 0; i < initialPage.rows.length; i += pageSize) {
          const idx = Math.floor((initialPage.offset + i) / pageSize);
          m.set(idx, initialPage.rows.slice(i, i + pageSize));
        }
      }
      return m;
    },
  );
  /** Set of chunk indexes with an in-flight fetch (avoids duplicate requests). */
  const pendingChunks = useRef<Set<number>>(new Set());
  /** LRU access timestamps per chunk, for eviction. */
  const chunkAccess = useRef<Map<number, number>>(new Map());
  /**
   * Bumped on every sort/filter/cacheId reset. Echoed in pageData responses
   * so we drop stale chunks from prior queries (e.g. response for old sort
   * landing after the user has already changed sort).
   */
  const cacheVersion = useRef(0);

  // ---- Scroll viewport state ----
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT);
  const tableWrapperRef = useRef<HTMLDivElement>(null);
  const firstRenderedRowRef = useRef<HTMLTableRowElement>(null);
  const headerRowRef = useRef<HTMLTableSectionElement>(null);
  const [headerHeight, setHeaderHeight] = useState(0);

  // ---- Misc UI state ----
  const [showSqlModal, setShowSqlModal] = useState(false);
  /**
   * Column widths. Keyed by column name. The synthetic key `__rownum__`
   * holds the user-overridden width of the row-number gutter; if absent,
   * the gutter falls back to a digit-derived default.
   */
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  /**
   * The cell currently shown in the expansion / edit modal. When `editable`
   * is true and this cell's row is cached (so we have a __rowid), the modal
   * exposes a Save button.
   */
  const [expandedCell, setExpandedCell] = useState<{
    value: unknown;
    column: string;
    columnType: string;
    rowIndex: number;
    colIndex: number;
    rowId: number | null;
  } | null>(null);
  /**
   * In-flight cell save. Wires the modal's "Saving…" state and routes the
   * `cellUpdated` response back to the right column for cache patching.
   */
  const [cellSave, setCellSave] = useState<{
    rowId: number;
    column: string;
    columnType: string;
  } | null>(null);
  const [cellSaveError, setCellSaveError] = useState<string | null>(null);

  // Selection state — uses ABSOLUTE row indexes (over the full filtered result set).
  interface CellPosition {
    row: number;
    col: number;
  }
  interface Selection {
    start: CellPosition;
    end: CellPosition;
  }
  const [selection, setSelection] = useState<Selection | null>(null);

  const toast = useToast();

  // ---- Columns panel ----
  const [showColumnsPanel, setShowColumnsPanel] = useState(false);
  const [columnsPanelWidth, setColumnsPanelWidth] = useState(() => {
    const maxWidth = Math.min(800, Math.floor(window.innerWidth * 0.5));
    return Math.max(
      320,
      Math.min(maxWidth, Math.floor(window.innerWidth * 0.35)),
    );
  });
  const [initialExpandedColumn, setInitialExpandedColumn] = useState<
    string | null
  >(null);
  const [columnStatsMap, setColumnStatsMap] = useState<
    Record<string, ColumnStats | null>
  >({});
  const [loadingStatsColumn, setLoadingStatsColumn] = useState<string | null>(
    null,
  );
  const [statsError, setStatsError] = useState<string | null>(null);
  const [columnSummaries, setColumnSummaries] = useState<
    Array<{
      name: string;
      distinctCount: number;
      nullPercent: number;
      inferredType: string;
    }>
  >([]);
  const [loadingSummaries, setLoadingSummaries] = useState(false);
  const [summariesLoaded, setSummariesLoaded] = useState(false);

  const [copyLoading, setCopyLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // --------------------------------------------------------------------------
  // Effect: reset everything when the underlying query changes (cacheId).
  // --------------------------------------------------------------------------
  useEffect(() => {
    cacheVersion.current++;
    pendingChunks.current.clear();
    chunkAccess.current.clear();
    setColumnStatsMap({});
    setColumnSummaries([]);
    setSummariesLoaded(false);
    setLoadingStatsColumn(null);
    setStatsError(null);
    setShowColumnsPanel(false);
    setInitialExpandedColumn(null);
    setFilterState(createInitialFilterState());
    setFilteredRowCount(totalRows);
    setDistinctValues([]);
    setColumnCardinality(0);
    setFilterPopover(null);
    setIsRefreshing(false);
    setSelection(null);
    setScrollTop(0);
    if (tableWrapperRef.current) tableWrapperRef.current.scrollTop = 0;
  }, [cacheId, totalRows]);

  // --------------------------------------------------------------------------
  // Effect: when initialPage changes (refresh / new query), seed cache.
  // --------------------------------------------------------------------------
  useEffect(() => {
    const m = new Map<number, Record<string, unknown>[]>();
    if (initialPage.rows.length > 0) {
      for (let i = 0; i < initialPage.rows.length; i += pageSize) {
        const idx = Math.floor((initialPage.offset + i) / pageSize);
        m.set(idx, initialPage.rows.slice(i, i + pageSize));
        chunkAccess.current.set(idx, Date.now());
      }
    }
    setChunks(m);
    setSort({
      column: initialPage.sortColumn
        ? columnRefLabel(initialPage.sortColumn)
        : null,
      path: initialPage.sortColumn ?? null,
      direction: initialPage.sortDirection || null,
    });
  }, [initialPage, pageSize]);

  // --------------------------------------------------------------------------
  // Scroll + resize tracking.
  // --------------------------------------------------------------------------
  useEffect(() => {
    const el = tableWrapperRef.current;
    if (!el) return;

    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setScrollTop(el.scrollTop);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });

    const ro =
      "ResizeObserver" in window
        ? new ResizeObserver(() => setViewportHeight(el.clientHeight))
        : null;
    ro?.observe(el);
    setViewportHeight(el.clientHeight);

    return () => {
      el.removeEventListener('scroll', onScroll);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [cacheId]);

  // Measure row + header height after first paint to keep math accurate.
  useLayoutEffect(() => {
    if (headerRowRef.current) {
      const h = headerRowRef.current.offsetHeight;
      if (h > 0 && Math.abs(h - headerHeight) > 0.5) setHeaderHeight(h);
    }
    if (firstRenderedRowRef.current) {
      const h = firstRenderedRowRef.current.offsetHeight;
      if (h > 0 && Math.abs(h - rowHeight) > 0.5) setRowHeight(h);
    }
  });

  // --------------------------------------------------------------------------
  // Compute the visible row range and which chunks back it.
  //
  // The scroll surface is capped at MAX_SCROLL_SURFACE so it never exceeds the
  // browser's max element height (issue #10). When the ideal height
  // (filteredRowCount * rowHeight) fits under the cap, `scrollScale === 1` and
  // this is a plain 1:1 virtualization. When it doesn't, the DOM scrollTop is
  // linearly scaled up to a "virtual" scroll position so every row stays
  // reachable, and the rendered slice is positioned to track the viewport.
  // --------------------------------------------------------------------------
  const visibleHeight = Math.max(0, viewportHeight - headerHeight);
  const idealTotalHeight = filteredRowCount * rowHeight;
  const scrollSurfaceHeight = Math.min(idealTotalHeight, MAX_SCROLL_SURFACE);
  // The DOM's scrollTop range and the virtual (ideal) scroll range. Their
  // ratio is the compression factor (>= 1; exactly 1 when not compressed).
  const domScrollRange = Math.max(1, scrollSurfaceHeight - visibleHeight);
  const virtualScrollRange = Math.max(0, idealTotalHeight - visibleHeight);
  const scrollScale = virtualScrollRange / domScrollRange;
  const virtualScrollTop = Math.min(
    virtualScrollRange,
    scrollTop * scrollScale,
  );

  const firstVisible = Math.max(0, Math.floor(virtualScrollTop / rowHeight));
  const lastVisible = Math.min(
    filteredRowCount,
    Math.ceil((virtualScrollTop + visibleHeight) / rowHeight)
  );
  // Fractional (sub-row) part of the scroll position at the viewport top.
  const fractional = virtualScrollTop - firstVisible * rowHeight;
  // Cap overscan above the first visible row so the top spacer never goes
  // negative under compression (which would misalign the rendered slice).
  const aboveCapacity = Math.floor(
    Math.max(0, scrollTop - fractional) / rowHeight,
  );
  const overscanAbove = Math.min(OVERSCAN_ROWS, aboveCapacity);
  const renderStart = Math.max(0, firstVisible - overscanAbove);
  const renderEnd = Math.min(filteredRowCount, lastVisible + OVERSCAN_ROWS);
  // Position the rendered slice at the current scroll position. In the
  // non-compressed case this reduces exactly to `renderStart * rowHeight`.
  const renderedHeight = (renderEnd - renderStart) * rowHeight;
  const topSpacerHeight = Math.max(
    0,
    scrollTop - fractional - (firstVisible - renderStart) * rowHeight
  );
  const bottomSpacerHeight = Math.max(
    0,
    scrollSurfaceHeight - topSpacerHeight - renderedHeight
  );

  // --------------------------------------------------------------------------
  // Helper: build the active where clause from filter state.
  // --------------------------------------------------------------------------
  const getActiveWhereClause = useCallback((): string => {
    if (filterState.isPaused) return '';
    return filtersToWhereClause(filterState.filters);
  }, [filterState]);

  // --------------------------------------------------------------------------
  // Fetch a single chunk by index. Used both for fill-in during scroll and
  // for a fresh load after sort/filter reset (chunkIdx=0 after clearing).
  // --------------------------------------------------------------------------
  const fetchChunk = useCallback(
    (
      chunkIdx: number,
      opts?: {
        sortColumn?: ColumnRef | null;
        sortDirection?: SortDirection;
        whereClause?: string;
      },
    ) => {
      if (!cacheId) return;
      if (pendingChunks.current.has(chunkIdx)) return;
      pendingChunks.current.add(chunkIdx);
      const vscode = getVscodeApi();
      vscode?.postMessage({
        type: 'requestPage',
        cacheId,
        offset: chunkIdx * pageSize,
        sortColumn: opts?.sortColumn ?? sort.path ?? undefined,
        sortDirection: opts?.sortDirection ?? sort.direction ?? undefined,
        whereClause: opts?.whereClause ?? getActiveWhereClause(),
        requestVersion: cacheVersion.current,
      });
    },
    [cacheId, pageSize, sort, getActiveWhereClause]
  );

  // --------------------------------------------------------------------------
  // Trigger fetches for chunks intersecting the visible window.
  // --------------------------------------------------------------------------
  useEffect(() => {
    if (!cacheId || filteredRowCount === 0) return;
    const firstChunk = Math.floor(renderStart / pageSize);
    const lastChunk = Math.floor(
      Math.max(renderStart, renderEnd - 1) / pageSize,
    );
    for (let c = firstChunk; c <= lastChunk; c++) {
      if (!chunks.has(c) && !pendingChunks.current.has(c)) {
        fetchChunk(c);
      }
    }
  }, [
    renderStart,
    renderEnd,
    chunks,
    fetchChunk,
    cacheId,
    filteredRowCount,
    pageSize,
  ]);

  // --------------------------------------------------------------------------
  // Reset cache, scroll, and refetch chunk 0 — used when sort/filter changes.
  // --------------------------------------------------------------------------
  const resetAndReload = useCallback(
    (
      sortColumn: ColumnRef | null,
      sortDirection: SortDirection,
      whereClause: string,
    ) => {
      cacheVersion.current++;
      pendingChunks.current.clear();
      chunkAccess.current.clear();
      setChunks(new Map());
      setSelection(null);
      if (tableWrapperRef.current) tableWrapperRef.current.scrollTop = 0;
      setScrollTop(0);
      // Fetch the first chunk immediately; the visible-range effect will
      // request additional chunks once the response arrives.
      fetchChunk(0, { sortColumn, sortDirection, whereClause });
    },
    [fetchChunk]
  );

  // --------------------------------------------------------------------------
  // Message handler — wire up incoming pageData / column stats / etc.
  // --------------------------------------------------------------------------
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;

      if (message.type === 'pageData' && message.data?.cacheId === cacheId) {
        // Drop stale responses from a prior cacheVersion (sort/filter changed).
        if (
          typeof message.requestVersion === 'number' &&
          message.requestVersion !== cacheVersion.current
        ) {
          return;
        }
        const data = message.data as PageData;
        const chunkIdx = Math.floor(data.offset / pageSize);
        pendingChunks.current.delete(chunkIdx);

        setFilteredRowCount(data.totalRows);
        setChunks((prev) => {
          const next = new Map(prev);
          next.set(chunkIdx, data.rows);
          chunkAccess.current.set(chunkIdx, Date.now());
          // LRU eviction: keep only the MAX_CACHED_CHUNKS most-recently-used,
          // but never evict chunks currently in the visible render window.
          if (next.size > MAX_CACHED_CHUNKS) {
            const visibleFirst = Math.floor(renderStart / pageSize);
            const visibleLast = Math.floor(
              Math.max(renderStart, renderEnd - 1) / pageSize,
            );
            const candidates = [...next.keys()].filter(
              (k) => k < visibleFirst || k > visibleLast
            );
            candidates.sort((a, b) => {
              const ta = chunkAccess.current.get(a) ?? 0;
              const tb = chunkAccess.current.get(b) ?? 0;
              return ta - tb;
            });
            const excess = next.size - MAX_CACHED_CHUNKS;
            for (let i = 0; i < excess && i < candidates.length; i++) {
              next.delete(candidates[i]);
              chunkAccess.current.delete(candidates[i]);
            }
          }
          return next;
        });
      } else if (
        message.type === "columnStats" &&
        message.cacheId === cacheId
      ) {
        if (message.data) {
          setColumnStatsMap((prev) => ({
            ...prev,
            [message.data.column]: message.data,
          }));
        }
        setStatsError(message.error || null);
        setLoadingStatsColumn(null);
      } else if (
        message.type === "columnSummaries" &&
        message.cacheId === cacheId
      ) {
        if (message.data) setColumnSummaries(message.data);
        setLoadingSummaries(false);
        setSummariesLoaded(true);
      } else if (
        message.type === "distinctValues" &&
        message.cacheId === cacheId
      ) {
        setDistinctValues(message.data || []);
        setColumnCardinality(message.cardinality || 0);
        setLoadingDistinct(false);
      } else if (
        message.type === "filterError" &&
        message.cacheId === cacheId
      ) {
        if (
          typeof message.requestVersion === 'number' &&
          message.requestVersion !== cacheVersion.current
        ) {
          return;
        }
        toast.show(message.error || 'Filter error');
      } else if (message.type === 'copyData') {
        setCopyLoading(false);
        if (message.error) {
          toast.show('Copy failed');
        } else if (message.data) {
          const {
            columns: copyColumns,
            rows: copyRows,
            maxCopyRows: limit,
          } = message.data;
          const text = formatTableAsText(copyColumns, copyRows);
          navigator.clipboard
            .writeText(text)
            .then(() => {
              const rowCount = copyRows.length;
              const label =
                rowCount >= limit
                  ? `${rowCount.toLocaleString()} rows (limit)`
                  : `${rowCount.toLocaleString()} rows`;
              toast.show(`Copied ${label}`);
            })
            .catch(() => {
              toast.show("Failed to copy");
            });
        }
      } else if (message.type === 'refreshError') {
        setIsRefreshing(false);
        toast.show(message.error || 'Refresh failed');
      } else if (message.type === 'cellUpdated') {
        // Match against in-flight cell save by rowId+column.
        if (
          !cellSave ||
          message.rowId !== cellSave.rowId ||
          message.column !== cellSave.column
        )
          return;
        if (message.error) {
          setCellSaveError(message.error);
          setCellSave(null);
          return;
        }
        // Patch the cached chunk so the table reflects the new value
        // immediately, without round-tripping a fresh fetch.
        setChunks((prev) => {
          const next = new Map(prev);
          for (const [chunkIdx, rows] of next) {
            for (let i = 0; i < rows.length; i++) {
              const r = rows[i] as Record<string, unknown>;
              const rid = r.__rowid;
              const ridNum =
                typeof rid === "bigint"
                  ? Number(rid)
                  : typeof rid === "number"
                    ? rid
                    : null;
              if (ridNum === message.rowId) {
                const updated = { ...r, [message.column]: message.newValue };
                const newRows = rows.slice();
                newRows[i] = updated;
                next.set(chunkIdx, newRows);
                return next;
              }
            }
          }
          return next;
        });
        setCellSave(null);
        setCellSaveError(null);
        setExpandedCell(null);
        toast.show('Cell saved');
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [cacheId, pageSize, renderStart, renderEnd, toast, cellSave]);

  // --------------------------------------------------------------------------
  // Sort / filter handlers — all converge on resetAndReload.
  // --------------------------------------------------------------------------
  const handleSort = useCallback(
    (column: string, path: ColumnRef) => {
      let next: {
        column: string | null;
        path: ColumnRef | null;
        direction: SortDirection;
      };
      if (sort.column !== column) next = { column, path, direction: "asc" };
      else if (sort.direction === "asc")
        next = { column, path, direction: "desc" };
      else next = { column: null, path: null, direction: null };
      setSort(next);
      resetAndReload(next.path, next.direction, getActiveWhereClause());
    },
    [sort, resetAndReload, getActiveWhereClause],
  );

  const applyFilters = useCallback(
    (newFilters: ColumnFilter[]) => {
      const clause = filtersToWhereClause(newFilters);
      resetAndReload(sort.path, sort.direction, clause);
    },
    [resetAndReload, sort],
  );

  const handleAddFilter = useCallback(
    (filter: ColumnFilter) => {
      const newFilters = [...filterState.filters, filter];
      setFilterState((prev) => ({ ...prev, filters: newFilters }));
      applyFilters(newFilters);
      setFilterPopover(null);
    },
    [filterState.filters, applyFilters],
  );

  const handleRemoveFilter = useCallback(
    (filterId: string) => {
      const newFilters = filterState.filters.filter((f) => f.id !== filterId);
      setFilterState((prev) => ({ ...prev, filters: newFilters }));
      applyFilters(newFilters);
    },
    [filterState.filters, applyFilters],
  );

  const handleClearFilters = useCallback(() => {
    setFilterState(createInitialFilterState());
    resetAndReload(sort.path, sort.direction, "");
  }, [resetAndReload, sort]);

  const handleTogglePause = useCallback(() => {
    setFilterState((prev) => {
      const newPaused = !prev.isPaused;
      const clause = newPaused ? '' : filtersToWhereClause(prev.filters);
      resetAndReload(sort.path, sort.direction, clause);
      return { ...prev, isPaused: newPaused };
    });
  }, [resetAndReload, sort]);

  const handleOpenFilterPopover = useCallback(
    (
      column: string,
      columnPath: ColumnRef,
      columnType: string,
      event: React.MouseEvent,
    ) => {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const tableRect = tableWrapperRef.current?.getBoundingClientRect();
      setFilterPopover({
        column,
        columnPath,
        columnType,
        position: {
          top: rect.bottom - (tableRect?.top || 0) + 4,
          left: rect.left - (tableRect?.left || 0),
        },
      });
      setLoadingDistinct(true);
      getVscodeApi()?.postMessage({
        type: "requestDistinctValues",
        cacheId,
        column: columnPath,
      });
    },
    [cacheId],
  );

  // --------------------------------------------------------------------------
  // Export, copy, refresh, navigation
  // --------------------------------------------------------------------------
  const handleExport = useCallback(
    (format: "csv" | "parquet" | "json" | "jsonl" | "csv-tab" | "json-tab") => {
      getVscodeApi()?.postMessage({ type: "export", cacheId, format });
    },
    [cacheId],
  );

  const requestColumnSummaries = useCallback(() => {
    if (!cacheId || summariesLoaded) return;
    setLoadingSummaries(true);
    getVscodeApi()?.postMessage({ type: 'requestColumnSummaries', cacheId });
  }, [cacheId, summariesLoaded]);

  const activeWhereClause = useMemo(() => {
    if (filterState.isPaused || filterState.filters.length === 0)
      return undefined;
    return filtersToWhereClause(filterState.filters);
  }, [filterState]);

  // Clear column stats when filters change (stats need re-computation).
  useEffect(() => {
    setColumnStatsMap({});
  }, [activeWhereClause]);

  /** Dotted leaf label -> column reference, for resolving UI labels to SQL. */
  const leafPathByLabel = useMemo(() => {
    const m = new Map<string, ColumnRef>();
    for (const leaf of leaves) m.set(columnRefLabel(leaf.path), leaf.path);
    return m;
  }, [leaves]);

  /**
   * Request stats for a leaf column. `columnName` is the dotted label used
   * as the stats-cache key; the host receives the path form for SQL. The
   * columns panel calls this with a label only, so unknown labels fall back
   * to resolving through the leaf map (and finally to the raw name, which
   * covers unexpanded top-level columns).
   */
  const requestColumnStats = useCallback(
    (columnName: string, columnPath?: ColumnRef) => {
      if (!cacheId) return;
      setLoadingStatsColumn(columnName);
      setStatsError(null);
      getVscodeApi()?.postMessage({
        type: "requestColumnStats",
        cacheId,
        column: columnPath ?? leafPathByLabel.get(columnName) ?? columnName,
        whereClause: activeWhereClause,
      });
    },
    [cacheId, activeWhereClause, leafPathByLabel],
  );

  const openColumnStats = useCallback(
    (columnName: string, columnPath?: ColumnRef) => {
      if (showColumnsPanel && initialExpandedColumn === columnName) {
        setShowColumnsPanel(false);
        setInitialExpandedColumn(null);
      } else {
        setInitialExpandedColumn(columnName);
        setShowColumnsPanel(true);
        if (!summariesLoaded) requestColumnSummaries();
        requestColumnStats(columnName, columnPath);
      }
    },
    [
      showColumnsPanel,
      initialExpandedColumn,
      requestColumnStats,
      summariesLoaded,
      requestColumnSummaries,
    ],
  );

  const handleColumnResize = useCallback((column: string, width: number) => {
    setColumnWidths((prev) => ({ ...prev, [column]: Math.max(50, width) }));
  }, []);

  /**
   * Row-number gutter width. Default scales with the digit count of the
   * largest visible row index so values like `10,000,000` don't clip.
   * Overridden when the user drags the gutter's resize handle.
   */
  const ROW_NUMBER_KEY = '__rownum__';
  const rowNumberWidth = useMemo(() => {
    if (columnWidths[ROW_NUMBER_KEY]) return columnWidths[ROW_NUMBER_KEY];
    // (filteredRowCount).toLocaleString() length × ~7px monospace + padding.
    const digits = Math.max(1, String(Math.max(filteredRowCount, 1)).length);
    const commas = Math.max(0, Math.floor((digits - 1) / 3));
    return Math.max(50, (digits + commas) * 8 + 20);
  }, [columnWidths, filteredRowCount]);
  const rowNumberStyle: React.CSSProperties = {
    width: rowNumberWidth,
    minWidth: rowNumberWidth,
    maxWidth: rowNumberWidth,
  };
  const handleRowNumberResize = useCallback(
    (width: number) => handleColumnResize(ROW_NUMBER_KEY, width),
    [handleColumnResize]
  );

  const copyToClipboard = useCallback(
    async (text: string, label: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast.show(`Copied ${label}`);
      } catch {
        toast.show("Failed to copy");
      }
    },
    [toast],
  );

  const copyFullTable = useCallback(() => {
    if (!cacheId || copyLoading) return;
    setCopyLoading(true);
    getVscodeApi()?.postMessage({ type: 'requestCopyData', cacheId });
  }, [cacheId, copyLoading]);

  const handleRefresh = useCallback(() => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    getVscodeApi()?.postMessage({ type: 'refreshQuery' });
  }, [isRefreshing]);

  /**
   * "Open in Editor" handler — receives whichever SQL the modal is
   * currently showing.
   *   - When the user is viewing the source query (`sqlToOpen === sql`),
   *     post `goToSource`. The host reveals the existing .sql editor tab
   *     when the panel was opened from a file, or creates a new untitled
   *     .sql doc otherwise.
   *   - When the user has the filtered/sorted form displayed, post
   *     `openAsSql` with that SQL so the host opens an untitled .sql
   *     doc containing the exact query they're looking at.
   */
  const handleOpenInEditor = useCallback(
    (sqlToOpen: string) => {
      if (sqlToOpen === sql) {
        getVscodeApi()?.postMessage({ type: "goToSource" });
      } else {
        getVscodeApi()?.postMessage({ type: "openAsSql", sql: sqlToOpen });
      }
    },
    [sql],
  );

  // --------------------------------------------------------------------------
  // Selection helpers — operate on absolute row indexes.
  // Lookups against `chunks` resolve only the rows that are currently cached;
  // un-cached rows in a selected range produce '—' on copy.
  // --------------------------------------------------------------------------
  const lookupRow = useCallback(
    (rowIdx: number): Record<string, unknown> | null => {
      const chunkIdx = Math.floor(rowIdx / pageSize);
      const chunk = chunks.get(chunkIdx);
      return chunk ? (chunk[rowIdx % pageSize] ?? null) : null;
    },
    [chunks, pageSize],
  );

  const isCellSelected = useCallback(
    (rowIdx: number, colIdx: number): boolean => {
      if (!selection) return false;
      const minRow = Math.min(selection.start.row, selection.end.row);
      const maxRow = Math.max(selection.start.row, selection.end.row);
      const minCol = Math.min(selection.start.col, selection.end.col);
      const maxCol = Math.max(selection.start.col, selection.end.col);
      return (
        rowIdx >= minRow &&
        rowIdx <= maxRow &&
        colIdx >= minCol &&
        colIdx <= maxCol
      );
    },
    [selection],
  );

  const isRowSelected = useCallback(
    (rowIdx: number): boolean => {
      if (!selection) return false;
      const minRow = Math.min(selection.start.row, selection.end.row);
      const maxRow = Math.max(selection.start.row, selection.end.row);
      const minCol = Math.min(selection.start.col, selection.end.col);
      const maxCol = Math.max(selection.start.col, selection.end.col);
      return (
        rowIdx >= minRow &&
        rowIdx <= maxRow &&
        minCol === 0 &&
        maxCol === leaves.length - 1
      );
    },
    [selection, leaves.length],
  );

  const isColumnSelected = useCallback(
    (colIdx: number): boolean => {
      if (!selection) return false;
      const minRow = Math.min(selection.start.row, selection.end.row);
      const maxRow = Math.max(selection.start.row, selection.end.row);
      const minCol = Math.min(selection.start.col, selection.end.col);
      const maxCol = Math.max(selection.start.col, selection.end.col);
      return (
        colIdx >= minCol &&
        colIdx <= maxCol &&
        minRow === 0 &&
        maxRow === filteredRowCount - 1
      );
    },
    [selection, filteredRowCount],
  );

  const handleCellClick = useCallback(
    (rowIdx: number, colIdx: number, e: React.MouseEvent) => {
      if (e.shiftKey && selection) {
        setSelection((prev) =>
          prev
            ? { start: prev.start, end: { row: rowIdx, col: colIdx } }
            : null,
        );
      } else {
        const single =
          selection &&
          selection.start.row === selection.end.row &&
          selection.start.col === selection.end.col &&
          selection.start.row === rowIdx &&
          selection.start.col === colIdx;
        setSelection(
          single
            ? null
            : {
                start: { row: rowIdx, col: colIdx },
                end: { row: rowIdx, col: colIdx },
              },
        );
      }
    },
    [selection],
  );

  const handleCellDoubleClick = useCallback(
    (rowIdx: number, colIdx: number) => {
      const row = lookupRow(rowIdx);
      if (!row) return;
      const leaf = leaves[colIdx];
      if (!leaf) return;
      // __rowid is injected by the server (fetchPage) so the modal can edit
      // the right row regardless of the active sort / filter context.
      const rid = (row as Record<string, unknown>).__rowid;
      const rowId =
        typeof rid === "bigint"
          ? Number(rid)
          : typeof rid === "number"
            ? rid
            : null;
      setExpandedCell({
        value: leaf.isNested
          ? getValueAtPath(row, leaf.path)
          : row[leaf.path[0]],
        column: leaf.path.join("."),
        columnType: leaf.type,
        rowIndex: rowIdx,
        colIndex: colIdx,
        // Editing writes back by top-level column name; nested sub-cells are
        // view-only (rowId null disables the Save affordance).
        rowId: leaf.isNested ? null : rowId,
      });
      setCellSaveError(null);
    },
    [lookupRow, leaves],
  );

  /**
   * Save handler for the cell modal. Posts updateCell to the host, leaving
   * the modal in a saving state until the matching cellUpdated response
   * arrives in the message effect below.
   */
  const handleCellSave = useCallback(
    (newValue: string | null) => {
      if (!expandedCell || expandedCell.rowId === null) return;
      setCellSave({
        rowId: expandedCell.rowId,
        column: expandedCell.column,
        columnType: expandedCell.columnType,
      });
      setCellSaveError(null);
      getVscodeApi()?.postMessage({
        type: "updateCell",
        cacheId,
        rowId: expandedCell.rowId,
        column: expandedCell.column,
        columnType: expandedCell.columnType,
        newValue,
      });
    },
    [expandedCell, cacheId],
  );

  const handleRowSelect = useCallback(
    (rowIdx: number, e: React.MouseEvent) => {
      if (e.shiftKey && selection) {
        setSelection((prev) =>
          prev
            ? {
                start: { row: prev.start.row, col: 0 },
                end: { row: rowIdx, col: leaves.length - 1 },
              }
            : null,
        );
      } else {
        setSelection({
          start: { row: rowIdx, col: 0 },
          end: { row: rowIdx, col: leaves.length - 1 },
        });
      }
    },
    [selection, leaves.length],
  );

  const handleColumnSelect = useCallback(
    (colIdx: number, e: React.MouseEvent) => {
      if (e.shiftKey && selection) {
        setSelection((prev) =>
          prev
            ? {
                start: { row: 0, col: prev.start.col },
                end: { row: filteredRowCount - 1, col: colIdx },
              }
            : null,
        );
      } else {
        setSelection({
          start: { row: 0, col: colIdx },
          end: { row: filteredRowCount - 1, col: colIdx },
        });
      }
    },
    [selection, filteredRowCount],
  );

  const selectAll = useCallback(() => {
    if (filteredRowCount === 0) return;
    setSelection({
      start: { row: 0, col: 0 },
      end: { row: filteredRowCount - 1, col: leaves.length - 1 },
    });
  }, [filteredRowCount, leaves.length]);

  const getSelectionText = useCallback((): string => {
    /**
     * Cap selection-text materialization. With virtualized scroll, a
     * column-select on a 10M-row table would otherwise build a 10M-line
     * string (and most rows aren't cached anyway). The "Copy Table"
     * button is the right tool for full-result exports.
     */
    const SELECTION_ROW_CAP = 10_000;

    const leafValue = (row: Record<string, unknown>, leaf: LeafColumn) =>
      leaf.isNested ? getValueAtPath(row, leaf.path) : row[leaf.path[0]];

    if (!selection) {
      // No explicit selection: copy the currently-rendered slice.
      const header = leaves.map((l) => l.path.join(".")).join("\t");
      const lines: string[] = [header];
      for (let r = renderStart; r < renderEnd; r++) {
        const row = lookupRow(r);
        if (row)
          lines.push(
            leaves.map((l) => formatValue(leafValue(row, l))).join("\t"),
          );
      }
      return lines.join("\n");
    }
    const minRow = Math.min(selection.start.row, selection.end.row);
    const maxRow = Math.max(selection.start.row, selection.end.row);
    const minCol = Math.min(selection.start.col, selection.end.col);
    const maxCol = Math.max(selection.start.col, selection.end.col);
    const selectedLeaves = leaves.slice(minCol, maxCol + 1);
    if (minRow === maxRow && minCol === maxCol) {
      const row = lookupRow(minRow);
      return row ? formatValue(leafValue(row, leaves[minCol])) : "";
    }
    const effectiveMax = Math.min(maxRow, minRow + SELECTION_ROW_CAP - 1);
    const truncated = maxRow > effectiveMax;
    const lines: string[] = [];
    for (let r = minRow; r <= effectiveMax; r++) {
      const row = lookupRow(r);
      if (!row) {
        // Row not cached yet — placeholder so column alignment is preserved.
        lines.push(selectedLeaves.map(() => "").join("\t"));
      } else {
        lines.push(
          selectedLeaves
            .map((leaf) => formatValue(leafValue(row, leaf)))
            .join("\t"),
        );
      }
    }
    if (truncated) {
      // Mention this in-line so the user knows why the copy is shorter.
      lines.push(
        `-- truncated at ${SELECTION_ROW_CAP.toLocaleString()} rows; use "Copy Table" for the full export`,
      );
    }
    return lines.join('\n');
  }, [selection, leaves, lookupRow, renderStart, renderEnd]);

  const getSelectionLabel = useCallback((): string => {
    if (!selection) return 'visible rows';
    const minRow = Math.min(selection.start.row, selection.end.row);
    const maxRow = Math.max(selection.start.row, selection.end.row);
    const minCol = Math.min(selection.start.col, selection.end.col);
    const maxCol = Math.max(selection.start.col, selection.end.col);
    const rowCount = maxRow - minRow + 1;
    const colCount = maxCol - minCol + 1;
    if (rowCount === 1 && colCount === 1) return 'cell';
    if (colCount === leaves.length)
      return `${rowCount} row${rowCount > 1 ? "s" : ""}`;
    return `${rowCount}×${colCount} cells`;
  }, [selection, leaves.length]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        !tableWrapperRef.current?.contains(document.activeElement) &&
        document.activeElement !== document.body
      )
        return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
        const textSelection = window.getSelection();
        if (textSelection && textSelection.toString().length > 0) return;
        e.preventDefault();
        copyToClipboard(getSelectionText(), getSelectionLabel());
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault();
        selectAll();
      }
      if (e.key === 'Escape') setSelection(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [getSelectionText, getSelectionLabel, copyToClipboard, selectAll]);

  const selectionInfo = useMemo(() => {
    if (!selection) return null;
    const minRow = Math.min(selection.start.row, selection.end.row);
    const maxRow = Math.max(selection.start.row, selection.end.row);
    const minCol = Math.min(selection.start.col, selection.end.col);
    const maxCol = Math.max(selection.start.col, selection.end.col);
    const rowCount = maxRow - minRow + 1;
    const colCount = maxCol - minCol + 1;
    if (rowCount === 1 && colCount === 1) return null;
    return `${rowCount}×${colCount}`;
  }, [selection]);

  // Build full SQL with original query + filters + sort
  const fullSql = useMemo(() => {
    const whereClause = filtersToWhereClause(filterState.filters);
    const hasFilters = whereClause.length > 0 && !filterState.isPaused;
    const hasSort = sort.column !== null;
    if (!hasFilters && !hasSort) return sql;
    const parts: string[] = [];
    parts.push('SELECT * FROM (');
    parts.push(
      "  " +
        sql
          .trim()
          .replace(/;?\s*$/, "")
          .split("\n")
          .join("\n  "),
    );
    parts.push(') AS _query');
    if (hasFilters) parts.push(`WHERE ${whereClause}`);
    if (hasSort)
      parts.push(
        `ORDER BY ${quoteColumnRef(sort.path ?? sort.column ?? "")} ${
          sort.direction?.toUpperCase() || "ASC"
        }`,
      );
    return parts.join('\n');
  }, [sql, filterState, sort]);

  const statementLabel =
    totalStatements !== undefined && statementIndex !== undefined
      ? `Query ${statementIndex + 1} of ${totalStatements}`
      : null;

  // --------------------------------------------------------------------------
  // Build the visible row list (for rendering).
  // --------------------------------------------------------------------------
  const visibleRows = useMemo(() => {
    const out: { index: number; row: Record<string, unknown> | null }[] = [];
    for (let i = renderStart; i < renderEnd; i++) {
      out.push({ index: i, row: lookupRow(i) });
    }
    return out;
  }, [renderStart, renderEnd, lookupRow]);

  // --------------------------------------------------------------------------
  // Collapsed view (collapsible mode)
  // --------------------------------------------------------------------------
  if (isCollapsible && !isExpanded) {
    return (
      <div className="results-container collapsed" onClick={onToggleExpand}>
        <div className="query-header collapsed">
          <span className="query-expand-icon">▶</span>
          {statementLabel && (
            <span className="query-label">{statementLabel}</span>
          )}
          <code className="query-sql">
            <SqlPreview sql={sql} />
          </code>
          <span className="query-meta">
            {hasResults ? (
              <span className="query-rows">
                {totalRows.toLocaleString()} rows
              </span>
            ) : (
              <span className="query-success">✓ success</span>
            )}
            <span className="query-time">{executionTime.toFixed(1)}ms</span>
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`results-container ${isCollapsible ? "collapsible" : ""} ${!hasResults ? "no-results" : ""}`}
    >
      <Toast message={toast.message} />

      {expandedCell && (
        <CellExpansionModal
          value={expandedCell.value}
          column={expandedCell.column}
          columnType={expandedCell.columnType}
          canEdit={editable && expandedCell.rowId !== null}
          isSaving={cellSave !== null}
          saveError={cellSaveError}
          onClose={() => {
            if (cellSave) return; // don't close while a save is in flight
            setExpandedCell(null);
            setCellSaveError(null);
          }}
          onCopy={(text) => copyToClipboard(text, 'cell')}
          onSave={handleCellSave}
        />
      )}

      {showColumnsPanel && (
        <ColumnsPanel
          columns={columns}
          onClose={() => {
            setShowColumnsPanel(false);
            setInitialExpandedColumn(null);
          }}
          onRequestStats={requestColumnStats}
          columnStats={columnStatsMap}
          loadingStats={loadingStatsColumn}
          statsError={statsError}
          width={columnsPanelWidth}
          onResize={setColumnsPanelWidth}
          initialExpandedColumn={initialExpandedColumn}
          columnSummaries={columnSummaries}
          loadingSummaries={loadingSummaries}
        />
      )}

      {showSqlModal && (
        <SqlModal
          sql={sql}
          filteredSql={fullSql !== sql ? fullSql : undefined}
          onClose={() => setShowSqlModal(false)}
          onCopy={(text) => copyToClipboard(text, 'SQL')}
          onOpenInEditor={handleOpenInEditor}
        />
      )}

      {/* Query header */}
      <div className="query-header">
        {isCollapsible && (
          <span
            className="query-expand-icon"
            onClick={onToggleExpand}
            title="Collapse"
          >
            ▼
          </span>
        )}
        {statementLabel && (
          <span className="query-label">{statementLabel}</span>
        )}
        <code
          className="query-sql"
          onClick={() => setShowSqlModal(true)}
          title="Click to view full SQL"
        >
          <SqlPreview sql={sql} />
        </code>
        <span className="query-meta">
          {hasResults ? (
            <span className="query-rows">
              {totalRows.toLocaleString()} rows
            </span>
          ) : (
            <span className="query-success">✓ success</span>
          )}
          <span className="query-time">{executionTime.toFixed(1)}ms</span>
          <button
            className={`refresh-btn ${isRefreshing ? 'refreshing' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              handleRefresh();
            }}
            disabled={isRefreshing}
            title="Re-run original query"
          >
            <RefreshCw size={13} />
          </button>
        </span>
      </div>

      {/* Stats bar */}
      {hasResults && (
        <div className="stats-bar">
          <div className="stat">
            <span className="stat-label">rows</span>
            <span className="stat-value">
              {filteredRowCount < totalRows ? (
                <>
                  {filteredRowCount.toLocaleString()}{" "}
                  <span className="stat-total">
                    / {totalRows.toLocaleString()}
                  </span>
                </>
              ) : (
                totalRows.toLocaleString()
              )}
            </span>
          </div>
          <button
            className={`stat stat-clickable ${showColumnsPanel ? 'active' : ''}`}
            onClick={() => {
              const newShow = !showColumnsPanel;
              setShowColumnsPanel(newShow);
              if (newShow && !summariesLoaded) requestColumnSummaries();
            }}
            title="Toggle columns panel"
          >
            <span className="stat-label">cols</span>
            <span className="stat-value">{columns.length}</span>
          </button>
          {sort.column && (
            <div className="stat">
              <span className="stat-label">sort</span>
              <span className="stat-value">
                {sort.column} {sort.direction === "asc" ? "↑" : "↓"}
              </span>
            </div>
          )}
          {selectionInfo && (
            <div className="stat">
              <span className="stat-label">selected</span>
              <span className="stat-value">{selectionInfo}</span>
            </div>
          )}
        </div>
      )}

      {/* Filter bar */}
      {hasResults && totalRows > 0 && (
        <FilterBar
          filterState={filterState}
          onRemoveFilter={handleRemoveFilter}
          onClearAll={handleClearFilters}
          onTogglePause={handleTogglePause}
          onAddFilter={() => {
            if (leaves.length > 0 && tableWrapperRef.current) {
              const firstHeader = tableWrapperRef.current.querySelector(
                "th:not(.row-number-header):not(.group-header)",
              );
              if (firstHeader) {
                const rect = firstHeader.getBoundingClientRect();
                const tableRect =
                  tableWrapperRef.current.getBoundingClientRect();
                const firstLeaf = leaves[0];
                setFilterPopover({
                  column: columnRefLabel(firstLeaf.path),
                  columnPath: firstLeaf.path,
                  columnType: firstLeaf.type,
                  position: {
                    top: rect.bottom - tableRect.top + 4,
                    left: rect.left - tableRect.left,
                  },
                });
                setLoadingDistinct(true);
                getVscodeApi()?.postMessage({
                  type: "requestDistinctValues",
                  cacheId,
                  column: firstLeaf.path,
                });
              }
            }
          }}
        />
      )}

      {/* Results table or empty state */}
      {!hasResults ? (
        <div className="empty-state">
          <span className="empty-icon">✓</span>
          <span>Statement executed successfully</span>
        </div>
      ) : filteredRowCount === 0 ? (
        <div className="empty-results">
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <RowNumberHeader
                    width={rowNumberWidth}
                    onResize={handleRowNumberResize}
                  />
                  {columns.map((col, idx) => (
                    <th key={idx}>
                      <div className="th-content">
                        <span className="col-name">{col}</span>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td
                    colSpan={columns.length + 1}
                    className="empty-row-message"
                  >
                    {totalRows === 0
                      ? "0 rows returned"
                      : "0 rows match the current filters"}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="table-wrapper" ref={tableWrapperRef} tabIndex={0}>
          {filterPopover && (
            <ColumnFilterPopover
              column={filterPopover.column}
              columnPath={filterPopover.columnPath}
              columnType={filterPopover.columnType}
              columns={leaves.map((leaf) => ({
                name: columnRefLabel(leaf.path),
                path: leaf.path,
                type: leaf.type,
              }))}
              distinctValues={distinctValues}
              cardinality={columnCardinality}
              isLoading={loadingDistinct}
              onClose={() => setFilterPopover(null)}
              onApply={handleAddFilter}
              onColumnChange={(newCol, newType, newPath) => {
                setFilterPopover((prev) =>
                  prev
                    ? {
                        ...prev,
                        column: newCol,
                        columnPath: newPath,
                        columnType: newType,
                      }
                    : null,
                );
                setDistinctValues([]);
                setColumnCardinality(0);
                setLoadingDistinct(true);
                getVscodeApi()?.postMessage({
                  type: "requestDistinctValues",
                  cacheId,
                  column: newPath,
                });
              }}
              position={filterPopover.position}
            />
          )}

          <table>
            <thead ref={headerRowRef}>
              {nested.headerRows.map((rowCells, rowIdx) => (
                <tr key={rowIdx}>
                  {rowIdx === 0 && (
                    <RowNumberHeader
                      width={rowNumberWidth}
                      onResize={handleRowNumberResize}
                      rowSpan={nested.headerDepth}
                    />
                  )}
                  {rowCells.map((cell: HeaderCell) => {
                    if (cell.isGroup) {
                      return (
                        <th
                          key={cell.key}
                          colSpan={cell.colSpan}
                          className="group-header"
                          title={cell.type}
                        >
                          <div className="th-content group-header-content">
                            <span className="col-name">{cell.label}</span>
                          </div>
                        </th>
                      );
                    }
                    const leaf = leaves[cell.leafIndex];
                    // Dotted label ("s.x") identifies the leaf in sort /
                    // stats state; leaf.path is what the host turns into SQL.
                    const label = columnRefLabel(leaf.path);
                    const hasFilter = filterState.filters.some(
                      (f) => columnRefLabel(f.column) === label,
                    );
                    const leafIdx = cell.leafIndex;
                    return (
                      <ResizableHeader
                        key={cell.key}
                        column={leaf.label}
                        rowSpan={cell.rowSpan}
                        width={columnWidths[leaf.key]}
                        isSorted={sort.column === label}
                        sortDirection={
                          sort.column === label ? sort.direction : null
                        }
                        isSelected={isColumnSelected(leafIdx)}
                        hasFilter={hasFilter}
                        copyText={label}
                        onSort={() => handleSort(label, leaf.path)}
                        onResize={(width) =>
                          handleColumnResize(leaf.key, width)
                        }
                        onSelect={(e) => handleColumnSelect(leafIdx, e)}
                        onOpenStats={() => openColumnStats(label, leaf.path)}
                        onOpenFilter={(e) =>
                          handleOpenFilterPopover(
                            label,
                            leaf.path,
                            leaf.type,
                            e,
                          )
                        }
                      />
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {topSpacerHeight > 0 && (
                <tr aria-hidden className="virt-spacer">
                  <td
                    colSpan={leaves.length + 1}
                    style={{ height: topSpacerHeight }}
                  />
                </tr>
              )}
              {visibleRows.map(({ index, row }, sliceIdx) => {
                const isFirst = sliceIdx === 0;
                const rowSel = isRowSelected(index);
                if (!row) {
                  return (
                    <tr
                      key={index}
                      ref={isFirst ? firstRenderedRowRef : null}
                      className="virt-row virt-row-loading"
                    >
                      <td className="row-number" style={rowNumberStyle}>
                        {(index + 1).toLocaleString()}
                      </td>
                      {leaves.map((leaf) => (
                        <td key={leaf.key} className="cell-loading">
                          <span className="cell-skeleton" />
                        </td>
                      ))}
                    </tr>
                  );
                }
                return (
                  <tr
                    key={index}
                    ref={isFirst ? firstRenderedRowRef : null}
                    className={`virt-row ${rowSel ? 'row-selected' : ''}`}
                  >
                    <td
                      className="row-number"
                      style={rowNumberStyle}
                      onClick={(e) => handleRowSelect(index, e)}
                    >
                      {(index + 1).toLocaleString()}
                    </td>
                    {leaves.map((leaf, leafIdx) => (
                      <td
                        key={leaf.key}
                        className={
                          isCellSelected(index, leafIdx) ? "selected" : ""
                        }
                        style={
                          columnWidths[leaf.key]
                            ? {
                                width: columnWidths[leaf.key],
                                minWidth: columnWidths[leaf.key],
                                maxWidth: columnWidths[leaf.key],
                              }
                            : undefined
                        }
                        onClick={(e) => handleCellClick(index, leafIdx, e)}
                        onDoubleClick={() =>
                          handleCellDoubleClick(index, leafIdx)
                        }
                      >
                        <CellValue
                          value={
                            leaf.isNested
                              ? getValueAtPath(row, leaf.path)
                              : row[leaf.path[0]]
                          }
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
              {bottomSpacerHeight > 0 && (
                <tr aria-hidden className="virt-spacer">
                  <td
                    colSpan={leaves.length + 1}
                    style={{ height: bottomSpacerHeight }}
                  />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer (no pagination — infinite virtualized scroll) */}
      {hasResults && filteredRowCount > 0 && (
        <div className="results-footer">
          <div className="footer-actions">
            <IconButton
              icon={<Copy size={14} />}
              tooltip={`Copy table (up to ${maxCopyRows.toLocaleString()} rows)`}
              onClick={copyFullTable}
              disabled={copyLoading}
              tooltipPosition="top"
            />
            <PopoverMenu
              trigger={
                <IconButton
                  icon={<Download size={14} />}
                  tooltip="Export to file"
                >
                  <ChevronDown size={12} />
                </IconButton>
              }
            >
              <button onClick={() => handleExport('csv')}>CSV</button>
              <button onClick={() => handleExport('parquet')}>Parquet</button>
              <button onClick={() => handleExport('json')}>JSON</button>
              <button onClick={() => handleExport('jsonl')}>JSONL</button>
            </PopoverMenu>
            <PopoverMenu
              trigger={
                <IconButton
                  icon={<ExternalLink size={14} />}
                  tooltip={`Open in new tab (up to ${maxCopyRows.toLocaleString()} rows)`}
                >
                  <ChevronDown size={12} />
                </IconButton>
              }
            >
              <button onClick={() => handleExport('csv-tab')}>CSV</button>
              <button onClick={() => handleExport('json-tab')}>JSON</button>
            </PopoverMenu>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// HELPER COMPONENTS
// ============================================================================

/**
 * Resize-handle drag logic shared by ResizableHeader and RowNumberHeader.
 * Returns the mousedown handler to wire on the handle element.
 */
function useResizeHandle(
  thRef: React.RefObject<HTMLTableCellElement | null>,
  onResize: (width: number) => void,
  onResizingChange?: (resizing: boolean) => void
) {
  return useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = thRef.current?.offsetWidth || 100;
      const handleMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        onResize(startWidth + delta);
      };
      const handleMouseUp = () => {
        onResizingChange?.(false);
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      onResizingChange?.(true);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [thRef, onResize, onResizingChange]
  );
}

interface RowNumberHeaderProps {
  width: number;
  onResize: (width: number) => void;
  rowSpan?: number;
}

function RowNumberHeader({
  width,
  onResize,
  rowSpan = 1,
}: RowNumberHeaderProps) {
  const thRef = useRef<HTMLTableCellElement>(null);
  const handleMouseDown = useResizeHandle(thRef, onResize);
  return (
    <th
      ref={thRef}
      className="row-number-header"
      rowSpan={rowSpan}
      style={{ width, minWidth: width, maxWidth: width }}
    >
      #
      <div className="resize-handle" onMouseDown={handleMouseDown} />
    </th>
  );
}

interface ResizableHeaderProps {
  column: string;
  width: number | undefined;
  isSorted: boolean;
  sortDirection: 'asc' | 'desc' | null;
  isSelected: boolean;
  hasFilter?: boolean;
  /** Rows this header cell spans in a grouped (nested-column) header. */
  rowSpan?: number;
  /** Text copied by the header copy button; defaults to the column label. */
  copyText?: string;
  /** Omitted for nested sub-columns (server-side sort needs a top-level column). */
  onSort?: () => void;
  onResize: (width: number) => void;
  onSelect: (e: React.MouseEvent) => void;
  /** Omitted for nested sub-columns (stats run on top-level columns). */
  onOpenStats?: () => void;
  onOpenFilter?: (e: React.MouseEvent) => void;
}

function ResizableHeader({
  column,
  width,
  isSorted,
  sortDirection,
  isSelected,
  hasFilter,
  rowSpan = 1,
  copyText,
  onSort,
  onResize,
  onSelect,
  onOpenStats,
  onOpenFilter,
}: ResizableHeaderProps) {
  const thRef = useRef<HTMLTableCellElement>(null);
  const [isResizing, setIsResizing] = useState(false);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = thRef.current?.offsetWidth || 100;
      const handleMouseMove = (e: MouseEvent) => {
        const delta = e.clientX - startX;
        onResize(startWidth + delta);
      };
      const handleMouseUp = () => {
        setIsResizing(false);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      setIsResizing(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [onResize],
  );

  return (
    <th
      ref={thRef}
      rowSpan={rowSpan}
      className={`${isSorted ? 'sorted' : ''} ${isResizing ? 'resizing' : ''} ${isSelected ? 'col-selected' : ''} ${hasFilter ? 'has-filter' : ''}`}
      style={width ? { width, minWidth: width, maxWidth: width } : undefined}
    >
      <div className="th-content">
        <span className="col-name" onClick={onSelect}>
          {column}
        </span>
        <div className="th-actions">
          <CopyButton
            text={copyText ?? column}
            title={`Copy "${copyText ?? column}"`}
            className="th-copy-btn"
            size={12}
          />
          {onOpenFilter && (
            <button
              className={`header-icon-btn filter-btn ${hasFilter ? 'active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                onOpenFilter(e);
              }}
              title={`Filter by ${column}`}
            >
              <Filter size={12} />
            </button>
          )}
          {onOpenStats && (
            <button
              className="header-icon-btn stats-btn"
              onClick={(e) => {
                e.stopPropagation();
                onOpenStats();
              }}
              title={`View stats for ${column}`}
            >
              <BarChart2 size={12} />
            </button>
          )}
          {onSort && (
            <button
              className={`header-icon-btn sort-btn ${isSorted ? "active" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                onSort();
              }}
              title={`Sort by ${column}`}
            >
              {isSorted ? (
                sortDirection === "asc" ? (
                  <ArrowUp size={12} />
                ) : (
                  <ArrowDown size={12} />
                )
              ) : (
                <ChevronsUpDown size={12} />
              )}
            </button>
          )}
        </div>
      </div>
      <div className="resize-handle" onMouseDown={handleMouseDown} />
    </th>
  );
}

// Cell Expansion Modal
interface CellExpansionModalProps {
  value: unknown;
  column: string;
  columnType?: string;
  /** When true, the modal becomes an editor with a Save button. */
  canEdit?: boolean;
  /** True while the host is processing the save (Save button shows a spinner). */
  isSaving?: boolean;
  /** Last save error from the host; cleared by editing the value again. */
  saveError?: string | null;
  onClose: () => void;
  onCopy: (text: string) => void;
  /** Persist the new value. `null` represents NULL (empty input). */
  onSave?: (newValue: string | null) => void;
}

function CellExpansionModal({
  value,
  column,
  columnType,
  canEdit = false,
  isSaving = false,
  saveError = null,
  onClose,
  onCopy,
  onSave,
}: CellExpansionModalProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // The original value rendered as a string. NULL is shown as the empty
  // string while editing (so the user can clear a cell to NULL by emptying
  // it and saving), but as the literal "NULL" when read-only.
  const isNull = value === null || value === undefined;
  const isJson = typeof value === 'object' && value !== null;

  const displayText = useMemo(() => {
    if (isNull) return 'NULL';
    if (isJson) {
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }, [value, isNull, isJson]);

  const initialDraft = useMemo(() => {
    if (isNull) return '';
    if (isJson) {
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }, [value, isNull, isJson]);

  const [draft, setDraft] = useState(initialDraft);
  // Reset the draft when the underlying cell changes (e.g., user opens a different cell).
  useEffect(() => {
    setDraft(initialDraft);
  }, [initialDraft]);

  // Complex types (LIST, STRUCT, MAP) — TRY_CAST won't reliably reverse the
  // JSON representation, so editing them in v1 is opt-out.
  const isComplexType =
    !!columnType && /^(LIST|STRUCT|MAP|UNION)/i.test(columnType.trim());
  const editable = canEdit && !!onSave && !isComplexType;
  const isDirty = editable && draft !== initialDraft;

  useEffect(() => {
    if (!isJson) {
      textareaRef.current?.focus();
      if (!editable) textareaRef.current?.select();
    }
  }, [isJson, editable]);

  const handleSave = useCallback(() => {
    if (!editable || !onSave || !isDirty || isSaving) return;
    // Empty draft => NULL; otherwise pass the raw string for server-side cast.
    onSave(draft === '' ? null : draft);
  }, [editable, onSave, isDirty, isSaving, draft]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (editable && (e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSave();
      }
    },
    [editable, handleSave],
  );

  const title = (
    <>
      <span className="modal-column">{column}</span>
      {columnType && <span className="modal-type">{columnType}</span>}
    </>
  );

  const hint = isSaving
    ? 'Saving…'
    : !editable && canEdit && isComplexType
      ? `Editing ${columnType ?? "complex"} cells is not supported yet — read-only.`
      : !canEdit
        ? "Read-only — file format does not support write-back, or this is a derived/limited result."
        : "Edit and press ⌘↵ to save · Esc to close";

  // Custom modal action: Save button (only when editable).
  const actions = editable
    ? [
        {
          icon: isSaving ? (
            <span className="cell-modal-spinner" />
          ) : (
            <Save size={14} />
          ),
          label: isSaving ? "Saving…" : isDirty ? "Save (⌘↵)" : "Save",
          onClick: handleSave,
        },
      ]
    : undefined;

  return (
    <Modal
      title={title}
      onClose={onClose}
      onCopy={() => onCopy(editable ? draft : displayText)}
      hint={hint}
      size={`${(editable ? draft : displayText).length.toLocaleString()} chars`}
      actions={actions}
    >
      {editable ? (
        <textarea
          ref={textareaRef}
          className="modal-content modal-cell-editor"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          disabled={isSaving}
          placeholder="(empty = NULL)"
        />
      ) : isJson ? (
        <pre className="modal-content modal-json">
          <JsonSyntaxHighlight json={displayText} />
        </pre>
      ) : (
        <textarea
          ref={textareaRef}
          className="modal-content"
          value={displayText}
          readOnly
          spellCheck={false}
        />
      )}
      {saveError && (
        <div className="cell-modal-error">
          <span className="cell-modal-error-icon">⚠</span>
          <span>{saveError}</span>
        </div>
      )}
    </Modal>
  );
}
