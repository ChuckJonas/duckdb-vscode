import React from 'react';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
}

export function Toggle({ 
  checked, 
  onChange, 
  label, 
  disabled = false,
  size = 'sm'
}: ToggleProps) {
  const handleClick = () => {
    if (!disabled) {
      onChange(!checked);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!disabled) {
        onChange(!checked);
      }
    }
  };

  return (
    <div 
      className={`toggle-container ${disabled ? 'disabled' : ''}`}
      onClick={handleClick}
    >
      {label && <span className="toggle-label">{label}</span>}
      <div 
        className={`toggle-track ${size} ${checked ? 'checked' : ''}`}
        role="switch"
        aria-checked={checked}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={handleKeyDown}
      >
        <div className="toggle-thumb" />
      </div>
    </div>
  );
}
