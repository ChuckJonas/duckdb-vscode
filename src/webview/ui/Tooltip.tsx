import React, { useState, useRef, useEffect } from 'react';

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
  className?: string;
}

export function Tooltip({ 
  content, 
  children, 
  position = 'top', 
  delay = 200,
  className = ''
}: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<number | null>(null);

  const showTooltip = () => {
    timeoutRef.current = window.setTimeout(() => {
      setIsVisible(true);
    }, delay);
  };

  const hideTooltip = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsVisible(false);
  };

  useEffect(() => {
    if (isVisible && triggerRef.current && tooltipRef.current) {
      const triggerRect = triggerRef.current.getBoundingClientRect();
      const tooltipRect = tooltipRef.current.getBoundingClientRect();
      
      let top = 0;
      let left = 0;
      
      switch (position) {
        case 'top':
          top = -tooltipRect.height - 6;
          left = (triggerRect.width - tooltipRect.width) / 2;
          break;
        case 'bottom':
          top = triggerRect.height + 6;
          left = (triggerRect.width - tooltipRect.width) / 2;
          break;
        case 'left':
          top = (triggerRect.height - tooltipRect.height) / 2;
          left = -tooltipRect.width - 6;
          break;
        case 'right':
          top = (triggerRect.height - tooltipRect.height) / 2;
          left = triggerRect.width + 6;
          break;
      }
      
      setCoords({ top, left });
    }
  }, [isVisible, position]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return (
    <div 
      ref={triggerRef}
      className={`tooltip-trigger ${className}`}
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      style={{ display: 'inline-flex', position: 'relative' }}
    >
      {children}
      {isVisible && (
        <div 
          ref={tooltipRef}
          className={`tooltip tooltip-${position}`}
          style={{ 
            position: 'absolute',
            top: coords.top,
            left: coords.left,
          }}
        >
          {content}
        </div>
      )}
    </div>
  );
}
