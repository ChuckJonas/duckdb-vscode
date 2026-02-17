import React from 'react';
import { ExternalLink } from 'lucide-react';
import { Modal, ModalAction } from './Modal';
import { SqlSyntaxHighlight } from './SqlHighlight';

export interface SqlModalProps {
  sql: string;
  onClose: () => void;
  onCopy: (text: string) => void;
  /** "Go to Source File" action — navigates to the original .sql file */
  onGoToSource?: () => void;
  /** "Open in Editor" action — opens the SQL in a new untitled editor */
  onOpenInEditor?: () => void;
  title?: string;
}

export function SqlModal({ sql, onClose, onCopy, onGoToSource, onOpenInEditor, title = "SQL" }: SqlModalProps) {
  const actions: ModalAction[] = [];

  if (onGoToSource) {
    actions.push({ icon: <ExternalLink size={14} />, label: 'Go to Source File', onClick: onGoToSource });
  }
  if (onOpenInEditor) {
    actions.push({ icon: <ExternalLink size={14} />, label: 'Open in Editor', onClick: onOpenInEditor });
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      onCopy={() => onCopy(sql)}
      size={`${sql.length.toLocaleString()} chars`}
      className="sql-modal"
      actions={actions.length > 0 ? actions : undefined}
    >
      <pre className="modal-content modal-sql">
        <SqlSyntaxHighlight sql={sql} />
      </pre>
    </Modal>
  );
}
