import React from 'react';

/**
 * Renders a cell value with type-appropriate styling
 * Handles: null, boolean, number, date, object/JSON, and strings
 */
export function CellValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="null-value">NULL</span>;
  }
  
  if (typeof value === 'boolean') {
    return <span className="bool-value">{value ? 'true' : 'false'}</span>;
  }
  
  if (typeof value === 'number') {
    return <span className="num-value">{formatNumber(value)}</span>;
  }
  
  if (value instanceof Date) {
    return <span className="date-value">{value.toISOString()}</span>;
  }
  
  if (typeof value === 'object') {
    return <span className="json-value">{JSON.stringify(value)}</span>;
  }
  
  const strValue = String(value);
  const isTruncated = strValue.length > 100;
  
  return (
    <span className="str-value" title={isTruncated ? strValue : undefined}>
      {isTruncated ? strValue.slice(0, 100) + '…' : strValue}
    </span>
  );
}

/** Format number for display - integers as-is, floats to 6 decimal places */
function formatNumber(num: number): string {
  if (Number.isInteger(num)) return String(num);
  return String(Math.round(num * 1e6) / 1e6);
}
