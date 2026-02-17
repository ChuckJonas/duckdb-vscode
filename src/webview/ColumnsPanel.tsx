import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { ColumnStats, ColumnSummary } from './types';
import { Fzf, FzfResultItem } from 'fzf';
import { Tooltip } from './ui/Tooltip';
import { ColumnDetails } from './ui/ColumnDetails';
import { Toggle } from './ui/Toggle';
import { IconButton } from './ui/IconButton';
import { FuzzyHighlight, EMPTY_POSITIONS } from './ui/FuzzyHighlight';
import { CopyButton } from './ui/CopyButton';
import { formatCount } from './utils/format';
import { 
  X, ChevronRight, ChevronDown, Search,
} from 'lucide-react';
import { getTypeIcon } from './utils/typeIcons';
import './styles.css';

// Sort options for columns
type SortOption = 'default' | 'name-asc' | 'name-desc' | 'unique-asc' | 'unique-desc' | 'null-asc' | 'null-desc';

interface ColumnsPanelProps {
  columns: string[];
  onClose: () => void;
  onRequestStats: (columnName: string) => void;
  columnStats: Record<string, ColumnStats | null>;
  loadingStats: string | null;
  statsError: string | null;
  width: number;
  onResize: (width: number) => void;
  initialExpandedColumn?: string | null;
  columnSummaries: ColumnSummary[];
  loadingSummaries: boolean;
}

export function ColumnsPanel({ 
  columns, 
  onClose, 
  onRequestStats,
  columnStats,
  loadingStats,
  statsError,
  width,
  onResize,
  initialExpandedColumn,
  columnSummaries,
  loadingSummaries,
}: ColumnsPanelProps) {
  const [expandedColumn, setExpandedColumn] = useState<string | null>(initialExpandedColumn ?? null);
  const [hideNullColumns, setHideNullColumns] = useState(false);
  const [sortOption, setSortOption] = useState<SortOption>('default');
  const [filterText, setFilterText] = useState('');
  
  // Update expanded column when initialExpandedColumn changes
  useEffect(() => {
    if (initialExpandedColumn) {
      setExpandedColumn(initialExpandedColumn);
    }
  }, [initialExpandedColumn]);
  const [isResizing, setIsResizing] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);

  // Fuzzy search with fzf
  const fzfInstance = useMemo(
    () => new Fzf(columnSummaries, { selector: (s) => s.name }),
    [columnSummaries]
  );

  // Map of column name -> matched character positions (for highlighting)
  const [filteredAndSortedSummaries, fuzzyPositions] = useMemo(() => {
    let result: ColumnSummary[];
    const positions = new Map<string, Set<number>>();

    if (filterText.trim()) {
      const entries: FzfResultItem<ColumnSummary>[] = fzfInstance.find(filterText);
      result = entries.map(e => {
        positions.set(e.item.name, e.positions);
        return e.item;
      });
    } else {
      result = [...columnSummaries];
    }

    // Filter out entirely null columns if enabled
    if (hideNullColumns) {
      result = result.filter(s => s.nullPercent < 100);
    }

    // Apply manual sort only when not fuzzy-filtering (fzf provides its own ranking)
    if (!filterText.trim()) {
      switch (sortOption) {
        case 'name-asc':
          result.sort((a, b) => a.name.localeCompare(b.name));
          break;
        case 'name-desc':
          result.sort((a, b) => b.name.localeCompare(a.name));
          break;
        case 'unique-asc':
          result.sort((a, b) => a.distinctCount - b.distinctCount);
          break;
        case 'unique-desc':
          result.sort((a, b) => b.distinctCount - a.distinctCount);
          break;
        case 'null-asc':
          result.sort((a, b) => a.nullPercent - b.nullPercent);
          break;
        case 'null-desc':
          result.sort((a, b) => b.nullPercent - a.nullPercent);
          break;
        // 'default' keeps original order
      }
    }

    return [result, positions] as const;
  }, [columnSummaries, fzfInstance, hideNullColumns, sortOption, filterText]);

  // Check if any columns are 100% null (empty)
  const emptyColumns = columnSummaries.filter(s => s.nullPercent >= 100);
  const hasEmptyColumns = emptyColumns.length > 0;
  
  // Count hidden columns
  const hiddenCount = hideNullColumns ? emptyColumns.length : 0;

  // All column names as newline-separated string (for "copy all" button)
  const allColumnNamesText = useMemo(
    () => filteredAndSortedSummaries.map(s => s.name).join('\n'),
    [filteredAndSortedSummaries]
  );

  // Handle resize drag
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isResizing) return;
    const delta = startXRef.current - e.clientX;
    // Min 280, max 50% of window width (capped at 800)
    const maxWidth = Math.min(800, Math.floor(window.innerWidth * 0.5));
    const newWidth = Math.max(280, Math.min(maxWidth, startWidthRef.current + delta));
    onResize(newWidth);
  }, [isResizing, onResize]);

  const handleMouseUp = useCallback(() => {
    setIsResizing(false);
  }, []);

  useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing, handleMouseMove, handleMouseUp]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    startXRef.current = e.clientX;
    startWidthRef.current = width;
    setIsResizing(true);
  };

  // Column summaries come from server (full dataset stats)

  const handleColumnClick = (columnName: string) => {
    if (expandedColumn === columnName) {
      setExpandedColumn(null);
    } else {
      setExpandedColumn(columnName);
      // Request detailed stats if not already loaded
      if (!columnStats[columnName]) {
        onRequestStats(columnName);
      }
    }
  };

  // Toggle sort when clicking a header: none -> desc -> asc -> none
  const handleHeaderSort = (column: 'name' | 'unique' | 'null') => {
    const ascKey = `${column}-asc` as SortOption;
    const descKey = `${column}-desc` as SortOption;
    
    if (sortOption === descKey) {
      setSortOption(ascKey);
    } else if (sortOption === ascKey) {
      setSortOption('default');
    } else {
      setSortOption(descKey);
    }
  };

  // Get sort indicator for a column
  const getSortIndicator = (column: 'name' | 'unique' | 'null') => {
    if (sortOption === `${column}-desc`) return ' ↓';
    if (sortOption === `${column}-asc`) return ' ↑';
    return '';
  };

  return (
    <div className="columns-panel" style={{ width }}>
      {/* Resize handle */}
      <div 
        className="columns-panel-resize-handle"
        onMouseDown={startResize}
      />
      <div className="panel-header columns-panel-header">
        <span className="columns-panel-title">
          {filteredAndSortedSummaries.length !== columnSummaries.length
            ? `${filteredAndSortedSummaries.length}/${columnSummaries.length} Columns`
            : `${columnSummaries.length} Columns`}
          <CopyButton
            text={allColumnNamesText}
            title="Copy all column names"
            className="columns-copy-all-btn"
            size={14}
          />
          {hiddenCount > 0 && <span className="columns-hidden-count">({hiddenCount} hidden)</span>}
        </span>
        <div className="columns-header-actions">
          {hasEmptyColumns && (
            <Toggle
              checked={!hideNullColumns}
              onChange={(checked) => setHideNullColumns(!checked)}
              label="Empty"
            />
          )}
          <IconButton icon={<X size={16} />} tooltip="Close" onClick={onClose} />
        </div>
      </div>
      
      {/* Search filter */}
      <div className="columns-search">
        <Search size={14} className="columns-search-icon" />
        <input
          type="text"
          className="input-base columns-search-input"
          placeholder="Filter columns..."
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
        {filterText && (
          <button 
            className="columns-search-clear"
            onClick={() => setFilterText('')}
            title="Clear filter"
          >
            <X size={14} />
          </button>
        )}
      </div>
      
      {/* Column list header */}
      <div className="columns-list-header">
        <span className="columns-list-header-type" title="Data type"></span>
        <span 
          className={`columns-list-header-name sortable ${sortOption.startsWith('name') ? 'sorted' : ''}`}
          onClick={() => handleHeaderSort('name')}
          title="Sort by name"
        >
          Name{getSortIndicator('name')}
        </span>
        <span 
          className={`columns-list-header-unique sortable ${sortOption.startsWith('unique') ? 'sorted' : ''}`}
          onClick={() => handleHeaderSort('unique')}
          title="Sort by distinct count"
        >
          Unique{getSortIndicator('unique')}
        </span>
        <span 
          className={`columns-list-header-null sortable ${sortOption.startsWith('null') ? 'sorted' : ''}`}
          onClick={() => handleHeaderSort('null')}
          title="Sort by null percentage"
        >
          Null %{getSortIndicator('null')}
        </span>
        <span className="columns-list-header-expand"></span>
      </div>
      
      <div className="columns-panel-content">
        {loadingSummaries ? (
          <div className="columns-panel-loading">
            <div className="loading-spinner small" />
            <span>Loading column summaries...</span>
          </div>
        ) : filteredAndSortedSummaries.map((summary, idx) => (
          <ColumnRow
            key={idx}
            summary={summary}
            isExpanded={expandedColumn === summary.name}
            onClick={() => handleColumnClick(summary.name)}
            stats={columnStats[summary.name] ?? null}
            isLoading={loadingStats === summary.name}
            error={loadingStats === summary.name ? statsError : null}
            highlightPositions={fuzzyPositions.get(summary.name) ?? EMPTY_POSITIONS}
          />
        ))}
      </div>
    </div>
  );
}

interface ColumnRowProps {
  summary: ColumnSummary;
  isExpanded: boolean;
  onClick: () => void;
  stats: ColumnStats | null;
  isLoading: boolean;
  error: string | null;
  highlightPositions: Set<number>;
}

function ColumnRow({ summary, isExpanded, onClick, stats, isLoading, error, highlightPositions }: ColumnRowProps) {
  const TypeIcon = getTypeIcon(summary.inferredType);
  
  return (
    <div className={`column-row ${isExpanded ? 'expanded' : ''}`}>
      <div className="column-row-header" onClick={onClick}>
        <CopyButton
          text={summary.name}
          title={`Copy "${summary.name}"`}
          className="column-row-copy"
          size={12}
        />
        <Tooltip content={<span className="column-type-tooltip">{summary.inferredType}</span>} position="right">
          <span className="column-type-icon">
            <TypeIcon size={14} />
          </span>
        </Tooltip>
        <span className="column-name">
          <FuzzyHighlight text={summary.name} indices={highlightPositions} />
        </span>
        <span className="column-distinct" title="Distinct values">
          {summary.distinctCount.toLocaleString()}
        </span>
        <span className="column-null-pct" title="% null">
          {summary.nullPercent > 0 ? `${summary.nullPercent.toFixed(1)}%` : '—'}
        </span>
        <span className="column-expand-icon">
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </div>
      
      {isExpanded && (
        <div className="column-row-details">
          {isLoading ? (
            <div className="column-details-loading">
              <div className="loading-spinner small" />
              <span>Loading statistics...</span>
            </div>
          ) : error ? (
            <div className="column-details-error">
              <span className="error-icon">⚠</span>
              <span>{error}</span>
            </div>
          ) : stats ? (
            <ColumnDetails stats={stats} inferredType={summary.inferredType} />
          ) : (
            <div className="column-details-loading">
              <div className="loading-spinner small" />
              <span>Loading statistics...</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

