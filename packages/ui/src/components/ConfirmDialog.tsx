import React, { useEffect, useId, useRef } from 'react';
import { Button } from './Button';
import { Portal } from './Portal';

export interface ConfirmDialogProps {
  open: boolean;
  title: React.ReactNode;
  description?: string | React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  description,
  confirmLabel = 'Bestätigen',
  cancelLabel = 'Abbrechen',
  destructive = false,
  onConfirm,
  onCancel,
  busy = false,
}) => {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;

    cancelButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCancel();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel, open]);

  if (!open) return null;

  return (
    <Portal>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-dark-base/20 p-4 backdrop-blur-sm"
        onClick={(event) => {
          if (event.target === event.currentTarget) onCancel();
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          aria-busy={busy || undefined}
          className="w-full max-w-md overflow-hidden rounded-3xl border border-border bg-surface shadow-2xl"
        >
          <div className="p-6">
            <h2 id={titleId} className="text-lg font-black text-foreground">
              {title}
            </h2>
            {description ? (
              <div id={descriptionId} className="mt-2 text-sm leading-6 text-muted">
                {description}
              </div>
            ) : null}
          </div>
          <div className="flex justify-end gap-3 border-t border-border-subtle bg-surface-muted p-4">
            <Button
              ref={cancelButtonRef}
              type="button"
              variant="ghost"
              size="md"
              onClick={onCancel}
            >
              {cancelLabel}
            </Button>
            <Button
              type="button"
              variant={destructive ? 'danger' : 'dark'}
              size="md"
              disabled={busy}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          </div>
        </div>
      </div>
    </Portal>
  );
};

ConfirmDialog.displayName = 'ConfirmDialog';
