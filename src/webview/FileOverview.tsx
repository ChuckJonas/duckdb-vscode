import React, { useState, useMemo, useCallback, useEffect } from 'react';
import type { DataOverviewMetadata, ColumnStats, ColumnSummary } from './types';
import { Fzf } from 'fzf';
import { formatCount } from './utils/format';
import {
  ChevronDown, ChevronRight, Play, FileText,
  CheckSquare, Square, Minus,
  Search, X, Database, Eye,
} from 'lucide-react';
import { SqlPreview } from './ui/SqlHighlight';
import { SqlModal } from './ui/SqlModal';
import { FuzzyHighlight, EMPTY_POSITIONS } from './ui/FuzzyHighlight';
import { CopyButton } from './ui/CopyButton';
import { ColumnDetails } from './ui/ColumnDetails';
import { Toggle } from './ui/Toggle';
import { getTypeIcon } from './utils/typeIcons';
import './styles.css';

// Get VS Code API (exposed globally from index.tsx)
function getVscodeApi() {
  return (window as unknown as { vscodeApi: { postMessage: (msg: unknown) => void } }).vscodeApi;
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

function getFileTypeBadge(fileType: string): string {
  const map: Record<string, string> = {
    parquet: 'PARQUET',
    csv: 'CSV',
    tsv: 'TSV',
    json: 'JSON',
    jsonl: 'JSONL',
    ndjson: 'NDJSON',
  };
  return map[fileType.toLowerCase()] || fileType.toUpperCase();
}

const SELECT_TOP_OPTIONS = [
  { label: '1K', value: 1000 },
  { label: '10K', value: 10000 },
  { label: '100K', value: 100000 },
  { label: '1M', value: 1000000 },
];

interface FileOverviewProps {
  metadata: DataOverviewMetadata;
}

export function FileOverview({ metadata }: FileOverviewProps) {
  const { displayName, rowCount, columns } = metadata;
  const isFile = metadata.sourceKind === 'file';
  const isTable = metadata.sourceKind === 'table';

  // Column selection state
  const [selectedColumns, setSelectedColumns] = useState<Set<string>>(
    () => new Set(columns.map(c => c.name))
  );
  const [showDropdown, setShowDropdown] = useState(false);
  const [showSqlModal, setShowSqlModal] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [hideNullColumns, setHideNullColumns] = useState(false);

  // Summaries (auto-loaded from SUMMARIZE)
  const [summaries, setSummaries] = useState<ColumnSummary[]>([]);
  const [summariesLoading, setSummariesLoading] = useState(true);

  // Per-column detailed stats (lazy loaded on expand)
  const [expandedColumn, setExpandedColumn] = useState<string | null>(null);
  const [columnStatsMap, setColumnStatsMap] = useState<Record<string, ColumnStats | null>>({});
  const [loadingStatsColumn, setLoadingStatsColumn] = useState<string | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);

  // Auto-request summaries on mount
  useEffect(() => {
    const vscode = getVscodeApi();
    vscode.postMessage({ type: 'requestFileSummaries' });
  }, []);

  // Listen for summary and stats responses
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === 'fileSummaries') {
        setSummaries(message.data || []);
        setSummariesLoading(false);
      } else if (message.type === 'fileColumnStats') {
        if (message.data) {
          setColumnStatsMap(prev => ({
            ...prev,
            [message.column]: message.data,
          }));
        }
        setStatsError(message.error || null);
        setLoadingStatsColumn(null);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Build a lookup for summaries by column name
  const summaryMap = useMemo(() => {
    const map = new Map<string, ColumnSummary>();
    for (const s of summaries) map.set(s.name, s);
    return map;
  }, [summaries]);

  // Detect columns that are 100% null
  const emptyColumnNames = useMemo(() => {
    const names = new Set<string>();
    for (const s of summaries) {
      if (s.nullPercent >= 100) names.add(s.name);
    }
    return names;
  }, [summaries]);
  const hasEmptyColumns = emptyColumnNames.size > 0;

  const allSelected = selectedColumns.size === columns.length;
  const noneSelected = selectedColumns.size === 0;

  // Fuzzy search with fzf
  const fzfInstance = useMemo(
    () => new Fzf(columns, { selector: (c) => c.name }),
    [columns]
  );

  const [filteredColumns, fuzzyPositions] = useMemo(() => {
    let result: typeof columns;
    const positions = new Map<string, Set<number>>();

    if (filterText.trim()) {
      const entries = fzfInstance.find(filterText);
      result = entries.map(e => {
        positions.set(e.item.name, e.positions);
        return e.item;
      });
    } else {
      result = columns;
    }

    if (hideNullColumns) {
      result = result.filter(c => !emptyColumnNames.has(c.name));
    }

    return [result, positions] as const;
  }, [columns, fzfInstance, filterText, hideNullColumns, emptyColumnNames]);

  // Only show top-N options where row count exceeds the threshold
  const visibleTopOptions = useMemo(
    () => SELECT_TOP_OPTIONS.filter(opt => rowCount >= opt.value),
    [rowCount]
  );
  const defaultOption = visibleTopOptions.length > 0
    ? visibleTopOptions[0]
    : null;

  const toggleColumn = useCallback((name: string) => {
    setSelectedColumns(prev => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (allSelected) {
      setSelectedColumns(new Set());
    } else {
      setSelectedColumns(new Set(columns.map(c => c.name)));
    }
  }, [allSelected, columns]);

  const handleToggleHideNulls = useCallback((hide: boolean) => {
    setHideNullColumns(hide);
    if (hide) {
      // Deselect all 100% null columns
      setSelectedColumns(prev => {
        const next = new Set(prev);
        for (const name of emptyColumnNames) next.delete(name);
        return next;
      });
    }
  }, [emptyColumnNames]);

  // Build the SQL source reference (file path or qualified table name)
  const sqlSource = useMemo(() => {
    if (isTable) {
      return `"${metadata.database}"."${metadata.schema}"."${metadata.tableName}"`;
    }
    return `'${displayName}'`;
  }, [metadata, displayName, isTable]);

  // Build the SQL preview based on selected columns
  const sqlPreview = useMemo(() => {
    if (noneSelected) return `-- Select at least one column`;
    const colList = allSelected
      ? '*'
      : columns
          .filter(c => selectedColumns.has(c.name))
          .map(c => `"${c.name}"`)
          .join(', ');
    return `SELECT ${colList} FROM ${sqlSource}`;
  }, [selectedColumns, columns, sqlSource, allSelected, noneSelected]);

  // Get ordered list of selected column names (preserving original order)
  const selectedColumnNames = useMemo(() => {
    if (allSelected) return undefined;
    return columns.filter(c => selectedColumns.has(c.name)).map(c => c.name);
  }, [selectedColumns, columns, allSelected]);

  const handleQueryFile = useCallback((limit?: number) => {
    if (noneSelected) return;
    setShowDropdown(false);
    const vscode = getVscodeApi();
    vscode.postMessage({
      type: 'queryFile',
      columns: selectedColumnNames,
      limit,
    });
  }, [selectedColumnNames, noneSelected]);

  const handleOpenAsSql = useCallback(() => {
    const vscode = getVscodeApi();
    vscode.postMessage({
      type: 'openAsSql',
      columns: selectedColumnNames,
    });
  }, [selectedColumnNames]);

  const handleCopySql = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
  }, []);

  // Expand/collapse column stats
  const handleToggleExpand = useCallback((colName: string) => {
    if (expandedColumn === colName) {
      setExpandedColumn(null);
    } else {
      setExpandedColumn(colName);
      // Request stats if not already loaded
      if (!columnStatsMap[colName]) {
        setLoadingStatsColumn(colName);
        setStatsError(null);
        const vscode = getVscodeApi();
        vscode.postMessage({
          type: 'requestFileColumnStats',
          column: colName,
        });
      }
    }
  }, [expandedColumn, columnStatsMap]);

  return (
    <div className="file-overview">
      {/* Header */}
      <div className="file-overview-header">
        <div className="file-overview-title">
          {isFile ? <FileText size={16} /> : isTable && metadata.isView ? <Eye size={16} /> : <Database size={16} />}
          <span className="file-overview-name">{displayName}</span>
          {isFile && (
            <span className="file-overview-badge">{getFileTypeBadge(metadata.fileType)}</span>
          )}
          {isTable && (
            <span className="file-overview-badge">{metadata.isView ? 'VIEW' : 'TABLE'}</span>
          )}
        </div>
        <div className="file-overview-stats">
          {isTable && (
            <>
              <span className="file-overview-stat file-overview-stat-muted">
                {metadata.database}.{metadata.schema}
              </span>
              <span className="file-overview-stat-sep">·</span>
            </>
          )}
          <span className="file-overview-stat">
            {rowCount.toLocaleString()} rows
          </span>
          <span className="file-overview-stat-sep">·</span>
          <span className="file-overview-stat">
            {columns.length} columns
          </span>
          {isFile && (
            <>
              <span className="file-overview-stat-sep">·</span>
              <span className="file-overview-stat">
                {formatFileSize(metadata.fileSize)}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Action bar */}
      <div className="file-overview-actions">
        <div className="file-overview-actions-left">
          {/* Select split button */}
          <div className="file-overview-dropdown-wrapper">
            {defaultOption ? (
              <>
                <button
                  className="btn btn-primary"
                  onClick={() => handleQueryFile(defaultOption.value)}
                  disabled={noneSelected}
                  title={noneSelected ? 'Select at least one column' : `Select top ${defaultOption.label} rows`}
                >
                  <Play size={12} />
                  Select Top {defaultOption.label}
                </button>
                <button
                  className="btn btn-primary file-overview-dropdown-toggle"
                  onClick={() => setShowDropdown(!showDropdown)}
                  disabled={noneSelected}
                >
                  <ChevronDown size={12} />
                </button>
                {showDropdown && (
                  <div className="file-overview-dropdown">
                    {visibleTopOptions.map(opt => (
                      <button
                        key={opt.value}
                        className="file-overview-dropdown-item"
                        onClick={() => handleQueryFile(opt.value)}
                      >
                        Top {opt.label}
                      </button>
                    ))}
                    <div className="file-overview-dropdown-sep" />
                    <button
                      className="file-overview-dropdown-item file-overview-dropdown-item-all"
                      onClick={() => handleQueryFile()}
                    >
                      All Rows ({formatCount(rowCount)})
                    </button>
                  </div>
                )}
              </>
            ) : (
              <button
                className="btn btn-primary"
                onClick={() => handleQueryFile()}
                disabled={noneSelected}
                title={noneSelected ? 'Select at least one column' : `Select all ${rowCount.toLocaleString()} rows`}
              >
                <Play size={12} />
                Select All ({formatCount(rowCount)})
              </button>
            )}
          </div>
        </div>

      </div>

      {/* SQL Preview — clickable, matches ResultsTable query header */}
      <div className="file-overview-sql-preview">
        <code
          className="query-sql"
          onClick={() => setShowSqlModal(true)}
          title="Click to view full SQL"
        >
          <SqlPreview sql={sqlPreview} />
        </code>
      </div>

      {/* SQL Modal — shared with ResultsTable */}
      {showSqlModal && (
        <SqlModal
          sql={sqlPreview}
          onClose={() => setShowSqlModal(false)}
          onCopy={handleCopySql}
          onOpenInEditor={handleOpenAsSql}
          title="SQL Preview"
        />
      )}

      {/* Column search — reuses ColumnsPanel search styling */}
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
        {hasEmptyColumns && !summariesLoading && (
          <Toggle
            checked={!hideNullColumns}
            onChange={(checked) => handleToggleHideNulls(!checked)}
            label="Empty"
          />
        )}
      </div>

      {/* Schema table */}
      <div className="file-overview-schema">
        <table className="file-overview-schema-table">
          <thead>
            <tr>
              <th className="file-overview-schema-check">
                <button
                  className="file-overview-checkbox-btn"
                  onClick={toggleAll}
                  title={allSelected ? 'Deselect all' : 'Select all'}
                >
                  {allSelected ? <CheckSquare size={14} /> : noneSelected ? <Square size={14} /> : <Minus size={14} />}
                </button>
              </th>
              <th className="file-overview-schema-icon"></th>
              <th className="file-overview-schema-name">
                {filterText
                  ? `${filteredColumns.length}/${columns.length} Columns`
                  : 'Column'}
              </th>
              <th className="file-overview-schema-type">Type</th>
              <th className="file-overview-schema-unique">
                {summariesLoading ? <div className="loading-spinner small" /> : 'Unique'}
              </th>
              <th className="file-overview-schema-null">
                {summariesLoading ? <div className="loading-spinner small" /> : 'Null %'}
              </th>
              <th className="file-overview-schema-expand"></th>
            </tr>
          </thead>
          <tbody>
            {filteredColumns.map((col) => {
              const Icon = getTypeIcon(col.type);
              const isSelected = selectedColumns.has(col.name);
              const summary = summaryMap.get(col.name);
              const isExpanded = expandedColumn === col.name;
              const stats = columnStatsMap[col.name];
              const isStatsLoading = loadingStatsColumn === col.name;

              return (
                <React.Fragment key={col.name}>
                  <tr
                    className={`file-overview-schema-row ${isSelected ? '' : 'file-overview-schema-row-deselected'} ${isExpanded ? 'file-overview-schema-row-expanded' : ''}`}
                  >
                    <td className="file-overview-schema-check">
                      <button
                        className="file-overview-checkbox-btn"
                        onClick={(e) => { e.stopPropagation(); toggleColumn(col.name); }}
                      >
                        {isSelected ? <CheckSquare size={14} /> : <Square size={14} />}
                      </button>
                    </td>
                    <td className="file-overview-schema-icon" onClick={() => handleToggleExpand(col.name)}>
                      <span className="column-type-icon"><Icon size={13} /></span>
                    </td>
                    <td className="file-overview-schema-name" onClick={() => handleToggleExpand(col.name)}>
                      <span className="file-overview-schema-name-inner">
                        <FuzzyHighlight text={col.name} indices={fuzzyPositions.get(col.name) ?? EMPTY_POSITIONS} />
                        <CopyButton
                          text={col.name}
                          title={`Copy "${col.name}"`}
                          className="file-overview-copy-btn"
                          size={12}
                        />
                      </span>
                    </td>
                    <td className="file-overview-schema-type" onClick={() => handleToggleExpand(col.name)}>{col.type}</td>
                    <td className="file-overview-schema-unique" onClick={() => handleToggleExpand(col.name)}>
                      {summariesLoading ? (
                        <span className="file-overview-skeleton" />
                      ) : summary ? (
                        summary.distinctCount.toLocaleString()
                      ) : '—'}
                    </td>
                    <td className="file-overview-schema-null" onClick={() => handleToggleExpand(col.name)}>
                      {summariesLoading ? (
                        <span className="file-overview-skeleton" />
                      ) : summary ? (
                        summary.nullPercent > 0 ? `${summary.nullPercent.toFixed(1)}%` : '—'
                      ) : '—'}
                    </td>
                    <td className="file-overview-schema-expand" onClick={() => handleToggleExpand(col.name)}>
                      <span className="file-overview-expand-icon">
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </span>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr className="file-overview-schema-details-row">
                      <td colSpan={7}>
                        <div className="column-row-details">
                          {isStatsLoading ? (
                            <div className="column-details-loading">
                              <div className="loading-spinner small" />
                              <span>Loading statistics...</span>
                            </div>
                          ) : statsError && !stats ? (
                            <div className="column-details-error">
                              <span className="error-icon">⚠</span>
                              <span>{statsError}</span>
                            </div>
                          ) : stats ? (
                            <ColumnDetails stats={stats} inferredType={summary?.inferredType || col.type} />
                          ) : (
                            <div className="column-details-loading">
                              <div className="loading-spinner small" />
                              <span>Loading statistics...</span>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
