import { useId } from 'react';
import { Button } from '@billme/ui';
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
    <div className="flex flex-col items-end gap-1 border-t border-border pt-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {allowedActions
          .filter((action) => action !== primary)
          .map((action) => (
            <Button
              key={action}
              variant={action === 'save_draft' ? 'ghost' : 'secondary'}
              onClick={() => onAction(action)}
              disabled={isBusy}
            >
              {bookingActionLabels[action]}
            </Button>
          ))}
        <Button
          onClick={() => onAction(primary)}
          disabled={isBusy || blocked}
          aria-describedby={blocked ? reasonId : undefined}
        >
          {isBusy ? 'Speichert...' : bookingActionLabels[primary]}
        </Button>
      </div>
      {blocked ? (
        <p id={reasonId} role="status" className="text-right text-caption text-error-text">
          {bookingActionLabels[primary]} gesperrt: {blockedReason}
        </p>
      ) : null}
    </div>
  );
}
