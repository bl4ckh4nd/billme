import React, { useId, useRef } from 'react';
import { Button } from './Button';
import { Input } from './Input';
import { Modal } from './Modal';

export interface ConfirmDialogReason {
  label: string;
  placeholder?: string;
  required?: boolean;
  value: string;
  onChange: (value: string) => void;
}

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
  reason?: ConfirmDialogReason;
  details?: React.ReactNode;
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
  reason,
  details,
}) => {
  const reasonInputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const reasonMissing = reason?.required === true && reason.value.trim().length === 0;
  const reasonError = reasonMissing ? 'Bitte gib eine Begründung ein, bevor du bestätigst.' : undefined;
  const dismissOnBackdrop = !(reason?.required === true && reason.value.length > 0);

  const handleConfirm = () => {
    if (busy) return;
    if (reasonMissing) {
      reasonInputRef.current?.focus();
      return;
    }
    onConfirm();
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    handleConfirm();
  };

  return (
    <Modal
      open={open}
      onClose={onCancel}
      titleId={titleId}
      descriptionId={description ? descriptionId : undefined}
      initialFocusRef={reason?.required ? reasonInputRef : undefined}
      dismissOnBackdrop={dismissOnBackdrop}
      ariaBusy={busy}
      className="max-w-md overflow-hidden"
    >
      <form onSubmit={handleSubmit}>
        <div className="p-6">
          <h2 id={titleId} className="text-base font-semibold text-foreground">
            {title}
          </h2>
          {description ? (
            <div id={descriptionId} className="mt-2 text-sm leading-6 text-muted">
              {description}
            </div>
          ) : null}
          {details !== undefined && details !== null ? (
            <div className="mt-4 border-y border-border-subtle py-4 text-sm text-foreground">
              {details}
            </div>
          ) : null}
          {reason ? (
            <div className="mt-5">
              <Input
                ref={reasonInputRef}
                label={reason.label}
                placeholder={reason.placeholder}
                  value={reason.value}
                  onChange={(event) => reason.onChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                    event.preventDefault();
                    handleConfirm();
                  }}
                  required={reason.required}
                error={reasonError}
                disabled={busy}
                fullWidth
              />
            </div>
          ) : null}
        </div>
        <div className="flex justify-end gap-3 border-t border-border-subtle bg-surface-muted p-4">
          <Button
            type="button"
            variant="ghost"
            size="md"
            onClick={onCancel}
          >
            {cancelLabel}
          </Button>
          <Button
            type="submit"
            variant={destructive ? 'danger' : 'dark'}
            size="md"
            disabled={busy || reasonMissing}
            aria-busy={busy || undefined}
            aria-label={busy ? 'Wird verarbeitet…' : confirmLabel}
          >
            <span className="inline-grid grid-cols-1 grid-rows-1 items-center justify-center">
              <span
                aria-hidden={busy || undefined}
                className={`col-start-1 row-start-1 inline-flex items-center justify-center gap-2 ${busy ? 'invisible' : ''}`}
              >
                {confirmLabel}
              </span>
              <span
                aria-hidden={!busy || undefined}
                className={`col-start-1 row-start-1 inline-flex items-center justify-center gap-2 ${busy ? '' : 'invisible'}`}
              >
                <span
                  aria-hidden="true"
                  className="size-4 shrink-0 rounded-full border-2 border-current border-t-transparent motion-safe:animate-spin motion-reduce:animate-none"
                />
                <span>Wird verarbeitet…</span>
              </span>
            </span>
          </Button>
        </div>
      </form>
    </Modal>
  );
};

ConfirmDialog.displayName = 'ConfirmDialog';
