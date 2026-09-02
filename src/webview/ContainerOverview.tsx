import React, { useState, useCallback } from 'react';
import type { ContainerOverviewMetadata, ContainerTableInfo } from './types';
import { formatCount } from './utils/format';
import { getTypeIcon } from './utils/typeIcons';
import {
  ChevronDown, ChevronRight, FileText, Play, Table,
} from 'lucide-react';
import './styles.css';

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
    xlsx: 'XLSX',
    xls: 'XLS',
    db: 'DB',
    duckdb: 'DUCKDB',
    sqlite: 'SQLITE',
  };
  return map[fileType.toLowerCase()] || fileType.toUpperCase();
}

interface ContainerOverviewProps {
  metadata: ContainerOverviewMetadata;
}

export function ContainerOverview({ metadata }: ContainerOverviewProps) {
  const { displayName, fileType, fileSize, tables } = metadata;
  const [expandedTable, setExpandedTable] = useState<string | null>(null);

  const totalRows = tables.reduce((sum, t) => sum + t.rowCount, 0);
  // Workbooks hold sheets; database files hold tables and views.
  const isWorkbook = fileType.toLowerCase() === 'xlsx' || fileType.toLowerCase() === 'xls';
  const entityLabel = isWorkbook
    ? (tables.length === 1 ? 'sheet' : 'sheets')
    : (tables.length === 1 ? 'table' : 'tables');

  const handleOpenTable = useCallback((tableId: string) => {
    const vscode = getVscodeApi();
    vscode.postMessage({ type: 'openTable', tableId });
  }, []);

  const handleToggleExpand = useCallback((tableId: string) => {
    setExpandedTable(prev => prev === tableId ? null : tableId);
  }, []);

  return (
    <div className="file-overview">
      {/* Header */}
      <div className="file-overview-header">
        <div className="file-overview-title">
          <FileText size={16} />
          <span className="file-overview-name">{displayName}</span>
          <span className="file-overview-badge">{getFileTypeBadge(fileType)}</span>
        </div>
        <div className="file-overview-stats">
          <span className="file-overview-stat">
            {tables.length} {entityLabel}
          </span>
          <span className="file-overview-stat-sep">&middot;</span>
          <span className="file-overview-stat">
            {totalRows.toLocaleString()} total rows
          </span>
          <span className="file-overview-stat-sep">&middot;</span>
          <span className="file-overview-stat">
            {formatFileSize(fileSize)}
          </span>
        </div>
      </div>

      {/* Sheet list */}
      <div className="container-overview-list">
        {tables.map((table) => (
          <SheetCard
            key={table.id}
            table={table}
            isExpanded={expandedTable === table.id}
            onToggleExpand={() => handleToggleExpand(table.id)}
            onOpen={() => handleOpenTable(table.id)}
          />
        ))}
      </div>
    </div>
  );
}

interface SheetCardProps {
  table: ContainerTableInfo;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onOpen: () => void;
}

function SheetCard({ table, isExpanded, onToggleExpand, onOpen }: SheetCardProps) {
  return (
    <div className={`container-sheet-card ${isExpanded ? 'container-sheet-card-expanded' : ''}`}>
      <div className="container-sheet-header" onClick={onToggleExpand}>
        <span className="container-sheet-chevron">
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <Table size={14} className="container-sheet-icon" />
        <span className="container-sheet-name">{table.name}</span>
        <span className="container-sheet-meta">
          {formatCount(table.rowCount)} rows &middot; {table.columnCount} cols
        </span>
        <button
          className="btn btn-primary container-sheet-open-btn"
          onClick={(e) => { e.stopPropagation(); onOpen(); }}
          title={`Open "${table.name}" in data viewer`}
        >
          <Play size={11} />
          Open
        </button>
      </div>

      {isExpanded && (
        <div className="container-sheet-columns">
          <table className="file-overview-schema-table">
            <thead>
              <tr>
                <th className="file-overview-schema-icon"></th>
                <th className="file-overview-schema-name">Column</th>
                <th className="file-overview-schema-type">Type</th>
              </tr>
            </thead>
            <tbody>
              {table.columns.map((col) => {
                const Icon = getTypeIcon(col.type);
                return (
                  <tr key={col.name} className="file-overview-schema-row">
                    <td className="file-overview-schema-icon">
                      <span className="column-type-icon"><Icon size={13} /></span>
                    </td>
                    <td className="file-overview-schema-name">
                      <span className="file-overview-schema-name-inner">
                        <span>{col.name}</span>
                      </span>
                    </td>
                    <td className="file-overview-schema-type">{col.type}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
