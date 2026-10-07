import type { ReactNode } from 'react';
import { useState } from 'react';

interface ExecuteConfirmDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  bytes: number;
  actionCount: number;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}

export function ExecuteConfirmDialog({
  open,
  title,
  description,
  bytes,
  actionCount,
  onConfirm,
  onCancel,
  loading = false,
}: ExecuteConfirmDialogProps) {
  const [confirmText, setConfirmText] = useState('');

  if (!open) return null;

  const canConfirm = confirmText === 'DELETE';

  const handleCancel = () => {
    setConfirmText('');
    onCancel();
  };

  const handleConfirm = () => {
    if (!canConfirm) return;
    setConfirmText('');
    onConfirm();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="execute-confirm-title"
      >
        <h2 id="execute-confirm-title" className="text-lg font-semibold text-danger">
          {title}
        </h2>
        {description ? <div className="mt-2 text-sm text-muted">{description}</div> : null}
        <div className="mt-4 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm">
          <p>
            This will run <strong>{actionCount}</strong> actions on{' '}
            <strong>{(bytes / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 2 })} MB</strong>.
          </p>
          <p className="mt-2 text-muted">This operation is irreversible in the live tenant.</p>
        </div>
        <label className="mt-4 block text-sm">
          <span className="text-muted">Type DELETE to confirm</span>
          <input
            type="text"
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-bg"
            onClick={handleCancel}
            disabled={loading}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-lg bg-danger px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            onClick={handleConfirm}
            disabled={loading || !canConfirm}
          >
            {loading ? 'Running…' : 'Run'}
          </button>
        </div>
      </div>
    </div>
  );
}
