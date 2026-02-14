import React from 'react';

interface ToastProps {
  message: string | null;
  className?: string;
}

/**
 * Simple toast notification that renders when `message` is non-null.
 */
export function Toast({ message, className = '' }: ToastProps) {
  if (!message) return null;
  return <div className={`toast ${className}`}>{message}</div>;
}
