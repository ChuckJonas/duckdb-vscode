import React, { useState, useCallback, useRef } from 'react';
import { Copy, Check } from 'lucide-react';

interface CopyButtonProps {
  text: string;
  title?: string;
  className?: string;
  size?: number;
  onClick?: (e: React.MouseEvent) => void;
}

/**
 * A copy button that swaps to a green checkmark on success.
 * Provides low-profile inline feedback without a toast.
 */
export function CopyButton({ text, title, className, size = 12, onClick }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onClick?.(e);
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    });
  }, [text, onClick]);

  return (
    <button
      className={`copy-btn ${copied ? 'copy-btn-success' : ''} ${className || ''}`}
      onClick={handleClick}
      title={copied ? 'Copied!' : title}
    >
      {copied ? <Check size={size} /> : <Copy size={size} />}
    </button>
  );
}
