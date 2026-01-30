import React, { useState, useEffect, useRef, useMemo } from 'react';
import { X } from 'lucide-react';
import { ColumnFilter, FilterOperator, generateFilterId } from './FilterBar';

interface DistinctValue {
  value: string;
  count: number;
}

interface ColumnInfo {
  name: string;
  type: string;
}

interface ColumnFilterPopoverProps {
  column: string;
  columnType: string;
  columns?: ColumnInfo[];  // All available columns for selection
  distinctValues: DistinctValue[];
  cardinality: number;
  isLoading: boolean;
  onClose: () => void;
  onApply: (filter: ColumnFilter) => void;
  onColumnChange?: (column: string, columnType: string) => void;  // Called when user selects different column
  position: { top: number; left: number };
}

// Determine if type is numeric
function isNumericType(type: string): boolean {
  const numericTypes = ['INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'HUGEINT', 
    'DOUBLE', 'FLOAT', 'REAL', 'DECIMAL', 'NUMERIC', 'UBIGINT', 'UINTEGER', 
    'USMALLINT', 'UTINYINT', 'UHUGEINT'];
  return numericTypes.some(t => type.toUpperCase().includes(t));
}

// Determine if type is date/time
function isDateType(type: string): boolean {
  const dateTypes = ['DATE', 'TIMESTAMP', 'TIME', 'INTERVAL'];
  return dateTypes.some(t => type.toUpperCase().includes(t));
}

export function ColumnFilterPopover({
  column,
  columnType,
  columns,
  distinctValues,
  cardinality,
  isLoading,
  onClose,
  onApply,
  onColumnChange,
  position,
}: ColumnFilterPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedValues, setSelectedValues] = useState<Set<string>>(new Set());
  const [operator, setOperator] = useState<FilterOperator>('eq');
  const [textValue, setTextValue] = useState('');
  const [rangeMin, setRangeMin] = useState('');
  const [rangeMax, setRangeMax] = useState('');
  
  const isNumeric = isNumericType(columnType);
  const isDate = isDateType(columnType);
  const showMultiSelect = cardinality <= 100 && cardinality > 0;
  
  // Reset form when column changes
  const handleColumnChange = (newColumn: string) => {
    const colInfo = columns?.find(c => c.name === newColumn);
    if (colInfo && onColumnChange) {
      // Reset form state
      setSearchTerm('');
      setSelectedValues(new Set());
      setOperator('eq');
      setTextValue('');
      setRangeMin('');
      setRangeMax('');
      onColumnChange(newColumn, colInfo.type);
    }
  };
  
  // Close on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        onClose();
      }
    }
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);
  
  // Close on escape
  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);
  
  // Client-side filtering for multiselect (we already have all values)
  const filteredDistinctValues = useMemo(() => {
    if (!searchTerm.trim()) return distinctValues;
    const lower = searchTerm.toLowerCase();
    return distinctValues.filter(v => v.value.toLowerCase().includes(lower));
  }, [distinctValues, searchTerm]);
  
  const handleValueToggle = (value: string) => {
    const newSelected = new Set(selectedValues);
    if (newSelected.has(value)) {
      newSelected.delete(value);
    } else {
      newSelected.add(value);
    }
    setSelectedValues(newSelected);
  };
  
  const handleSelectAll = () => {
    setSelectedValues(new Set(filteredDistinctValues.map(v => v.value)));
  };
  
  const handleSelectNone = () => {
    setSelectedValues(new Set());
  };
  
  const handleApply = () => {
    // Multi-select mode
    if (showMultiSelect && selectedValues.size > 0) {
      onApply({
        id: generateFilterId(),
        column,
        operator: 'in',
        value: Array.from(selectedValues),
      });
      return;
    }
    
    // Range mode (between)
    if (rangeMin && rangeMax) {
      const min = isNumeric ? Number(rangeMin) : rangeMin;
      const max = isNumeric ? Number(rangeMax) : rangeMax;
      onApply({
        id: generateFilterId(),
        column,
        operator: 'between',
        value: [min, max],
      });
      return;
    }
    
    // Single value mode
    if (textValue || operator === 'is_null' || operator === 'is_not_null') {
      let value: string | number | null = textValue;
      if (isNumeric && textValue) {
        value = Number(textValue);
      }
      if (operator === 'is_null' || operator === 'is_not_null') {
        value = null;
      }
      
      onApply({
        id: generateFilterId(),
        column,
        operator,
        value,
      });
    }
  };
  
  const canApply = 
    selectedValues.size > 0 || 
    (rangeMin && rangeMax) || 
    textValue.trim() || 
    operator === 'is_null' || 
    operator === 'is_not_null';
  
  return (
    <div 
      ref={popoverRef}
      className="column-filter-popover"
      style={{ top: position.top, left: position.left }}
    >
      <div className="column-filter-header">
        {columns && columns.length > 1 ? (
          <div className="column-filter-title-select">
            <span className="column-filter-label">Filter:</span>
            <select 
              className="column-filter-column-select"
              value={column}
              onChange={(e) => handleColumnChange(e.target.value)}
            >
              {columns.map((col) => (
                <option key={col.name} value={col.name}>{col.name}</option>
              ))}
            </select>
          </div>
        ) : (
          <span className="column-filter-title">Filter: {column}</span>
        )}
        <button className="column-filter-close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      
      <div className="column-filter-body">
        {/* Multi-select for low cardinality columns */}
        {showMultiSelect && (
          <div className="column-filter-section">
            <div className="column-filter-search-wrapper">
              <input
                type="text"
                className="column-filter-search"
                placeholder="Search values..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            
            <div className="column-filter-select-actions">
              <button 
                className="column-filter-select-btn" 
                onClick={handleSelectAll}
              >
                All
              </button>
              <button 
                className="column-filter-select-btn" 
                onClick={handleSelectNone}
              >
                None
              </button>
            </div>
            
            <div className="column-filter-values">
              {isLoading ? (
                <div className="column-filter-loading">Loading...</div>
              ) : filteredDistinctValues.length === 0 ? (
                <div className="column-filter-empty">{searchTerm ? 'No matching values' : 'No values found'}</div>
              ) : (
                filteredDistinctValues.map((item) => (
                  <label key={item.value} className="column-filter-value-item">
                    <input
                      type="checkbox"
                      checked={selectedValues.has(item.value)}
                      onChange={() => handleValueToggle(item.value)}
                    />
                    <span className="column-filter-value-label" title={item.value}>
                      {item.value}
                    </span>
                    <span className="column-filter-value-count">
                      {item.count.toLocaleString()}
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>
        )}
        
        {/* Comparison operators */}
        <div className="column-filter-section">
          <div className="column-filter-section-title">
            {showMultiSelect ? 'Or filter by' : 'Filter by'}
          </div>
          
          {/* Operator select */}
          <select 
            className="column-filter-operator"
            value={operator}
            onChange={(e) => setOperator(e.target.value as FilterOperator)}
          >
            <option value="eq">Equals</option>
            <option value="neq">Not equals</option>
            {!isDate && <option value="contains">Contains</option>}
            {!isDate && <option value="starts_with">Starts with</option>}
            {!isDate && <option value="ends_with">Ends with</option>}
            {(isNumeric || isDate) && <option value="gt">Greater than</option>}
            {(isNumeric || isDate) && <option value="gte">Greater or equal</option>}
            {(isNumeric || isDate) && <option value="lt">Less than</option>}
            {(isNumeric || isDate) && <option value="lte">Less or equal</option>}
          </select>
          
          {/* Value input */}
          {operator !== 'is_null' && operator !== 'is_not_null' && (
            <input
              type={isNumeric ? 'number' : isDate ? 'date' : 'text'}
              className="column-filter-input"
              placeholder={isDate ? '' : 'Enter value...'}
              value={textValue}
              onChange={(e) => setTextValue(e.target.value)}
            />
          )}
        </div>
        
        {/* Range filter for numeric/date */}
        {(isNumeric || isDate) && (
          <div className="column-filter-section">
            <div className="column-filter-section-title">Range</div>
            <div className="column-filter-range">
              <input
                type={isNumeric ? 'number' : 'date'}
                className="column-filter-range-input"
                placeholder="Min"
                value={rangeMin}
                onChange={(e) => setRangeMin(e.target.value)}
              />
              <span className="column-filter-range-sep">–</span>
              <input
                type={isNumeric ? 'number' : 'date'}
                className="column-filter-range-input"
                placeholder="Max"
                value={rangeMax}
                onChange={(e) => setRangeMax(e.target.value)}
              />
            </div>
          </div>
        )}
        
        {/* Null filters */}
        <div className="column-filter-section">
          <div className="column-filter-quick">
            <button
              className={`column-filter-quick-btn ${operator === 'is_null' ? 'active' : ''}`}
              onClick={() => setOperator(operator === 'is_null' ? 'eq' : 'is_null')}
            >
              Is NULL
            </button>
            <button
              className={`column-filter-quick-btn ${operator === 'is_not_null' ? 'active' : ''}`}
              onClick={() => setOperator(operator === 'is_not_null' ? 'eq' : 'is_not_null')}
            >
              Not NULL
            </button>
          </div>
        </div>
      </div>
      
      <div className="column-filter-footer">
        <button className="column-filter-cancel-btn" onClick={onClose}>
          Cancel
        </button>
        <button 
          className="column-filter-apply-btn" 
          onClick={handleApply}
          disabled={!canApply}
        >
          Apply
        </button>
      </div>
    </div>
  );
}
