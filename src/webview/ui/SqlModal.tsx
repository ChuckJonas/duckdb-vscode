import React, { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Modal, ModalAction } from './Modal';
import { SqlSyntaxHighlight } from './SqlHighlight';
import { Toggle } from './Toggle';

export interface SqlModalProps {
  /** The source / un-augmented query as the user authored it. */
  sql: string;
  /**
   * Optional "with UI filters + sort" wrapped form of the source query.
   * When provided and different from `sql`, the modal renders a toggle
   * that lets the user flip between the two views. Defaults to showing
   * this form so users see the query as it was actually executed.
   */
  filteredSql?: string;
  onClose: () => void;
  /** Receives whichever SQL is currently shown. */
  onCopy: (text: string) => void;
  /**
   * "Open in Editor" — receives whichever SQL is currently shown. The
   * host decides whether to reveal an existing source-file tab or to
   * open a new untitled .sql doc.
   */
  onOpenInEditor?: (sql: string) => void;
  title?: string;
}

/**
 * Read-only SQL preview modal. Editing happens in a real SQL editor —
 * the modal's `Open in Editor` action hands the user off there. We
 * intentionally do not embed a textarea editor here: the webview can't
 * replicate syntax highlighting, completions, or error reporting, so a
 * "looks editable" textarea quietly invites broken SQL (e.g.
 * `'col' != 'value'` string-literal comparisons that silently match
 * every row).
 */
export function SqlModal({
  sql,
  filteredSql,
  onClose,
  onCopy,
  onOpenInEditor,
  title = 'SQL',
}: SqlModalProps) {
  const hasFiltered = !!filteredSql && filteredSql !== sql;
  // Default the toggle ON when a filtered form exists — users opening
  // the modal mid-investigation usually want to see what's actually
  // running, not the original literal text.
  const [showFiltered, setShowFiltered] = useState(hasFiltered);

  const displayedSql = hasFiltered && showFiltered ? (filteredSql as string) : sql;

  const actions: ModalAction[] = [];
  if (onOpenInEditor) {
    actions.push({
      icon: <ExternalLink size={14} />,
      label: 'Open in Editor',
      onClick: () => onOpenInEditor(displayedSql),
    });
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      onCopy={() => onCopy(displayedSql)}
      size={`${displayedSql.length.toLocaleString()} chars`}
      className="sql-modal"
      actions={actions.length > 0 ? actions : undefined}
      hint="Press Esc to close"
    >
      {hasFiltered && (
        <div className="sql-modal-toggle-bar">
          <Toggle
            checked={showFiltered}
            onChange={setShowFiltered}
            label="Apply filters & sort"
          />
        </div>
      )}
      <pre className="modal-content modal-sql">
        <SqlSyntaxHighlight sql={displayedSql} />
      </pre>
    </Modal>
  );
}
