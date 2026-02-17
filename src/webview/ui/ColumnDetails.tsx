import React, { useState } from 'react';
import type { ColumnStats } from '../types';
import { Histogram } from './Histogram';
import { TimeSeriesChart } from './TimeSeriesChart';
import { formatCount } from '../utils/format';

/**
 * Detailed column statistics view — shared between ColumnsPanel and FileOverview.
 * Shows stats grid, histograms, time series charts, and top values depending on type.
 */
export function ColumnDetails({ stats, inferredType }: { stats: ColumnStats; inferredType: string }) {
  const isNumeric = stats.type === 'numeric' && (stats.mean !== undefined || stats.quantiles !== undefined);
  const isDate = stats.type === 'date' && stats.timeseries;
  
  // Complex types: UUID, JSON, STRUCT, LIST, MAP, arrays (e.g., BIGINT[])
  const isComplexType = /^(UUID|JSON|STRUCT|LIST|MAP|ARRAY)/i.test(inferredType) || /\[\]$/.test(inferredType);
  
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
      
      {/* Top values for string/boolean columns (not complex types) */}
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
      
      <div className="stats-table">
        <div className="stats-table-header">Approx. Statistics</div>
        {statRows.map((row, idx) => (
          <div 
            key={idx}
            className={`stats-table-row ${highlightValue === row.value ? 'highlighted' : ''}`}
            onMouseEnter={() => {
              if (row.value !== undefined) {
                if ((row.label === '25th %' || row.label === '75th %') && iqrRange) {
                  setHighlightValue(row.value);
                  setHighlightRange(iqrRange);
                } 
                else if (row.label === 'Std Dev' && stats.mean !== undefined && stats.stddev !== undefined) {
                  setHighlightValue(null);
                  setHighlightRange([stats.mean - stats.stddev, stats.mean]);
                }
                else {
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

export function MiniTopValues({ data, total }: { data: { value: string; count: number; type: 'top_n' | 'other' }[]; total: number }) {
  const topItems = data.filter(d => d.type === 'top_n').slice(0, 10);
  const otherItem = data.find(d => d.type === 'other');
  const maxCount = Math.max(...topItems.map(d => d.count), otherItem?.count ?? 0);
  
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
