import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import type { ColumnStats, StatementCacheMeta, PageData } from './types';
import { ColumnsPanel } from './ColumnsPanel';
import { Modal } from './ui/Modal';
import { JsonSyntaxHighlight } from './ui/JsonHighlight';
import { CellValue } from './ui/CellValue';
import { SqlSyntaxHighlight, SqlPreview } from './ui/SqlHighlight';
import { 
  FilterBar, 
  FilterState, 
  ColumnFilter, 
  createInitialFilterState, 
  filtersToWhereClause,
  generateFilterId 
} from './ui/FilterBar';
import { ColumnFilterPopover } from './ui/ColumnFilterPopover';
import { formatValue, formatTableAsText } from './utils/format';
import { Copy, Download, ExternalLink, ChevronDown, Filter, Code, BarChart2, ArrowUp, ArrowDown, ChevronsUpDown, RefreshCw } from 'lucide-react';
import './styles.css';

// Get VS Code API (exposed globally from index.tsx)
function getVscodeApi() {
  return (window as unknown as { vscodeApi: { postMessage: (msg: unknown) => void } }).vscodeApi;
}

// ============================================================================
// RESULTS TABLE - Display component for a single statement's results
// ============================================================================

export interface ResultsTableProps {
  meta: StatementCacheMeta;
  initialPage: PageData;
  pageSize: number;
  maxCopyRows: number;
  hasResults?: boolean;
  statementIndex?: number;
  totalStatements?: number;
  // Collapsible mode props
  isCollapsible?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}

export function ResultsTable({
  meta,
  initialPage,
  pageSize,
  maxCopyRows,
  hasResults = true,
  statementIndex,
  totalStatements,
  isCollapsible = false,
  isExpanded = true,
  onToggleExpand,
}: ResultsTableProps) {
  const { cacheId, sql, columns, totalRows, executionTime } = meta;
  
  // Current page data
  const [currentPage, setCurrentPage] = useState<PageData>(initialPage);
  const [isLoadingPage, setIsLoadingPage] = useState(false);
  
  // Sorting state (server-side)
  type SortDirection = 'asc' | 'desc' | null;
  const [sort, setSort] = useState<{ column: string | null; direction: SortDirection }>({ 
    column: initialPage.sortColumn || null, 
    direction: initialPage.sortDirection || null 
  });
  
  // SQL modal state
  const [showSqlModal, setShowSqlModal] = useState(false);
  const [showFullSqlModal, setShowFullSqlModal] = useState(false);
  
  // Column widths state
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  
  // Selection state
  interface CellPosition { row: number; col: number; }
  interface Selection { start: CellPosition; end: CellPosition; }
  const [selection, setSelection] = useState<Selection | null>(null);
  
  // Toast message
  const [toast, setToast] = useState<string | null>(null);
  
  // Cell expansion modal
  const [expandedCell, setExpandedCell] = useState<{ value: unknown; column: string } | null>(null);
  
  // Dropdown menus
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showOpenMenu, setShowOpenMenu] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const openMenuRef = useRef<HTMLDivElement>(null);
  
  // Columns panel - default to 35% of window width, min 320, max 800
  const [showColumnsPanel, setShowColumnsPanel] = useState(false);
  const [columnsPanelWidth, setColumnsPanelWidth] = useState(() => {
    const maxWidth = Math.min(800, Math.floor(window.innerWidth * 0.5));
    return Math.max(320, Math.min(maxWidth, Math.floor(window.innerWidth * 0.35)));
  });
  const [initialExpandedColumn, setInitialExpandedColumn] = useState<string | null>(null);
  const [columnStatsMap, setColumnStatsMap] = useState<Record<string, ColumnStats | null>>({});
  const [loadingStatsColumn, setLoadingStatsColumn] = useState<string | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  
  // Column summaries (from server via SUMMARIZE)
  const [columnSummaries, setColumnSummaries] = useState<Array<{name: string; distinctCount: number; nullPercent: number; inferredType: string}>>([]);
  const [loadingSummaries, setLoadingSummaries] = useState(false);
  const [summariesLoaded, setSummariesLoaded] = useState(false);
  
  // Filter state
  const [filterState, setFilterState] = useState<FilterState>(createInitialFilterState());
  const [filteredRowCount, setFilteredRowCount] = useState<number>(totalRows);
  const [filterPopover, setFilterPopover] = useState<{
    column: string;
    columnType: string;
    position: { top: number; left: number };
  } | null>(null);
  const [distinctValues, setDistinctValues] = useState<{ value: string; count: number }[]>([]);
  const [columnCardinality, setColumnCardinality] = useState<number>(0);
  const [loadingDistinct, setLoadingDistinct] = useState(false);
  
  // Copy loading state
  const [copyLoading, setCopyLoading] = useState(false);
  
  // Refresh state
  const [isRefreshing, setIsRefreshing] = useState(false);
  
  // Table wrapper ref
  const tableWrapperRef = useRef<HTMLDivElement>(null);

  // Reset state when switching statements (cacheId changes)
  useEffect(() => {
    // Reset column stats
    setColumnStatsMap({});
    setColumnSummaries([]);
    setSummariesLoaded(false);
    setLoadingStatsColumn(null);
    setStatsError(null);
    setShowColumnsPanel(false);
    setInitialExpandedColumn(null);
    // Reset filters - old filters won't apply to new query columns
    setFilterState(createInitialFilterState());
    setFilteredRowCount(totalRows);
    setDistinctValues([]);
    setColumnCardinality(0);
    setFilterPopover(null);
    // Reset refresh state
    setIsRefreshing(false);
  }, [cacheId]);

  // Pagination helpers
  const currentOffset = currentPage.offset;
  const currentPageNum = Math.floor(currentOffset / pageSize) + 1;
  const totalPages = Math.ceil(totalRows / pageSize);
  const displayRows = currentPage.rows;

  // Update page when initialPage changes (new query)
  useEffect(() => {
    setCurrentPage(initialPage);
    setSort({ 
      column: initialPage.sortColumn || null, 
      direction: initialPage.sortDirection || null 
    });
    setSelection(null);
  }, [initialPage]);

  // Listen for page data and other messages
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === 'pageData' && message.data?.cacheId === cacheId) {
        setCurrentPage(message.data);
        setFilteredRowCount(message.data.totalRows);
        setIsLoadingPage(false);
        setSelection(null);
      } else if (message.type === 'columnStats' && message.cacheId === cacheId) {
        if (message.data) {
          setColumnStatsMap(prev => ({
            ...prev,
            [message.data.column]: message.data
          }));
        }
        setStatsError(message.error || null);
        setLoadingStatsColumn(null);
      } else if (message.type === 'columnSummaries' && message.cacheId === cacheId) {
        if (message.data) {
          setColumnSummaries(message.data);
        }
        setLoadingSummaries(false);
        setSummariesLoaded(true);
      } else if (message.type === 'distinctValues' && message.cacheId === cacheId) {
        setDistinctValues(message.data || []);
        setColumnCardinality(message.cardinality || 0);
        setLoadingDistinct(false);
      } else if (message.type === 'filterError' && message.cacheId === cacheId) {
        setToast(message.error || 'Filter error');
        setIsLoadingPage(false);
      } else if (message.type === 'copyData') {
        setCopyLoading(false);
        if (message.error) {
          setToast('Copy failed');
        } else if (message.data) {
          const { columns: copyColumns, rows: copyRows, maxCopyRows: limit } = message.data;
          const text = formatTableAsText(copyColumns, copyRows);
          navigator.clipboard.writeText(text).then(() => {
            const rowCount = copyRows.length;
            const label = rowCount >= limit 
              ? `${rowCount.toLocaleString()} rows (limit)` 
              : `${rowCount.toLocaleString()} rows`;
            setToast(`Copied ${label}`);
          }).catch(() => {
            setToast('Failed to copy');
          });
        }
      } else if (message.type === 'refreshError') {
        setIsRefreshing(false);
        setToast(message.error || 'Refresh failed');
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [cacheId]);

  // Compute active where clause
  const getActiveWhereClause = useCallback((): string => {
    if (filterState.isPaused) return '';
    return filtersToWhereClause(filterState.filters);
  }, [filterState]);

  // Request a page from the server
  const requestPage = useCallback((offset: number, sortColumn?: string | null, sortDirection?: SortDirection, whereClause?: string) => {
    if (!cacheId) return;
    
    setIsLoadingPage(true);
    const vscode = getVscodeApi();
    if (vscode) {
      vscode.postMessage({ 
        type: 'requestPage', 
        cacheId, 
        offset,
        sortColumn: sortColumn || undefined,
        sortDirection: sortDirection || undefined,
        whereClause: whereClause ?? getActiveWhereClause(),
      });
    }
  }, [cacheId, getActiveWhereClause]);

  // Handle page navigation
  const goToPage = useCallback((pageNum: number) => {
    const newOffset = (pageNum - 1) * pageSize;
    requestPage(newOffset, sort.column, sort.direction);
  }, [pageSize, requestPage, sort]);

  // Filter handlers
  const applyFilters = useCallback((newFilters: ColumnFilter[]) => {
    const clause = filtersToWhereClause(newFilters);
    requestPage(0, sort.column, sort.direction, clause);
  }, [requestPage, sort]);

  const handleAddFilter = useCallback((filter: ColumnFilter) => {
    const newFilters = [...filterState.filters, filter];
    setFilterState(prev => ({ ...prev, filters: newFilters }));
    applyFilters(newFilters);
    setFilterPopover(null);
  }, [filterState.filters, applyFilters]);

  const handleRemoveFilter = useCallback((filterId: string) => {
    const newFilters = filterState.filters.filter(f => f.id !== filterId);
    setFilterState(prev => ({ ...prev, filters: newFilters }));
    applyFilters(newFilters);
  }, [filterState.filters, applyFilters]);

  const handleClearFilters = useCallback(() => {
    setFilterState(createInitialFilterState());
    requestPage(0, sort.column, sort.direction, '');
  }, [requestPage, sort]);

  const handleTogglePause = useCallback(() => {
    setFilterState(prev => {
      const newPaused = !prev.isPaused;
      // Re-fetch with or without filters using latest state
      const clause = newPaused ? '' : filtersToWhereClause(prev.filters);
      requestPage(0, sort.column, sort.direction, clause);
      return { ...prev, isPaused: newPaused };
    });
  }, [requestPage, sort]);

  const handleOpenFilterPopover = useCallback((column: string, columnType: string, event: React.MouseEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const tableRect = tableWrapperRef.current?.getBoundingClientRect();
    
    setFilterPopover({
      column,
      columnType,
      position: {
        top: rect.bottom - (tableRect?.top || 0) + 4,
        left: rect.left - (tableRect?.left || 0),
      },
    });
    
    // Request distinct values
    setLoadingDistinct(true);
    const vscode = getVscodeApi();
    if (vscode) {
      vscode.postMessage({ type: 'requestDistinctValues', cacheId, column });
    }
  }, [cacheId]);

  // Close menus when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
      if (openMenuRef.current && !openMenuRef.current.contains(e.target as Node)) {
        setShowOpenMenu(false);
      }
    };
    if (showExportMenu || showOpenMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showExportMenu, showOpenMenu]);

  // Handle export/open request
  const handleExport = useCallback((format: 'csv' | 'parquet' | 'json' | 'jsonl' | 'csv-tab' | 'json-tab') => {
    setShowExportMenu(false);
    setShowOpenMenu(false);
    const vscode = getVscodeApi();
    if (vscode) {
      vscode.postMessage({ type: 'export', cacheId, format });
    }
  }, [cacheId]);

  // Request column summaries from extension (uses SUMMARIZE)
  const requestColumnSummaries = useCallback(() => {
    if (!cacheId || summariesLoaded) return;
    
    setLoadingSummaries(true);
    const vscode = getVscodeApi();
    if (vscode) {
      vscode.postMessage({ type: 'requestColumnSummaries', cacheId });
    } else {
      setLoadingSummaries(false);
    }
  }, [cacheId, summariesLoaded]);

  // Get the active where clause for filtered stats
  const activeWhereClause = useMemo(() => {
    if (filterState.isPaused || filterState.filters.length === 0) return undefined;
    return filtersToWhereClause(filterState.filters);
  }, [filterState]);

  // Clear column stats cache when filters change (stats need to be re-computed with new filter)
  useEffect(() => {
    setColumnStatsMap({});
  }, [activeWhereClause]);

  // Request column stats from extension
  const requestColumnStats = useCallback((columnName: string) => {
    if (!cacheId) return;
    
    setLoadingStatsColumn(columnName);
    setStatsError(null);
    const vscode = getVscodeApi();
    if (vscode) {
      vscode.postMessage({ 
        type: 'requestColumnStats', 
        cacheId, 
        column: columnName,
        whereClause: activeWhereClause,
      });
    } else {
      setLoadingStatsColumn(null);
      setStatsError('VS Code API not available');
    }
  }, [cacheId, activeWhereClause]);

  // Toggle columns panel for a specific column
  const openColumnStats = useCallback((columnName: string) => {
    if (showColumnsPanel && initialExpandedColumn === columnName) {
      setShowColumnsPanel(false);
      setInitialExpandedColumn(null);
    } else {
      setInitialExpandedColumn(columnName);
      setShowColumnsPanel(true);
      // Request summaries if not loaded yet
      if (!summariesLoaded) {
        requestColumnSummaries();
      }
      requestColumnStats(columnName);
    }
  }, [showColumnsPanel, initialExpandedColumn, requestColumnStats, summariesLoaded, requestColumnSummaries]);

  // Handle column header click for sorting (server-side)
  const handleSort = useCallback((column: string) => {
    let newSort: { column: string | null; direction: SortDirection };
    
    if (sort.column !== column) {
      newSort = { column, direction: 'asc' };
    } else if (sort.direction === 'asc') {
      newSort = { column, direction: 'desc' };
    } else {
      newSort = { column: null, direction: null };
    }
    
    setSort(newSort);
    // Request first page with new sort
    requestPage(0, newSort.column, newSort.direction);
  }, [sort, requestPage]);

  // Handle column resize
  const handleColumnResize = useCallback((column: string, width: number) => {
    setColumnWidths(prev => ({ ...prev, [column]: Math.max(50, width) }));
  }, []);

  // Show toast notification
  const showToast = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2000);
  }, []);

  // Copy to clipboard (for current page selection)
  const copyToClipboard = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`Copied ${label}`);
    } catch {
      showToast('Failed to copy');
    }
  }, [showToast]);

  // Copy full table from server (up to maxCopyRows)
  const copyFullTable = useCallback(() => {
    if (!cacheId || copyLoading) return;
    setCopyLoading(true);
    const vscode = getVscodeApi();
    if (vscode) {
      vscode.postMessage({ type: 'requestCopyData', cacheId });
    } else {
      setCopyLoading(false);
    }
  }, [cacheId, copyLoading]);

  // Handle refresh - re-execute original query
  const handleRefresh = useCallback(() => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    const vscode = getVscodeApi();
    if (vscode) {
      vscode.postMessage({ type: 'refreshQuery' });
    } else {
      setIsRefreshing(false);
    }
  }, [isRefreshing]);

  // Selection helpers (work on current page)
  const isCellSelected = useCallback((rowIdx: number, colIdx: number): boolean => {
    if (!selection) return false;
    const minRow = Math.min(selection.start.row, selection.end.row);
    const maxRow = Math.max(selection.start.row, selection.end.row);
    const minCol = Math.min(selection.start.col, selection.end.col);
    const maxCol = Math.max(selection.start.col, selection.end.col);
    return rowIdx >= minRow && rowIdx <= maxRow && colIdx >= minCol && colIdx <= maxCol;
  }, [selection]);

  const isRowSelected = useCallback((rowIdx: number): boolean => {
    if (!selection) return false;
    const minRow = Math.min(selection.start.row, selection.end.row);
    const maxRow = Math.max(selection.start.row, selection.end.row);
    const minCol = Math.min(selection.start.col, selection.end.col);
    const maxCol = Math.max(selection.start.col, selection.end.col);
    return rowIdx >= minRow && rowIdx <= maxRow && minCol === 0 && maxCol === columns.length - 1;
  }, [selection, columns.length]);

  const isColumnSelected = useCallback((colIdx: number): boolean => {
    if (!selection) return false;
    const minRow = Math.min(selection.start.row, selection.end.row);
    const maxRow = Math.max(selection.start.row, selection.end.row);
    const minCol = Math.min(selection.start.col, selection.end.col);
    const maxCol = Math.max(selection.start.col, selection.end.col);
    return colIdx >= minCol && colIdx <= maxCol && minRow === 0 && maxRow === displayRows.length - 1;
  }, [selection, displayRows.length]);

  // Handle cell click
  const handleCellClick = useCallback((rowIdx: number, colIdx: number, e: React.MouseEvent) => {
    if (e.shiftKey && selection) {
      setSelection(prev => prev ? { start: prev.start, end: { row: rowIdx, col: colIdx } } : null);
    } else {
      const isSingleCellSelected = selection && 
        selection.start.row === selection.end.row && 
        selection.start.col === selection.end.col &&
        selection.start.row === rowIdx && 
        selection.start.col === colIdx;
      if (isSingleCellSelected) {
        setSelection(null);
      } else {
        setSelection({ start: { row: rowIdx, col: colIdx }, end: { row: rowIdx, col: colIdx } });
      }
    }
  }, [selection]);

  // Handle cell double-click
  const handleCellDoubleClick = useCallback((rowIdx: number, colIdx: number) => {
    const row = displayRows[rowIdx];
    const col = columns[colIdx];
    setExpandedCell({ value: row[col], column: col });
  }, [displayRows, columns]);

  // Handle row select
  const handleRowSelect = useCallback((rowIdx: number, e: React.MouseEvent) => {
    if (e.shiftKey && selection) {
      setSelection(prev => prev ? { start: { row: prev.start.row, col: 0 }, end: { row: rowIdx, col: columns.length - 1 } } : null);
    } else {
      setSelection({ start: { row: rowIdx, col: 0 }, end: { row: rowIdx, col: columns.length - 1 } });
    }
  }, [selection, columns.length]);

  // Handle column select
  const handleColumnSelect = useCallback((colIdx: number, e: React.MouseEvent) => {
    if (e.shiftKey && selection) {
      setSelection(prev => prev ? { start: { row: 0, col: prev.start.col }, end: { row: displayRows.length - 1, col: colIdx } } : null);
    } else {
      setSelection({ start: { row: 0, col: colIdx }, end: { row: displayRows.length - 1, col: colIdx } });
    }
  }, [selection, displayRows.length]);

  // Select all (current page)
  const selectAll = useCallback(() => {
    if (displayRows.length === 0) return;
    setSelection({ start: { row: 0, col: 0 }, end: { row: displayRows.length - 1, col: columns.length - 1 } });
  }, [displayRows.length, columns.length]);

  // Get selection as text (current page only)
  const getSelectionText = useCallback((): string => {
    if (!selection) return formatTableAsText(columns, displayRows);
    const minRow = Math.min(selection.start.row, selection.end.row);
    const maxRow = Math.max(selection.start.row, selection.end.row);
    const minCol = Math.min(selection.start.col, selection.end.col);
    const maxCol = Math.max(selection.start.col, selection.end.col);
    const selectedCols = columns.slice(minCol, maxCol + 1);
    const selectedRows = displayRows.slice(minRow, maxRow + 1);
    if (minRow === maxRow && minCol === maxCol) {
      const row = displayRows[minRow];
      return formatValue(row[columns[minCol]]);
    }
    return selectedRows.map(row => selectedCols.map(col => formatValue(row[col])).join('\t')).join('\n');
  }, [selection, columns, displayRows]);

  // Get selection label
  const getSelectionLabel = useCallback((): string => {
    if (!selection) return 'page';
    const minRow = Math.min(selection.start.row, selection.end.row);
    const maxRow = Math.max(selection.start.row, selection.end.row);
    const minCol = Math.min(selection.start.col, selection.end.col);
    const maxCol = Math.max(selection.start.col, selection.end.col);
    const rowCount = maxRow - minRow + 1;
    const colCount = maxCol - minCol + 1;
    if (rowCount === 1 && colCount === 1) return 'cell';
    if (colCount === columns.length) return `${rowCount} row${rowCount > 1 ? 's' : ''}`;
    return `${rowCount}×${colCount} cells`;
  }, [selection, columns.length]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!tableWrapperRef.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
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
      if (e.key === 'Escape') {
        setSelection(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [getSelectionText, getSelectionLabel, copyToClipboard, selectAll]);

  // Selection info
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

  // Build full SQL with original query, filters, and sort
  const fullSql = useMemo(() => {
    const whereClause = filtersToWhereClause(filterState.filters);
    const hasFilters = whereClause.length > 0 && !filterState.isPaused;
    const hasSort = sort.column !== null;
    
    // If no modifications, just return the original SQL
    if (!hasFilters && !hasSort) {
      return sql;
    }
    
    // Wrap original query and add modifications
    const parts: string[] = [];
    parts.push('SELECT * FROM (');
    parts.push('  ' + sql.trim().replace(/;?\s*$/, '').split('\n').join('\n  '));
    parts.push(') AS _query');
    
    if (hasFilters) {
      parts.push(`WHERE ${whereClause}`);
    }
    
    if (hasSort) {
      parts.push(`ORDER BY "${sort.column}" ${sort.direction?.toUpperCase() || 'ASC'}`);
    }
    
    return parts.join('\n');
  }, [sql, filterState, sort]);

  // Statement label for multi-statement
  const statementLabel = totalStatements !== undefined && statementIndex !== undefined 
    ? `Query ${statementIndex + 1} of ${totalStatements}`
    : null;

  // Row number offset for display
  const rowNumberOffset = currentOffset;

  // Collapsed view - same header structure, just clickable to expand
  if (isCollapsible && !isExpanded) {
    return (
      <div className="results-container collapsed" onClick={onToggleExpand}>
        <div className="query-header collapsed">
          <span className="query-expand-icon">▶</span>
          {statementLabel && <span className="query-label">{statementLabel}</span>}
          <code className="query-sql">
            <SqlPreview sql={sql} />
          </code>
          <span className="query-meta">
            {hasResults ? (
              <span className="query-rows">{totalRows.toLocaleString()} rows</span>
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
    <div className={`results-container ${isCollapsible ? 'collapsible' : ''} ${!hasResults ? 'no-results' : ''}`}>
      {/* Toast Notification */}
      {toast && <div className="toast">{toast}</div>}
      
      {/* Loading overlay */}
      {isLoadingPage && (
        <div className="loading-overlay">
          <span>Loading...</span>
        </div>
      )}
      
      {/* Cell Expansion Modal */}
      {expandedCell && (
        <CellExpansionModal
          value={expandedCell.value}
          column={expandedCell.column}
          onClose={() => setExpandedCell(null)}
          onCopy={(text) => copyToClipboard(text, 'cell')}
        />
      )}

      {/* Columns Panel */}
      {showColumnsPanel && (
        <ColumnsPanel
          columns={columns}
          onClose={() => { setShowColumnsPanel(false); setInitialExpandedColumn(null); }}
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

      {/* SQL Modal (original query) */}
      {showSqlModal && (
        <SqlModal
          sql={sql}
          onClose={() => setShowSqlModal(false)}
          onCopy={(text) => copyToClipboard(text, 'SQL')}
        />
      )}

      {/* Full SQL Modal (with filters and sort) */}
      {showFullSqlModal && (
        <SqlModal
          sql={fullSql}
          onClose={() => setShowFullSqlModal(false)}
          onCopy={(text) => copyToClipboard(text, 'SQL')}
          title="View Query"
        />
      )}

      {/* Query Header - consistent with collapsed state */}
      <div className="query-header">
        {/* Collapse toggle for collapsible mode */}
        {isCollapsible && (
          <span 
            className="query-expand-icon" 
            onClick={onToggleExpand}
            title="Collapse"
          >
            ▼
          </span>
        )}
        {statementLabel && <span className="query-label">{statementLabel}</span>}
        <code 
          className="query-sql"
          onClick={() => setShowSqlModal(true)}
          title="Click to view full SQL"
        >
          <SqlPreview sql={sql} />
        </code>
        <span className="query-meta">
          {hasResults ? (
            <span className="query-rows">{totalRows.toLocaleString()} rows</span>
          ) : (
            <span className="query-success">✓ success</span>
          )}
          <span className="query-time">{executionTime.toFixed(1)}ms</span>
          <button
            className={`refresh-btn ${isRefreshing ? 'refreshing' : ''}`}
            onClick={(e) => { e.stopPropagation(); handleRefresh(); }}
            disabled={isRefreshing}
            title="Re-run original query"
          >
            <RefreshCw size={13} />
          </button>
        </span>
      </div>

      {/* Stats Bar - rows, cols, sort, page, selection (only show when there are results) */}
      {hasResults && (
        <div className="stats-bar">
          <div className="stat">
            <span className="stat-label">rows</span>
            <span className="stat-value">
              {filteredRowCount < totalRows 
                ? <>{filteredRowCount.toLocaleString()} <span className="stat-total">/ {totalRows.toLocaleString()}</span></>
                : totalRows.toLocaleString()
              }
            </span>
          </div>
          <button 
            className={`stat stat-clickable ${showColumnsPanel ? 'active' : ''}`}
            onClick={() => {
              const newShow = !showColumnsPanel;
              setShowColumnsPanel(newShow);
              // Request summaries when opening if not already loaded
              if (newShow && !summariesLoaded) {
                requestColumnSummaries();
              }
            }}
            title="Toggle columns panel"
          >
            <span className="stat-label">cols</span>
            <span className="stat-value">{columns.length}</span>
          </button>
          {sort.column && (
            <div className="stat">
              <span className="stat-label">sort</span>
              <span className="stat-value">{sort.column} {sort.direction === 'asc' ? '↑' : '↓'}</span>
            </div>
          )}
          {totalPages > 1 && (
            <div className="stat">
              <span className="stat-label">page</span>
              <span className="stat-value">{currentPageNum} / {totalPages}</span>
            </div>
          )}
          {selectionInfo && (
            <div className="stat">
              <span className="stat-label">selected</span>
              <span className="stat-value">{selectionInfo}</span>
            </div>
          )}
          {(sort.column || (filterState.filters.length > 0 && !filterState.isPaused)) && (
            <button
              className="stat stat-clickable stat-sql"
              onClick={() => setShowFullSqlModal(true)}
              title="View current query with filters and sort"
            >
              <Code size={12} />
              <span className="stat-label">SQL</span>
            </button>
          )}
        </div>
      )}

      {/* Filter Bar */}
      {hasResults && totalRows > 0 && (
        <FilterBar
          filterState={filterState}
          onRemoveFilter={handleRemoveFilter}
          onClearAll={handleClearFilters}
          onTogglePause={handleTogglePause}
          onAddFilter={() => {
            // Show filter popover for first column as fallback
            if (columns.length > 0 && tableWrapperRef.current) {
              const firstHeader = tableWrapperRef.current.querySelector('th:not(.row-number-header)');
              if (firstHeader) {
                const rect = firstHeader.getBoundingClientRect();
                const tableRect = tableWrapperRef.current.getBoundingClientRect();
                setFilterPopover({
                  column: columns[0],
                  columnType: meta.columnTypes[0] || 'VARCHAR',
                  position: { top: rect.bottom - tableRect.top + 4, left: rect.left - tableRect.left },
                });
                setLoadingDistinct(true);
                const vscode = getVscodeApi();
                if (vscode) {
                  vscode.postMessage({ type: 'requestDistinctValues', cacheId, column: columns[0] });
                }
              }
            }
          }}
        />
      )}

      {/* Results Table or Empty State */}
      {!hasResults ? (
        // DDL/DML - no table structure
        <div className="empty-state">
          <span className="empty-icon">✓</span>
          <span>Statement executed successfully</span>
        </div>
      ) : totalRows === 0 ? (
        // SELECT with 0 rows - show column headers
        <div className="empty-results">
          <div className="table-wrapper">
            <table className="results-table">
              <thead>
                <tr>
                  {columns.map((col, idx) => (
                    <th key={idx} className="column-header">
                      <span className="column-name">{col}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={columns.length} className="empty-row-message">
                    0 rows returned
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="table-wrapper" ref={tableWrapperRef} tabIndex={0}>
          {/* Column Filter Popover */}
          {filterPopover && (
            <ColumnFilterPopover
              column={filterPopover.column}
              columnType={filterPopover.columnType}
              columns={columns.map((col, idx) => ({ name: col, type: meta.columnTypes[idx] || 'VARCHAR' }))}
              distinctValues={distinctValues}
              cardinality={columnCardinality}
              isLoading={loadingDistinct}
              onClose={() => setFilterPopover(null)}
              onApply={handleAddFilter}
              onColumnChange={(newCol, newType) => {
                setFilterPopover(prev => prev ? { ...prev, column: newCol, columnType: newType } : null);
                setDistinctValues([]);
                setColumnCardinality(0);
                setLoadingDistinct(true);
                const vscode = getVscodeApi();
                if (vscode) {
                  vscode.postMessage({ type: 'requestDistinctValues', cacheId, column: newCol });
                }
              }}
              position={filterPopover.position}
            />
          )}
          
          <table>
            <thead>
              <tr>
                <th className="row-number-header">#</th>
                {columns.map((col, idx) => {
                  const hasFilter = filterState.filters.some(f => f.column === col);
                  return (
                    <ResizableHeader
                      key={idx}
                      column={col}
                      width={columnWidths[col]}
                      isSorted={sort.column === col}
                      sortDirection={sort.column === col ? sort.direction : null}
                      isSelected={isColumnSelected(idx)}
                      hasFilter={hasFilter}
                      onSort={() => handleSort(col)}
                      onResize={(width) => handleColumnResize(col, width)}
                      onSelect={(e) => handleColumnSelect(idx, e)}
                      onOpenStats={() => openColumnStats(col)}
                      onOpenFilter={(e) => handleOpenFilterPopover(col, meta.columnTypes[idx] || 'VARCHAR', e)}
                    />
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row, rowIdx) => (
                <tr key={rowIdx} className={isRowSelected(rowIdx) ? 'row-selected' : ''}>
                  <td className="row-number" onClick={(e) => handleRowSelect(rowIdx, e)}>
                    {rowNumberOffset + rowIdx + 1}
                  </td>
                  {columns.map((col, colIdx) => (
                    <td 
                      key={colIdx}
                      className={isCellSelected(rowIdx, colIdx) ? 'selected' : ''}
                      style={columnWidths[col] ? { width: columnWidths[col], minWidth: columnWidths[col], maxWidth: columnWidths[col] } : undefined}
                      onClick={(e) => handleCellClick(rowIdx, colIdx, e)}
                      onDoubleClick={() => handleCellDoubleClick(rowIdx, colIdx)}
                    >
                      <CellValue value={row[col]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Fixed Footer with Pagination and Actions (only show when there are results) */}
      {hasResults && (
        <div className="results-footer">
          {/* Pagination controls */}
          {totalPages > 1 && (
            <div className="pagination">
              <button 
                className="pagination-btn"
                onClick={() => goToPage(1)}
                disabled={currentPageNum === 1 || isLoadingPage}
                title="First page"
              >
                ⟨⟨
              </button>
              <button 
                className="pagination-btn"
                onClick={() => goToPage(currentPageNum - 1)}
                disabled={currentPageNum === 1 || isLoadingPage}
                title="Previous page"
              >
                ⟨
              </button>
              <span className="pagination-info">
                {currentPageNum} / {totalPages}
              </span>
              <button 
                className="pagination-btn"
                onClick={() => goToPage(currentPageNum + 1)}
                disabled={currentPageNum === totalPages || isLoadingPage}
                title="Next page"
              >
                ⟩
              </button>
              <button 
                className="pagination-btn"
                onClick={() => goToPage(totalPages)}
                disabled={currentPageNum === totalPages || isLoadingPage}
                title="Last page"
              >
                ⟩⟩
              </button>
            </div>
          )}
          
          {/* Actions */}
          <div className="footer-actions">
          <button 
            className="footer-btn icon-only"
            onClick={copyFullTable}
            disabled={copyLoading}
            title={`Copy table (up to ${maxCopyRows.toLocaleString()} rows)`}
          >
            <Copy size={14} />
          </button>
          <div className="export-dropdown" ref={exportMenuRef}>
            <button 
              className="footer-btn icon-only"
              onClick={() => { setShowExportMenu(!showExportMenu); setShowOpenMenu(false); }}
              title="Export to file"
            >
              <Download size={14} />
              <ChevronDown size={12} />
            </button>
            {showExportMenu && (
              <div className="export-menu">
                <button onClick={() => handleExport('csv')}>CSV</button>
                <button onClick={() => handleExport('parquet')}>Parquet</button>
                <button onClick={() => handleExport('json')}>JSON</button>
                <button onClick={() => handleExport('jsonl')}>JSONL</button>
              </div>
            )}
          </div>
          <div className="export-dropdown" ref={openMenuRef}>
            <button 
              className="footer-btn icon-only"
              onClick={() => { setShowOpenMenu(!showOpenMenu); setShowExportMenu(false); }}
              title={`Open in new tab (up to ${maxCopyRows.toLocaleString()} rows)`}
            >
              <ExternalLink size={14} />
              <ChevronDown size={12} />
            </button>
            {showOpenMenu && (
              <div className="export-menu">
                <button onClick={() => handleExport('csv-tab')}>CSV</button>
                <button onClick={() => handleExport('json-tab')}>JSON</button>
              </div>
            )}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

// ============================================================================
// HELPER COMPONENTS
// ============================================================================

interface ResizableHeaderProps {
  column: string;
  width: number | undefined;
  isSorted: boolean;
  sortDirection: 'asc' | 'desc' | null;
  isSelected: boolean;
  hasFilter?: boolean;
  onSort: () => void;
  onResize: (width: number) => void;
  onSelect: (e: React.MouseEvent) => void;
  onOpenStats: () => void;
  onOpenFilter?: (e: React.MouseEvent) => void;
}

function ResizableHeader({ column, width, isSorted, sortDirection, isSelected, hasFilter, onSort, onResize, onSelect, onOpenStats, onOpenFilter }: ResizableHeaderProps) {
  const thRef = useRef<HTMLTableCellElement>(null);
  const [isResizing, setIsResizing] = useState(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
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
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    setIsResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [onResize]);

  return (
    <th
      ref={thRef}
      className={`${isSorted ? 'sorted' : ''} ${isResizing ? 'resizing' : ''} ${isSelected ? 'col-selected' : ''} ${hasFilter ? 'has-filter' : ''}`}
      style={width ? { width, minWidth: width, maxWidth: width } : undefined}
    >
      <div className="th-content">
        <span className="col-name" onClick={onSelect}>{column}</span>
        <div className="th-actions">
          {onOpenFilter && (
            <button 
              className={`header-icon-btn filter-btn ${hasFilter ? 'active' : ''}`} 
              onClick={(e) => { e.stopPropagation(); onOpenFilter(e); }} 
              title={`Filter by ${column}`}
            >
              <Filter size={12} />
            </button>
          )}
          <button className="header-icon-btn stats-btn" onClick={(e) => { e.stopPropagation(); onOpenStats(); }} title={`View stats for ${column}`}>
            <BarChart2 size={12} />
          </button>
          <button className={`header-icon-btn sort-btn ${isSorted ? 'active' : ''}`} onClick={(e) => { e.stopPropagation(); onSort(); }} title={`Sort by ${column}`}>
            {isSorted ? (sortDirection === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ChevronsUpDown size={12} />}
          </button>
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
  onClose: () => void;
  onCopy: (text: string) => void;
}

function CellExpansionModal({ value, column, onClose, onCopy }: CellExpansionModalProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  
  const displayText = useMemo(() => {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'object') {
      try { return JSON.stringify(value, null, 2); } catch { return String(value); }
    }
    return String(value);
  }, [value]);

  const isJson = typeof value === 'object' && value !== null;

  useEffect(() => {
    if (!isJson) {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    }
  }, [isJson]);

  const title = (
    <>
      <span className="modal-column">{column}</span>
      {isJson && <span className="modal-type">JSON</span>}
    </>
  );

  return (
    <Modal
      title={title}
      onClose={onClose}
      onCopy={() => onCopy(displayText)}
      hint="Select text and ⌘C to copy, or click Copy button"
      size={`${displayText.length.toLocaleString()} chars`}
    >
      {isJson ? (
        <pre className="modal-content modal-json"><JsonSyntaxHighlight json={displayText} /></pre>
      ) : (
        <textarea ref={textareaRef} className="modal-content" value={displayText} readOnly spellCheck={false} />
      )}
    </Modal>
  );
}

// SQL Modal
interface SqlModalProps {
  sql: string;
  onClose: () => void;
  onCopy: (text: string) => void;
  title?: string;
}

function SqlModal({ sql, onClose, onCopy, title = "SQL" }: SqlModalProps) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      onCopy={() => onCopy(sql)}
      size={`${sql.length.toLocaleString()} chars`}
      className="sql-modal"
    >
      <pre className="modal-content modal-sql">
        <SqlSyntaxHighlight sql={sql} />
      </pre>
    </Modal>
  );
}

