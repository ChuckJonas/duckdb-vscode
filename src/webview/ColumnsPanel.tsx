import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { ColumnStats } from './types';
import { Histogram } from './ui/Histogram';
import { TimeSeriesChart } from './ui/TimeSeriesChart';
import { Tooltip } from './ui/Tooltip';
import { Toggle } from './ui/Toggle';
import { 
  Copy, X, ChevronRight, ChevronDown, Search,
  Hash, Binary, Type, ToggleLeft, Calendar, Clock, Brackets, Braces, Map as MapIcon, HelpCircle, Fingerprint, DecimalsArrowRight
} from 'lucide-react';
import './styles.css';

// Sort options for columns
type SortOption = 'default' | 'name-asc' | 'name-desc' | 'unique-asc' | 'unique-desc' | 'null-asc' | 'null-desc';

// Type icon component mapping - order matters! More specific patterns first
const TYPE_ICON_PATTERNS: Array<{ pattern: RegExp; icon: React.ComponentType<{ size?: number }> }> = [
  // Array types (e.g., BIGINT[], VARCHAR[]) - must be first to catch before base types
  { pattern: /\[\]$/i, icon: Brackets },
  // Complex types - check before simpler types
  { pattern: /^UUID$/i, icon: Fingerprint },
  { pattern: /^MAP\b/i, icon: MapIcon },
  { pattern: /^STRUCT\b/i, icon: Braces },
  { pattern: /^LIST\b/i, icon: Brackets },
  { pattern: /^ARRAY\b/i, icon: Brackets },
  // JSON
  { pattern: /^JSON\b/i, icon: Braces },
  // Date/Time types
  { pattern: /^TIMESTAMP/i, icon: Clock },
  { pattern: /^DATE$/i, icon: Calendar },
  { pattern: /^TIME$/i, icon: Clock },
  { pattern: /^INTERVAL/i, icon: Clock },
  // Boolean
  { pattern: /^BOOL/i, icon: ToggleLeft },
  // Numeric - integers
  { pattern: /^(BIG|SMALL|TINY|HUGE)?INT/i, icon: Hash },
  { pattern: /^UBIGINT|UINTEGER|USMALLINT|UTINYINT|UHUGEINT/i, icon: Hash },
  // Numeric - floating point
  { pattern: /^(DOUBLE|FLOAT|REAL|DECIMAL|NUMERIC)/i, icon: DecimalsArrowRight },
  // Text types
  { pattern: /^(VARCHAR|TEXT|STRING|CHAR)/i, icon: Type },
  // Binary
  { pattern: /^(BYTEA|BLOB|BIT)/i, icon: Binary },
];

function getTypeIcon(type: string): React.ComponentType<{ size?: number }> {
  const trimmedType = type.trim();
  for (const { pattern, icon } of TYPE_ICON_PATTERNS) {
    if (pattern.test(trimmedType)) return icon;
  }
  return HelpCircle;
}

interface ColumnSummary {
  name: string;
  distinctCount: number;
  nullPercent: number;
  inferredType: string;
}

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

  // Filter and sort column summaries
  const filteredAndSortedSummaries = useMemo(() => {
    let result = [...columnSummaries];
    
    // Filter by search text (case-insensitive includes)
    if (filterText.trim()) {
      const searchLower = filterText.toLowerCase();
      result = result.filter(s => s.name.toLowerCase().includes(searchLower));
    }
    
    // Filter out entirely null columns if enabled
    if (hideNullColumns) {
      result = result.filter(s => s.nullPercent < 100);
    }
    
    // Sort based on selected option
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
    
    return result;
  }, [columnSummaries, hideNullColumns, sortOption, filterText]);

  // Check if any columns are 100% null (empty)
  const emptyColumns = columnSummaries.filter(s => s.nullPercent >= 100);
  const hasEmptyColumns = emptyColumns.length > 0;
  
  // Count hidden columns
  const hiddenCount = hideNullColumns ? emptyColumns.length : 0;

  // Toast state for copy feedback
  const [copyToast, setCopyToast] = useState<string | null>(null);

  // Show copy toast briefly
  const showCopyToast = useCallback((message: string) => {
    setCopyToast(message);
    setTimeout(() => setCopyToast(null), 1500);
  }, []);

  // Copy all column names to clipboard (newline-separated for Excel compatibility)
  const handleCopyAllColumns = useCallback(() => {
    const names = filteredAndSortedSummaries.map(s => s.name).join('\n');
    navigator.clipboard.writeText(names).then(() => {
      showCopyToast(`Copied ${filteredAndSortedSummaries.length} columns`);
    });
  }, [filteredAndSortedSummaries, showCopyToast]);

  // Copy single column name to clipboard
  const handleCopyColumnName = useCallback((name: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Don't trigger row expand
    navigator.clipboard.writeText(name).then(() => {
      showCopyToast(`Copied "${name}"`);
    });
  }, [showCopyToast]);

  // Handle resize drag
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isResizing) return;
    const delta = startXRef.current - e.clientX;
    const newWidth = Math.max(200, Math.min(600, startWidthRef.current + delta));
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
      {/* Copy toast */}
      {copyToast && <div className="columns-copy-toast">{copyToast}</div>}
      
      {/* Resize handle */}
      <div 
        className="columns-panel-resize-handle"
        onMouseDown={startResize}
      />
      <div className="columns-panel-header">
        <span className="columns-panel-title">
          {filteredAndSortedSummaries.length !== columnSummaries.length
            ? `${filteredAndSortedSummaries.length}/${columnSummaries.length} Columns`
            : `${columnSummaries.length} Columns`}
          <button 
            className="columns-copy-all-btn"
            onClick={handleCopyAllColumns}
            title="Copy all column names"
          >
            <Copy size={14} />
          </button>
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
          <button className="columns-panel-close" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </div>
      </div>
      
      {/* Search filter */}
      <div className="columns-search">
        <Search size={14} className="columns-search-icon" />
        <input
          type="text"
          className="columns-search-input"
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
            onCopyName={handleCopyColumnName}
            stats={columnStats[summary.name] ?? null}
            isLoading={loadingStats === summary.name}
            error={loadingStats === summary.name ? statsError : null}
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
  onCopyName: (name: string, e: React.MouseEvent) => void;
  stats: ColumnStats | null;
  isLoading: boolean;
  error: string | null;
}

function ColumnRow({ summary, isExpanded, onClick, onCopyName, stats, isLoading, error }: ColumnRowProps) {
  const TypeIcon = getTypeIcon(summary.inferredType);
  
  return (
    <div className={`column-row ${isExpanded ? 'expanded' : ''}`}>
      <div className="column-row-header" onClick={onClick}>
        <button 
          className="column-row-copy"
          onClick={(e) => onCopyName(summary.name, e)}
          title={`Copy "${summary.name}"`}
        >
          <Copy size={12} />
        </button>
        <Tooltip content={<span className="column-type-tooltip">{summary.inferredType}</span>} position="right">
          <span className="column-type-icon">
            <TypeIcon size={14} />
          </span>
        </Tooltip>
        <span className="column-name">{summary.name}</span>
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

function ColumnDetails({ stats, inferredType }: { stats: ColumnStats; inferredType: string }) {
  const isNumeric = stats.type === 'numeric' && (stats.mean !== undefined || stats.quantiles !== undefined);
  const isDate = stats.type === 'date' && stats.timeseries;
  
  // Complex types: UUID, JSON, STRUCT, LIST, MAP, arrays (e.g., BIGINT[])
  // These shouldn't show top values (not meaningful) or min/max
  const isComplexType = /^(UUID|JSON|STRUCT|LIST|MAP|ARRAY)/i.test(inferredType) || /\[\]$/.test(inferredType);
  
  // Boolean should show top values (true/false distribution is useful)
  const isBoolean = /^BOOL/i.test(inferredType);
  
  return (
    <div className="column-details">
      <div className="column-stats-grid">
        <div className="column-stat">
          <span className="column-stat-label">Total</span>
          <span className="column-stat-value">{stats.total.toLocaleString()}</span>
        </div>
        <div className="column-stat">
          <span className="column-stat-label">Non-null</span>
          <span className="column-stat-value">{stats.nonNull.toLocaleString()}</span>
        </div>
        <div className="column-stat">
          <span className="column-stat-label">Null</span>
          <span className="column-stat-value">{stats.nullCount.toLocaleString()}</span>
        </div>
        <div className="column-stat">
          <span className="column-stat-label">Unique</span>
          <span className="column-stat-value">~{stats.unique.toLocaleString()}</span>
        </div>
      </div>
      
      {/* Time series chart for date/timestamp columns */}
      {isDate && stats.timeseries && (
        <TimeSeriesChart data={stats.timeseries} />
      )}
      
      {/* Histogram with stats table for numeric columns */}
      {isNumeric && stats.histogram && stats.histogram.length > 0 ? (
        <NumericDistribution 
          stats={stats}
          histogram={stats.histogram}
        />
      ) : (!isDate && !isComplexType && (stats.min !== null || stats.max !== null)) ? (
        <div className="column-stats-grid">
          <div className="column-stat">
            <span className="column-stat-label">Min</span>
            <span className="column-stat-value">{stats.min ?? 'NULL'}</span>
          </div>
          <div className="column-stat">
            <span className="column-stat-label">Max</span>
            <span className="column-stat-value">{stats.max ?? 'NULL'}</span>
          </div>
          {stats.mean !== undefined && (
            <div className="column-stat">
              <span className="column-stat-label">Mean</span>
              <span className="column-stat-value">
                {stats.mean.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
            </div>
          )}
          {stats.stddev !== undefined && (
            <div className="column-stat">
              <span className="column-stat-label">Std Dev</span>
              <span className="column-stat-value">
                {stats.stddev.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
            </div>
          )}
        </div>
      ) : null}
      
      {/* Top values for string/boolean columns (not complex types like UUID, JSON, arrays, structs) */}
      {stats.topValues && stats.topValues.length > 0 && !isComplexType && (
        <div className="column-top-values-section">
          <span className="column-section-title">Top Values</span>
          <MiniTopValues data={stats.topValues} total={stats.nonNull} />
        </div>
      )}
    </div>
  );
}

interface NumericDistributionProps {
  stats: ColumnStats;
  histogram: { bucket: string; count: number }[];
}

function NumericDistribution({ stats, histogram }: NumericDistributionProps) {
  const [highlightValue, setHighlightValue] = useState<number | null>(null);
  const [highlightRange, setHighlightRange] = useState<[number, number] | null>(null);
  
  const min = stats.min !== null ? Number(stats.min) : null;
  const max = stats.max !== null ? Number(stats.max) : null;
  
  const formatVal = (v: number | undefined) => 
    v !== undefined ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
  
  // Stats rows
  const statRows: { label: string; value: number | undefined; isRange?: [number, number] }[] = [
    { label: 'Min', value: min ?? undefined },
    { label: 'Max', value: max ?? undefined },
    { label: '5th %', value: stats.quantiles?.q05 },
    { label: '25th %', value: stats.quantiles?.q25 },
    { label: '50th % (median)', value: stats.quantiles?.q50 },
    { label: '75th %', value: stats.quantiles?.q75 },
    { label: '95th %', value: stats.quantiles?.q95 },
    { label: 'Mean', value: stats.mean },
    { label: 'Std Dev', value: stats.stddev },
  ];
  
  // IQR range (25th to 75th)
  const iqrRange: [number, number] | undefined = 
    stats.quantiles?.q25 !== undefined && stats.quantiles?.q75 !== undefined
      ? [stats.quantiles.q25, stats.quantiles.q75]
      : undefined;
  
  return (
    <div className="numeric-distribution">
      <span className="column-section-title">Distribution</span>
      

        <Histogram
        data={histogram} 
        highlightValue={highlightValue}
        highlightRange={highlightRange}
        dataMin={min ?? undefined}
        dataMax={max ?? undefined}
      />
      
      {/* Stats table */}
      <div className="stats-table">
        <div className="stats-table-header">Approx. Statistics</div>
        {statRows.map((row, idx) => (
          <div 
            key={idx}
            className={`stats-table-row ${highlightValue === row.value ? 'highlighted' : ''}`}
            onMouseEnter={() => {
              console.log('🦆 Mouse enter stat row:', row.label, row.value);
              if (row.value !== undefined) {
                // Show IQR range for 25th and 75th percentiles
                if ((row.label === '25th %' || row.label === '75th %') && iqrRange) {
                  setHighlightValue(row.value);
                  setHighlightRange(iqrRange);
                } 
                // Show mean ± stddev range for standard deviation
                else if (row.label === 'Std Dev' && stats.mean !== undefined && stats.stddev !== undefined) {
                  setHighlightValue(null); // No single line
                  setHighlightRange([stats.mean - stats.stddev, stats.mean]);
                }
                // Regular single value highlight
                else {
                  console.log('🦆 Setting highlightValue to:', row.value);
                  setHighlightValue(row.value);
                  setHighlightRange(null);
                }
              }
            }}
            onMouseLeave={() => {
              setHighlightValue(null);
              setHighlightRange(null);
            }}
          >
            <span className="stats-table-label">{row.label}</span>
            <span className="stats-table-value">{formatVal(row.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniTopValues({ data, total }: { data: { value: string; count: number; type: 'top_n' | 'other' }[]; total: number }) {
  // Separate top values from "Other" bucket (computed by SQL)
  const topItems = data.filter(d => d.type === 'top_n').slice(0, 10);
  const otherItem = data.find(d => d.type === 'other');
  const maxCount = Math.max(...topItems.map(d => d.count), otherItem?.count ?? 0);
  
  const formatCount = (count: number): string => {
    if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
    if (count >= 1000) return (count / 1000).toFixed(1) + 'K';
    return count.toLocaleString();
  };
  
  return (
    <div className="mini-top-values">
      {topItems.map((item, idx) => (
        <div key={idx} className="mini-top-value">
          <div className="mini-top-value-bar-bg">
            <div 
              className="mini-top-value-bar" 
              style={{ width: `${(item.count / maxCount) * 100}%` }}
            />
          </div>
          <span className="mini-top-value-label" title={item.value}>
            {item.value.length > 15 ? item.value.slice(0, 15) + '…' : item.value}
          </span>
          <span className="mini-top-value-stats">
            <span className="mini-top-value-count">{formatCount(item.count)}</span>
            <span className="mini-top-value-pct">({((item.count / total) * 100).toFixed(0)}%)</span>
          </span>
        </div>
      ))}
      {otherItem && otherItem.count > 0 && (
        <div className="mini-top-value other">
          <div className="mini-top-value-bar-bg">
            <div 
              className="mini-top-value-bar other" 
              style={{ width: `${(otherItem.count / maxCount) * 100}%` }}
            />
          </div>
          <span className="mini-top-value-label other">Other</span>
          <span className="mini-top-value-stats">
            <span className="mini-top-value-count">{formatCount(otherItem.count)}</span>
            <span className="mini-top-value-pct">({((otherItem.count / total) * 100).toFixed(0)}%)</span>
          </span>
        </div>
      )}
    </div>
  );
}
