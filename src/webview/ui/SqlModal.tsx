import React, { useEffect, useRef, useState } from 'react';
import { ExternalLink, Play } from 'lucide-react';
import { Modal, ModalAction } from './Modal';
import { SqlSyntaxHighlight } from './SqlHighlight';

export interface SqlModalProps {
  sql: string;
  onClose: () => void;
  onCopy: (text: string) => void;
  /** "Go to Source File" action — navigates to the original .sql file */
  onGoToSource?: () => void;
  /** "Open in Editor" action — opens the SQL in a new untitled editor */
  onOpenInEditor?: (sql?: string) => void;
  /**
   * "Run" action — when provided, the modal becomes an editor and
   * the user can modify and re-run the SQL with Ctrl/Cmd+Enter.
   */
  onRun?: (sql: string) => void;
  title?: string;
}

export function SqlModal({
  sql,
  onClose,
  onCopy,
  onGoToSource,
  onOpenInEditor,
  onRun,
  title = 'SQL',
}: SqlModalProps) {
  const editable = !!onRun;
  const [draft, setDraft] = useState(sql);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Keep draft in sync if the upstream SQL changes (e.g. filters tweaked)
  useEffect(() => {
    setDraft(sql);
  }, [sql]);

  // Auto-focus the editor when opened so the user can type immediately
  useEffect(() => {
    if (editable) {
      textareaRef.current?.focus();
      // Place cursor at end
      const len = textareaRef.current?.value.length ?? 0;
      textareaRef.current?.setSelectionRange(len, len);
    }
  }, [editable]);

  const isDirty = draft !== sql;
  const trimmed = draft.trim();
  const canRun = editable && trimmed.length > 0;

  const handleRun = () => {
    if (!canRun || !onRun) return;
    onRun(trimmed);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl/Cmd+Enter runs the query
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleRun();
      return;
    }
    // Tab inserts spaces inside the textarea
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = draft.slice(0, start) + '  ' + draft.slice(end);
      setDraft(next);
      // Restore cursor after the inserted spaces
      requestAnimationFrame(() => {
        ta.setSelectionRange(start + 2, start + 2);
      });
    }
  };

  const actions: ModalAction[] = [];
  if (onGoToSource) {
    actions.push({
      icon: <ExternalLink size={14} />,
      label: 'Go to Source File',
      onClick: onGoToSource,
    });
  }
  if (onOpenInEditor) {
    actions.push({
      icon: <ExternalLink size={14} />,
      label: 'Open in Editor',
      onClick: () => onOpenInEditor(editable ? draft : undefined),
    });
  }
  if (canRun) {
    actions.push({
      icon: <Play size={14} />,
      label: isDirty ? 'Run edited SQL (⌘↵)' : 'Run SQL (⌘↵)',
      onClick: handleRun,
    });
  }

  const valueForCopy = editable ? draft : sql;
  const hint = editable
    ? 'Edit and press ⌘↵ to run · Esc to close'
    : 'Press Esc to close';

  return (
    <Modal
      title={title}
      onClose={onClose}
      onCopy={() => onCopy(valueForCopy)}
      size={`${valueForCopy.length.toLocaleString()} chars`}
      className="sql-modal"
      actions={actions.length > 0 ? actions : undefined}
      hint={hint}
    >
      {editable ? (
        <textarea
          ref={textareaRef}
          className="modal-content modal-sql-editor"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          rows={Math.min(24, Math.max(6, draft.split('\n').length + 1))}
        />
      ) : (
        <pre className="modal-content modal-sql">
          <SqlSyntaxHighlight sql={sql} />
        </pre>
      )}
    </Modal>
  );
}
