import React, { useState, useEffect } from 'react';

export interface ModalProps {
  title: React.ReactNode;
  onClose: () => void;
  onCopy: () => void;
  copyLabel?: string;
  hint?: string;
  size?: string;
  className?: string;
  children: React.ReactNode;
}

export function Modal({ title, onClose, onCopy, copyLabel = 'Copy', hint, size, className, children }: ModalProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${className || ''}`}>
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <div className="modal-actions">
            <button className="modal-btn" onClick={handleCopy}>{copied ? '✓ Copied' : copyLabel}</button>
            <button className="modal-btn modal-close" onClick={onClose} title="Close (Esc)">✕</button>
          </div>
        </div>
        {children}
        <div className="modal-footer">
          <span className="modal-hint">{hint || 'Press Esc to close'}</span>
          {size && <span className="modal-size">{size}</span>}
        </div>
      </div>
    </div>
  );
}
