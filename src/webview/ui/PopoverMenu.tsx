import React, { useState, useRef, useEffect } from 'react';

interface PopoverMenuProps {
  /** The trigger element (e.g. an IconButton). Receives onClick to toggle. */
  trigger: React.ReactNode;
  /** Menu items rendered inside the popover */
  children: React.ReactNode;
  className?: string;
}

/**
 * A toggleable popover menu that opens above the trigger.
 * Closes on click-outside or Escape.
 */
export function PopoverMenu({ trigger, children, className = '' }: PopoverMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open]);

  return (
    <div className={`popover-menu ${className}`} ref={ref}>
      <div onClick={() => setOpen(!open)}>
        {trigger}
      </div>
      {open && (
        <div className="popover-menu-items" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}
