import React, { useState, useCallback, useEffect, useMemo } from 'react';
import type { 
  MultiQueryResultWithPages, 
  StatementCacheMeta, 
  PageData 
} from './types';
import { ResultsTable } from './ResultsTable';
import { Toggle } from './ui/Toggle';
import { RefreshCw } from 'lucide-react';

// Get VS Code API (exposed globally from index.tsx)
function getVscodeApi() {
  return (window as unknown as { vscodeApi: { postMessage: (msg: unknown) => void } }).vscodeApi;
}

interface QueryPanelProps {
  result: MultiQueryResultWithPages;
  pageSize: number;
  maxCopyRows: number;
}

/**
 * QueryPanel - Top-level component for displaying query results
 * Handles the distinction between single and multi-statement results
 */
export function QueryPanel({ result, pageSize, maxCopyRows }: QueryPanelProps) {
  // For multi-statement with more than one statement, render collapsible container
  if (result.statements.length > 1) {
    return (
      <MultiStatementContainer 
        statements={result.statements}
        totalExecutionTime={result.totalExecutionTime}
        pageSize={pageSize}
        maxCopyRows={maxCopyRows}
      />
    );
  }
  
  // Single statement - render directly (always expanded, not collapsible)
  const stmt = result.statements[0];
  if (!stmt) {
    return <div className="empty-state">No results</div>;
  }
  
  return (
    <ResultsTable
      meta={stmt.meta}
      initialPage={stmt.page}
      pageSize={pageSize}
      maxCopyRows={maxCopyRows}
      hasResults={stmt.meta.hasResults}
      isCollapsible={false}
      isExpanded={true}
    />
  );
}

// ============================================================================
// MULTI-STATEMENT CONTAINER - Manages collapse state for multiple statements
// ============================================================================

interface MultiStatementContainerProps {
  statements: Array<{ meta: StatementCacheMeta; page: PageData }>;
  totalExecutionTime: number;
  pageSize: number;
  maxCopyRows: number;
}

function MultiStatementContainer({ 
  statements, 
  totalExecutionTime,
  pageSize,
  maxCopyRows,
}: MultiStatementContainerProps) {
  // Refresh state
  const [isRefreshing, setIsRefreshing] = useState(false);

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

  // Reset refresh state when statements change (new results arrived)
  useEffect(() => {
    setIsRefreshing(false);
  }, [statements]);

  // Track which statements are expanded (by statementIndex)
  const [expandedSet, setExpandedSet] = useState<Set<number>>(() => {
    // Default: expand the last statement with results
    const withResults = statements.filter(s => s.meta.hasResults);
    if (withResults.length > 0) {
      return new Set([withResults[withResults.length - 1].meta.statementIndex]);
    }
    return new Set();
  });

  // Toggle for showing/hiding non-result statements (DDL/DML)
  const [showAllStatements, setShowAllStatements] = useState(false);

  // Reset when statements change
  useEffect(() => {
    const withResults = statements.filter(s => s.meta.hasResults);
    if (withResults.length > 0) {
      setExpandedSet(new Set([withResults[withResults.length - 1].meta.statementIndex]));
    } else {
      setExpandedSet(new Set());
    }
  }, [statements]);

  const toggleStatement = useCallback((statementIndex: number) => {
    setExpandedSet(prev => {
      const next = new Set(prev);
      if (next.has(statementIndex)) {
        next.delete(statementIndex);
      } else {
        next.add(statementIndex);
      }
      return next;
    });
  }, []);

  // Filter statements based on toggle
  const statementsWithResults = useMemo(() => 
    statements.filter(s => s.meta.hasResults), [statements]);
  const statementsWithoutResults = useMemo(() => 
    statements.filter(s => !s.meta.hasResults), [statements]);
  
  const visibleStatements = useMemo(() => 
    showAllStatements ? statements : statementsWithResults,
    [showAllStatements, statements, statementsWithResults]
  );

  const expandAll = useCallback(() => {
    setExpandedSet(new Set(visibleStatements.map(s => s.meta.statementIndex)));
  }, [visibleStatements]);

  const collapseAll = useCallback(() => {
    setExpandedSet(new Set());
  }, []);

  // Only show toggle if there are statements without results
  const hasNonResultStatements = statementsWithoutResults.length > 0;

  return (
    <div className="multi-results-container">
      {/* Header with expand/collapse all */}
      <div className="panel-header multi-results-header">
        <div className="multi-results-info">
          <span className="multi-results-count">
            {showAllStatements || !hasNonResultStatements
              ? `${statements.length} statements`
              : `${statementsWithResults.length}/${statements.length} statements`
            }
          </span>
          <span className="multi-results-time">
            {totalExecutionTime.toFixed(1)}ms
          </span>
        </div>
        <div className="multi-results-actions">
          {hasNonResultStatements && (
            <Toggle
              checked={showAllStatements}
              onChange={setShowAllStatements}
              label="DDL/DML"
            />
          )}
          <button className="btn btn-surface multi-results-btn" onClick={expandAll}>Expand All</button>
          <button className="btn btn-surface multi-results-btn" onClick={collapseAll}>Collapse All</button>
          <button
            className={`refresh-btn ${isRefreshing ? 'refreshing' : ''}`}
            onClick={handleRefresh}
            disabled={isRefreshing}
            title="Re-run all queries"
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {/* Statements */}
      <div className="multi-results-statements">
        {visibleStatements.map((stmt, idx) => (
          <ResultsTable
            key={stmt.meta.statementIndex}
            meta={stmt.meta}
            initialPage={stmt.page}
            pageSize={pageSize}
            maxCopyRows={maxCopyRows}
            hasResults={stmt.meta.hasResults}
            statementIndex={idx}
            totalStatements={visibleStatements.length}
            isCollapsible={true}
            isExpanded={expandedSet.has(stmt.meta.statementIndex)}
            onToggleExpand={() => toggleStatement(stmt.meta.statementIndex)}
          />
        ))}
      </div>
    </div>
  );
}
