import { useId } from 'react';
import { BookingAction, BookingDraft, UiPermissionContext } from '../types';
import { bookingActionLabels } from '../domain/selectors';

interface WorkflowActionBarProps {
  draft: BookingDraft;
  permissionCtx: UiPermissionContext;
  allowedActions: BookingAction[];
  onAction: (action: BookingAction) => void;
  isBusy?: boolean;
  /** A hard validation error blocks the next step: the primary stays visible, disabled, with the reason under it. */
  blockedAction?: BookingAction;
  blockedReason?: string;
}

export default function WorkflowActionBar({
  allowedActions,
  onAction,
  isBusy,
  blockedAction,
  blockedReason,
}: WorkflowActionBarProps) {
  const reasonId = useId();
  const blocked = Boolean(blockedAction && blockedReason);
  if (allowedActions.length === 0 && !blocked) return null;
  const primary =
    (blocked ? blockedAction : undefined) ??
    allowedActions.find((action) => ['post', 'approve', 'submit_for_review'].includes(action)) ??
    allowedActions.find((action) => action !== 'request_receipt') ??
    'save_draft';

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {allowedActions
          .filter((action) => action !== primary)
          .map((action) => (
            <button
              key={action}
              type="button"
              onClick={() => onAction(action)}
              disabled={isBusy}
              className="px-4 py-2 rounded-lg border border-control-border bg-surface text-foreground text-sm font-semibold hover:bg-surface-muted disabled:opacity-50"
            >
              {bookingActionLabels[action]}
            </button>
          ))}
        <button
          type="button"
          onClick={() => onAction(primary)}
          disabled={isBusy || blocked}
          aria-describedby={blocked ? reasonId : undefined}
          className="min-h-11 px-5 py-2 rounded-control bg-surface-inverse text-inverse-foreground text-sm font-semibold hover:bg-surface-inverse-raised disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isBusy ? 'Speichert...' : bookingActionLabels[primary]}
        </button>
      </div>
      {blocked ? (
        <p id={reasonId} role="status" className="max-w-sm text-right text-caption font-medium text-error-text">
          {bookingActionLabels[primary]} gesperrt: {blockedReason}
        </p>
      ) : null}
    </div>
  );
}
