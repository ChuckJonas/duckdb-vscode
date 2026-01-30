import React from 'react';
import { X, Filter, Play, Pause, Plus } from 'lucide-react';

// ============================================================================
// FILTER TYPES
// ============================================================================

export type FilterOperator = 
  | 'eq' | 'neq' 
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'starts_with' | 'ends_with'
  | 'in' | 'not_in'
  | 'between'
  | 'is_null' | 'is_not_null';

export interface ColumnFilter {
  id: string;
  column: string;
  operator: FilterOperator;
  value: string | number | string[] | [number, number] | [string, string] | null;
}

export interface FilterState {
  filters: ColumnFilter[];
  isPaused: boolean;
}

// ============================================================================
// FILTER UTILITIES
// ============================================================================

const OPERATOR_LABELS: Record<FilterOperator, string> = {
  'eq': '=',
  'neq': '≠',
  'gt': '>',
  'gte': '≥',
  'lt': '<',
  'lte': '≤',
  'contains': 'contains',
  'starts_with': 'starts with',
  'ends_with': 'ends with',
  'in': 'in',
  'not_in': 'not in',
  'between': 'between',
  'is_null': 'is null',
  'is_not_null': 'is not null',
};

export function formatFilterValue(filter: ColumnFilter): string {
  const { operator, value } = filter;
  
  if (operator === 'is_null' || operator === 'is_not_null') {
    return OPERATOR_LABELS[operator];
  }
  
  if (operator === 'in' || operator === 'not_in') {
    const values = value as string[];
    if (values.length <= 3) {
      return `${OPERATOR_LABELS[operator]} (${values.join(', ')})`;
    }
    return `${OPERATOR_LABELS[operator]} (${values.length} values)`;
  }
  
  if (operator === 'between') {
    const [min, max] = value as [number | string, number | string];
    return `${min} – ${max}`;
  }
  
  return `${OPERATOR_LABELS[operator]} ${value}`;
}

export function filterToSql(filter: ColumnFilter): string {
  const col = `"${filter.column}"`;
  const { operator, value } = filter;
  
  switch (operator) {
    case 'eq':
      return typeof value === 'string' 
        ? `${col} = '${escapeSqlString(value)}'`
        : `${col} = ${value}`;
    case 'neq':
      return typeof value === 'string'
        ? `${col} != '${escapeSqlString(value)}'`
        : `${col} != ${value}`;
    case 'gt':
      return `${col} > ${formatSqlValue(value)}`;
    case 'gte':
      return `${col} >= ${formatSqlValue(value)}`;
    case 'lt':
      return `${col} < ${formatSqlValue(value)}`;
    case 'lte':
      return `${col} <= ${formatSqlValue(value)}`;
    case 'contains':
      return `${col} ILIKE '%${escapeSqlString(String(value))}%'`;
    case 'starts_with':
      return `${col} ILIKE '${escapeSqlString(String(value))}%'`;
    case 'ends_with':
      return `${col} ILIKE '%${escapeSqlString(String(value))}'`;
    case 'in': {
      const values = (value as string[]).map(v => `'${escapeSqlString(v)}'`).join(', ');
      return `${col} IN (${values})`;
    }
    case 'not_in': {
      const values = (value as string[]).map(v => `'${escapeSqlString(v)}'`).join(', ');
      return `${col} NOT IN (${values})`;
    }
    case 'between': {
      const [min, max] = value as [number | string, number | string];
      return `${col} BETWEEN ${formatSqlValue(min)} AND ${formatSqlValue(max)}`;
    }
    case 'is_null':
      return `${col} IS NULL`;
    case 'is_not_null':
      return `${col} IS NOT NULL`;
    default:
      return '';
  }
}

export function filtersToWhereClause(filters: ColumnFilter[]): string {
  if (filters.length === 0) return '';
  return filters.map(filterToSql).filter(Boolean).join(' AND ');
}

function escapeSqlString(str: string): string {
  return str.replace(/'/g, "''");
}

function formatSqlValue(value: unknown): string {
  if (typeof value === 'string') {
    // Check if it looks like a date
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
      return `'${value}'`;
    }
    return `'${escapeSqlString(value)}'`;
  }
  return String(value);
}

// ============================================================================
// FILTER BAR COMPONENT
// ============================================================================

interface FilterBarProps {
  filterState: FilterState;
  onRemoveFilter: (filterId: string) => void;
  onClearAll: () => void;
  onTogglePause: () => void;
  onAddFilter: () => void;
}

export function FilterBar({
  filterState,
  onRemoveFilter,
  onClearAll,
  onTogglePause,
  onAddFilter,
}: FilterBarProps) {
  const { filters, isPaused } = filterState;
  const hasFilters = filters.length > 0;
  
  if (!hasFilters) {
    // Collapsed state - just show add filter button
    return (
      <div className="filter-bar collapsed">
        <button className="filter-add-btn" onClick={onAddFilter}>
          <Filter size={14} />
          <span>Add Filter</span>
        </button>
      </div>
    );
  }
  
  return (
    <div className={`filter-bar ${isPaused ? 'paused' : ''}`}>
      <div className="filter-bar-left">
        <Filter size={14} className="filter-icon" />
        
        {/* Visual filter chips */}
        <div className="filter-chips">
          {filters.map((filter) => (
            <div key={filter.id} className="filter-chip">
              <span className="filter-chip-column">{filter.column}</span>
              <span className="filter-chip-value">{formatFilterValue(filter)}</span>
              <button 
                className="filter-chip-remove" 
                onClick={() => onRemoveFilter(filter.id)}
                title="Remove filter"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        
        <button className="filter-add-btn small" onClick={onAddFilter}>
          <Plus size={12} />
        </button>
      </div>
      
      <div className="filter-bar-right">
        {/* Pause toggle */}
        <button 
          className={`filter-pause-btn ${isPaused ? 'paused' : ''}`}
          onClick={onTogglePause}
          title={isPaused ? 'Resume filters' : 'Pause filters'}
        >
          {isPaused ? <Play size={14} /> : <Pause size={14} />}
        </button>
        
        {/* Clear all */}
        <button className="filter-clear-btn" onClick={onClearAll} title="Clear all filters">
          Clear
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// INITIAL STATE HELPER
// ============================================================================

export function createInitialFilterState(): FilterState {
  return {
    filters: [],
    isPaused: false,
  };
}

export function generateFilterId(): string {
  return `filter-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
