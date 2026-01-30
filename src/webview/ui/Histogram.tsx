import React, { useState } from 'react';

export interface HistogramBin {
  bucket: string;
  count: number;
}

interface HistogramProps {
  data: HistogramBin[];
  highlightValue?: number | null;
  highlightRange?: [number, number] | null;
  dataMin?: number;
  dataMax?: number;
}

export function Histogram({ data, highlightValue, highlightRange, dataMin, dataMax }: HistogramProps) {
  const [tooltip, setTooltip] = useState<{ bucket: string; count: number; x: number; y: number } | null>(null);
  // Filter and validate data
  const validData = data.filter(d => d.count != null && !isNaN(d.count));
  if (validData.length === 0) return null;
  
  const maxCount = Math.max(...validData.map(d => d.count));
  if (maxCount === 0) return null;
  
  // Limit to reasonable number of bars
  const displayData = validData.slice(0, 20);
  
  // Format bucket label for display
  const formatBucket = (bucket: string): string => {
    // Handle range format "min-max"
    if (bucket.includes('-')) {
      const parts = bucket.split('-');
      if (parts.length >= 2) {
        // Handle negative numbers: could be "start-end" or "-5-10" or "-5--2"
        let start: string, end: string;
        if (bucket.startsWith('-')) {
          // Starts with negative
          if (parts.length === 3) {
            // "-5-10" -> ["-5", "10"]
            start = '-' + parts[1];
            end = parts[2];
          } else if (parts.length === 4) {
            // "-5--2" -> ["-5", "-2"]
            start = '-' + parts[1];
            end = '-' + parts[3];
          } else {
            start = parts[0];
            end = parts[1];
          }
        } else {
          start = parts[0];
          end = parts.slice(1).join('-'); // Handle negative end
        }
        
        const startNum = parseFloat(start);
        const endNum = parseFloat(end);
        
        if (!isNaN(startNum)) {
          return formatNumber(startNum);
        }
      }
    }
    
    const num = parseFloat(bucket);
    if (!isNaN(num)) {
      return formatNumber(num);
    }
    // Truncate long strings
    return bucket.length > 8 ? bucket.slice(0, 6) + '…' : bucket;
  };
  
  // Format a number for axis labels (2 decimal places)
  const formatNumber = (num: number): string => {
    if (Math.abs(num) >= 1000000) {
      return (num / 1000000).toFixed(2) + 'M';
    }
    if (Math.abs(num) >= 1000) {
      return (num / 1000).toFixed(2) + 'K';
    }
    return num.toFixed(2);
  };
  
  // Get start value from bucket range "start-end"
  const formatBucketStart = (bucket: string): string => {
    const parts = bucket.split('-');
    if (parts.length >= 2) {
      // Handle negative numbers
      let start = bucket.startsWith('-') ? '-' + parts[1] : parts[0];
      const num = parseFloat(start);
      if (!isNaN(num)) return formatNumber(num);
    }
    return bucket;
  };
  
  // Get end value from bucket range "start-end"  
  const formatBucketEnd = (bucket: string): string => {
    const num = parseBucketEnd(bucket);
    if (num !== null) return formatNumber(num);
    return bucket;
  };
  
  // Parse start value from bucket as number
  const parseBucketStart = (bucket: string): number | null => {
    const parts = bucket.split('-');
    if (parts.length >= 2) {
      let start = bucket.startsWith('-') ? '-' + parts[1] : parts[0];
      const num = parseFloat(start);
      if (!isNaN(num)) return num;
    }
    return null;
  };
  
  // Parse end value from bucket as number
  const parseBucketEnd = (bucket: string): number | null => {
    const parts = bucket.split('-');
    if (parts.length >= 2) {
      const end = parts[parts.length - 1];
      const num = parseFloat(end);
      if (!isNaN(num)) return num;
    }
    return null;
  };
  
  // Format count for display
  const formatCount = (count: number): string => {
    if (count >= 1000000) {
      return (count / 1000000).toFixed(1) + 'M';
    }
    if (count >= 1000) {
      return (count / 1000).toFixed(1) + 'K';
    }
    return count.toString();
  };
  
  return (
    <div className="histogram-chart">
      {/* Y-axis labels */}
      <div className="histogram-y-labels">
        <span className="histogram-y-max">{formatCount(maxCount)}</span>
        <span className="histogram-y-mid">{formatCount(Math.round(maxCount / 2))}</span>
        <span className="histogram-y-zero">0</span>
      </div>
      
      {/* Chart area */}
      <div className="histogram-chart-area">
        {/* Bars */}
        <div className="histogram-bars">
          {displayData.map((item, idx) => (
            <div 
              key={idx} 
              className={`histogram-bar-wrapper ${tooltip?.bucket === item.bucket ? 'hovered' : ''}`}
              onMouseEnter={() => setTooltip({ bucket: item.bucket, count: item.count, x: 0, y: 0 })}
              onMouseLeave={() => setTooltip(null)}
            >
              <div 
                className="histogram-bar"
                style={{ height: `${(item.count / maxCount) * 100}%` }}
              />
              {/* Tooltip positioned relative to bar */}
              {tooltip?.bucket === item.bucket && (
                <div className="histogram-tooltip">
                  <div className="histogram-tooltip-value">{tooltip.count.toLocaleString()}</div>
                  <div className="histogram-tooltip-label">{tooltip.bucket}</div>
                </div>
              )}
            </div>
          ))}
          
          {/* Highlight line for stat hover */}
          {(() => {
            const shouldShow = highlightValue !== null && highlightValue !== undefined && dataMin !== undefined && dataMax !== undefined && dataMax !== dataMin;
            console.log('🦆 Histogram highlight check:', { highlightValue, dataMin, dataMax, shouldShow });
            if (shouldShow) {
              const leftPct = ((highlightValue - dataMin!) / (dataMax! - dataMin!)) * 100;
              console.log('🦆 Rendering highlight at:', leftPct + '%');
              return (
                <div 
                  className="histogram-stat-highlight"
                  style={{ left: `${leftPct}%` }}
                />
              );
            }
            return null;
          })()}
          
          {/* Highlight range for IQR */}
          {highlightRange !== null && highlightRange !== undefined && dataMin !== undefined && dataMax !== undefined && dataMax !== dataMin && (
            <div 
              className="histogram-stat-range"
              style={{ 
                left: `${((highlightRange[0] - dataMin) / (dataMax - dataMin)) * 100}%`,
                width: `${((highlightRange[1] - highlightRange[0]) / (dataMax - dataMin)) * 100}%`
              }}
            />
          )}
        </div>
        
        {/* X-axis - show min, mid, max */}
        <div className="histogram-x-axis">
          <span className="histogram-x-label">
            {displayData.length > 0 ? formatBucketStart(displayData[0].bucket) : ''}
          </span>
          <span className="histogram-x-label">
            {displayData.length > 0 ? (() => {
              const start = parseBucketStart(displayData[0].bucket);
              const end = parseBucketEnd(displayData[displayData.length - 1].bucket);
              if (start !== null && end !== null) {
                return formatNumber((start + end) / 2);
              }
              return '';
            })() : ''}
          </span>
          <span className="histogram-x-label">
            {displayData.length > 0 ? formatBucketEnd(displayData[displayData.length - 1].bucket) : ''}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Compact histogram for inline display (no axes)
 */
export function MiniHistogram({ data }: { data: HistogramBin[] }) {
  const validData = data.filter(d => d.count != null && !isNaN(d.count));
  if (validData.length === 0) return null;
  
  const maxCount = Math.max(...validData.map(d => d.count));
  if (maxCount === 0) return null;
  
  return (
    <div className="mini-histogram">
      {validData.slice(0, 15).map((item, idx) => (
        <div 
          key={idx} 
          className="mini-histogram-bar" 
          style={{ height: `${(item.count / maxCount) * 100}%` }}
          title={`${item.bucket}: ${item.count.toLocaleString()}`}
        />
      ))}
    </div>
  );
}
