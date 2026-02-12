import React, { useState, useMemo } from 'react';
import { formatCount } from '../utils/format';

export interface TimeSeriesBin {
  date: string;  // ISO date string or date bucket label
  count: number;
}

export interface TimeSeriesData {
  bins: TimeSeriesBin[];
  minDate: string;
  maxDate: string;
  granularity: 'day' | 'week' | 'month' | 'quarter' | 'year';
  totalCount: number;
}

interface TimeSeriesChartProps {
  data: TimeSeriesData;
}

// Calculate the human-readable duration span
function formatDurationSpan(minDate: string, maxDate: string): string {
  const start = new Date(minDate);
  const end = new Date(maxDate);
  const diffMs = end.getTime() - start.getTime();
  
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  const diffWeeks = diffDays / 7;
  const diffMonths = diffDays / 30.44; // Average month
  const diffYears = diffDays / 365.25;
  
  if (diffYears >= 1) {
    return diffYears >= 10 
      ? `${Math.round(diffYears)} years`
      : `${diffYears.toFixed(1)} years`;
  }
  if (diffMonths >= 1) {
    return diffMonths >= 10
      ? `${Math.round(diffMonths)} months`
      : `${diffMonths.toFixed(1)} months`;
  }
  if (diffWeeks >= 1) {
    return diffWeeks >= 10
      ? `${Math.round(diffWeeks)} weeks`
      : `${diffWeeks.toFixed(1)} weeks`;
  }
  return diffDays >= 10
    ? `${Math.round(diffDays)} days`
    : `${diffDays.toFixed(1)} days`;
}

// Format date for display based on granularity
function formatDateLabel(dateStr: string, granularity: string): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  
  switch (granularity) {
    case 'year':
      return date.getFullYear().toString();
    case 'quarter':
      return `Q${Math.floor(date.getMonth() / 3) + 1} ${date.getFullYear()}`;
    case 'month':
      return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    case 'week':
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    case 'day':
    default:
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
}

// Format full date for earliest/latest display
function formatDateFull(dateStr: string): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  return date.toLocaleDateString('en-US', { 
    year: 'numeric', 
    month: 'short', 
    day: 'numeric' 
  });
}

export function TimeSeriesChart({ data }: TimeSeriesChartProps) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [highlightedBucket, setHighlightedBucket] = useState<string | null>(null);
  
  const { bins, minDate, maxDate, granularity, totalCount } = data;
  
  // Filter valid bins and compute max
  const validBins = useMemo(() => 
    bins.filter(b => b.count != null && !isNaN(b.count)),
    [bins]
  );
  
  const maxCount = useMemo(() => 
    Math.max(...validBins.map(b => b.count), 1),
    [validBins]
  );
  
  // Find min and max buckets
  const { minBucket, maxBucket } = useMemo(() => {
    if (validBins.length === 0) return { minBucket: null, maxBucket: null };
    let minB = validBins[0];
    let maxB = validBins[0];
    for (const bin of validBins) {
      if (bin.count < minB.count) minB = bin;
      if (bin.count > maxB.count) maxB = bin;
    }
    return { minBucket: minB, maxBucket: maxB };
  }, [validBins]);
  
  if (validBins.length === 0) return null;
  
  // Determine display mode based on number of bins
  // For many bins, use area chart; for fewer, use bars
  const useAreaChart = validBins.length > 50;
  const displayBins = useAreaChart ? validBins : validBins.slice(0, 100);
  
  // Calculate duration span
  const durationSpan = formatDurationSpan(minDate, maxDate);
  
  // Get hovered bin data
  const hoveredBin = hoveredIdx !== null ? displayBins[hoveredIdx] : null;
  
  // Generate SVG path for area chart
  const areaPath = useMemo(() => {
    if (!useAreaChart || displayBins.length === 0) return '';
    
    const width = 100;
    const height = 100;
    const points: string[] = [];
    
    // Start at bottom left
    points.push(`M 0 ${height}`);
    
    // Draw line through all points
    displayBins.forEach((bin, idx) => {
      const x = (idx / (displayBins.length - 1)) * width;
      const y = height - (bin.count / maxCount) * height;
      points.push(`L ${x} ${y}`);
    });
    
    // Close path at bottom right
    points.push(`L ${width} ${height}`);
    points.push('Z');
    
    return points.join(' ');
  }, [useAreaChart, displayBins, maxCount]);
  
  // Generate line path for stroke
  const linePath = useMemo(() => {
    if (!useAreaChart || displayBins.length === 0) return '';
    
    const width = 100;
    const height = 100;
    const points: string[] = [];
    
    displayBins.forEach((bin, idx) => {
      const x = (idx / (displayBins.length - 1)) * width;
      const y = height - (bin.count / maxCount) * height;
      points.push(idx === 0 ? `M ${x} ${y}` : `L ${x} ${y}`);
    });
    
    return points.join(' ');
  }, [useAreaChart, displayBins, maxCount]);

  return (
    <div className="timeseries-chart">
      {/* Header with duration span */}
      <div className="timeseries-header">
        <span className="timeseries-title">Time Distribution</span>
        <span className="timeseries-span">{durationSpan}</span>
      </div>
      
      {/* Chart body with y-axis and chart area */}
      <div className="timeseries-body">
        {/* Y-axis labels */}
        <div className="timeseries-y-labels">
          <span className="timeseries-y-max">{formatCount(maxCount)}</span>
          <span className="timeseries-y-mid">{formatCount(Math.round(maxCount / 2))}</span>
          <span className="timeseries-y-zero">0</span>
        </div>
        
        {/* Chart area */}
        <div className="timeseries-chart-area">
        {useAreaChart ? (
          /* Area chart for dense data */
          <div className="timeseries-area-container">
            <svg 
              viewBox="0 0 100 100" 
              preserveAspectRatio="none"
              className="timeseries-svg"
            >
              {/* Gradient fill */}
              <defs>
                <linearGradient id="timeseriesGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="var(--accent-cyan)" stopOpacity="0.4" />
                  <stop offset="100%" stopColor="var(--accent-cyan)" stopOpacity="0.05" />
                </linearGradient>
              </defs>
              
              {/* Area fill */}
              <path 
                d={areaPath} 
                fill="url(#timeseriesGradient)"
                className="timeseries-area"
              />
              
              {/* Line stroke */}
              <path 
                d={linePath} 
                fill="none"
                stroke="var(--accent-cyan)"
                strokeWidth="0.5"
                vectorEffect="non-scaling-stroke"
                className="timeseries-line"
              />
            </svg>
            
            {/* Invisible hover zones */}
            <div className="timeseries-hover-zones">
              {displayBins.map((bin, idx) => (
                <div
                  key={idx}
                  className="timeseries-hover-zone"
                  style={{ left: `${(idx / displayBins.length) * 100}%`, width: `${100 / displayBins.length}%` }}
                  onMouseEnter={() => setHoveredIdx(idx)}
                  onMouseLeave={() => setHoveredIdx(null)}
                />
              ))}
            </div>
            
            {/* Hover indicator line */}
            {hoveredIdx !== null && (
              <div 
                className="timeseries-hover-line"
                style={{ left: `${(hoveredIdx / (displayBins.length - 1)) * 100}%` }}
              />
            )}
          </div>
        ) : (
          /* Bar chart for sparse data */
          <div className="timeseries-bars">
            {displayBins.map((bin, idx) => (
              <div 
                key={idx}
                className={`timeseries-bar-wrapper ${hoveredIdx === idx ? 'hovered' : ''}`}
                onMouseEnter={() => setHoveredIdx(idx)}
                onMouseLeave={() => setHoveredIdx(null)}
              >
                <div 
                  className="timeseries-bar"
                  style={{ height: `${(bin.count / maxCount) * 100}%` }}
                />
              </div>
            ))}
          </div>
        )}
        
        {/* Tooltip */}
        {hoveredBin && hoveredIdx !== null && (
          <div 
            className="timeseries-tooltip"
            style={{ 
              left: useAreaChart 
                ? `${(hoveredIdx / (displayBins.length - 1)) * 100}%`
                : `${((hoveredIdx + 0.5) / displayBins.length) * 100}%`
            }}
          >
            <div className="timeseries-tooltip-value">{hoveredBin.count.toLocaleString()}</div>
            <div className="timeseries-tooltip-label">{formatDateLabel(hoveredBin.date, granularity)}</div>
          </div>
        )}
        
        {/* X-axis */}
        <div className="timeseries-x-axis">
          <span className="timeseries-x-label">{formatDateLabel(minDate, granularity)}</span>
          <span className="timeseries-x-label">{formatDateLabel(maxDate, granularity)}</span>
        </div>
      </div>
      </div>
      
      {/* Stats table */}
      <div className="timeseries-stats-table">
        <div className="timeseries-stats-row">
          <span className="timeseries-stats-label">Bucketed by</span>
          <span className="timeseries-stats-value">{granularity}</span>
        </div>
        <div className="timeseries-stats-row">
          <span className="timeseries-stats-label">Earliest</span>
          <span className="timeseries-stats-value">{formatDateFull(minDate)}</span>
        </div>
        <div className="timeseries-stats-row">
          <span className="timeseries-stats-label">Latest</span>
          <span className="timeseries-stats-value">{formatDateFull(maxDate)}</span>
        </div>
        {minBucket && (
          <div 
            className={`timeseries-stats-row hoverable ${highlightedBucket === minBucket.date ? 'highlighted' : ''}`}
            onMouseEnter={() => setHighlightedBucket(minBucket.date)}
            onMouseLeave={() => setHighlightedBucket(null)}
          >
            <span className="timeseries-stats-label">Low {granularity}</span>
            <span className="timeseries-stats-value">
              {formatCount(minBucket.count)} <span className="timeseries-stats-date">({formatDateLabel(minBucket.date, granularity)})</span>
            </span>
          </div>
        )}
        {maxBucket && (
          <div 
            className={`timeseries-stats-row hoverable ${highlightedBucket === maxBucket.date ? 'highlighted' : ''}`}
            onMouseEnter={() => setHighlightedBucket(maxBucket.date)}
            onMouseLeave={() => setHighlightedBucket(null)}
          >
            <span className="timeseries-stats-label">High {granularity}</span>
            <span className="timeseries-stats-value">
              {formatCount(maxBucket.count)} <span className="timeseries-stats-date">({formatDateLabel(maxBucket.date, granularity)})</span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Compact mini timeseries for inline display
 */
export function MiniTimeSeries({ data }: { data: TimeSeriesData }) {
  const { bins, minDate, maxDate } = data;
  
  const validBins = bins.filter(b => b.count != null && !isNaN(b.count));
  if (validBins.length === 0) return null;
  
  const maxCount = Math.max(...validBins.map(b => b.count), 1);
  const durationSpan = formatDurationSpan(minDate, maxDate);
  
  // For mini display, compress to max 30 points
  const step = Math.max(1, Math.floor(validBins.length / 30));
  const compressedBins = validBins.filter((_, i) => i % step === 0);
  
  return (
    <div className="mini-timeseries">
      <div className="mini-timeseries-chart">
        {compressedBins.map((bin, idx) => (
          <div
            key={idx}
            className="mini-timeseries-bar"
            style={{ height: `${(bin.count / maxCount) * 100}%` }}
            title={`${bin.date}: ${bin.count.toLocaleString()}`}
          />
        ))}
      </div>
      <span className="mini-timeseries-span">{durationSpan}</span>
    </div>
  );
}
