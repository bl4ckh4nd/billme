import { BookingAction, BookingDraft, UiPermissionContext } from '../types';

const actionLabels: Record<BookingAction, string> = {
  save_draft: 'Entwurf speichern',
  submit_for_review: 'Zur Prüfung geben',
  approve: 'Freigeben',
  reject: 'Ablehnen',
  post: 'Buchen',
  reverse: 'Stornieren',
  create_correction: 'Korrekturbuchung',
  request_receipt: 'Beleg anfordern',
};

interface WorkflowActionBarProps {
  draft: BookingDraft;
  permissionCtx: UiPermissionContext;
  allowedActions: BookingAction[];
  onAction: (action: BookingAction) => void;
  isBusy?: boolean;
}

export default function WorkflowActionBar({
  allowedActions,
  onAction,
  isBusy,
}: WorkflowActionBarProps) {
  const primary =
    allowedActions.find((action) => ['post', 'approve', 'submit_for_review'].includes(action)) ??
    allowedActions.find((action) => action !== 'request_receipt') ??
    'save_draft';

  return (
    <div className="flex flex-wrap items-center gap-2">
      {allowedActions
        .filter((action) => action !== primary)
        .map((action) => (
          <button
            key={action}
            type="button"
            onClick={() => onAction(action)}
            disabled={isBusy}
            className="px-4 py-2 rounded-full border border-border bg-surface text-muted text-sm font-bold hover:bg-surface-muted disabled:opacity-50"
          >
            {actionLabels[action]}
          </button>
        ))}
      <button
        type="button"
        onClick={() => onAction(primary)}
        disabled={isBusy}
        className="px-5 py-2 rounded-full bg-foreground text-white text-sm font-bold hover:bg-foreground disabled:opacity-50"
      >
        {isBusy ? 'Speichert...' : actionLabels[primary]}
      </button>
    </div>
  );
}
