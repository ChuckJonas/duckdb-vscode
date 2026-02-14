import React from 'react';
import { Tooltip } from './Tooltip';

interface IconButtonProps {
  icon: React.ReactNode;
  tooltip: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  tooltipPosition?: 'top' | 'bottom' | 'left' | 'right';
  children?: React.ReactNode;
}

export function IconButton({ 
  icon, 
  tooltip, 
  onClick, 
  disabled = false, 
  className = '',
  tooltipPosition = 'top',
  children,
}: IconButtonProps) {
  return (
    <Tooltip content={tooltip} position={tooltipPosition}>
      <button 
        className={`btn btn-surface icon-btn icon-only ${className}`}
        onClick={onClick}
        disabled={disabled}
      >
        {icon}
        {children}
      </button>
    </Tooltip>
  );
}
