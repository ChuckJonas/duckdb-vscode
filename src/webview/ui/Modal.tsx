import React, { useState, useEffect } from 'react';
import { Copy, Check, X } from 'lucide-react';
import { IconButton } from './IconButton';

export interface ModalAction {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}

export interface ModalProps {
  title: React.ReactNode;
  onClose: () => void;
  onCopy: () => void;
  copyLabel?: string;
  hint?: string;
  size?: string;
  className?: string;
  actions?: ModalAction[];
  children: React.ReactNode;
}

export function Modal({ title, onClose, onCopy, copyLabel = 'Copy', hint, size, className, actions, children }: ModalProps) {
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
            <IconButton
              icon={copied ? <Check size={14} /> : <Copy size={14} />}
              tooltip={copyLabel}
              onClick={handleCopy}
            />
            {actions?.map((action, i) => (
              <IconButton
                key={i}
                icon={action.icon}
                tooltip={action.label}
                onClick={action.onClick}
              />
            ))}
            <IconButton
              icon={<X size={14} />}
              tooltip="Close (Esc)"
              onClick={onClose}
              className="modal-close"
            />
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
