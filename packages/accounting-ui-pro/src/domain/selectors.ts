import { BookingAction, BookingWorkflowStatus, Transaction, TransactionFlag } from '../types';

export type InboxQueueKey =
  | 'all'
  | 'incomplete'
  | 'review'
  | 'approval'
  | 'posted'
  | 'errors'
  | 'missing_receipt'
  | 'duplicates'
  | 'transfers';

export const inboxQueueLabels: Record<InboxQueueKey, string> = {
  all: 'Alle',
  incomplete: 'Unvollständig',
  review: 'Zur Prüfung',
  approval: 'Freigabe',
  posted: 'Gebucht',
  errors: 'Fehler',
  missing_receipt: 'Ohne Beleg',
  duplicates: 'Dubletten',
  transfers: 'Umbuchungen',
};

export const bookingActionLabels: Record<BookingAction, string> = {
  save_draft: 'Entwurf speichern',
  submit_for_review: 'Zur Prüfung geben',
  approve: 'Freigeben',
  reject: 'Ablehnen',
  post: 'Buchen',
  reverse: 'Stornieren',
  create_correction: 'Korrekturbuchung',
  request_receipt: 'Beleg anfordern',
};

export function txMatchesQueue(tx: Transaction, queue: InboxQueueKey): boolean {
  switch (queue) {
    case 'all':
      return true;
    case 'incomplete':
      return ['incomplete', 'suggested', 'period_locked'].includes(tx.workflowStatus);
    case 'review':
      return tx.workflowStatus === 'ready_for_review';
    case 'approval':
      return tx.workflowStatus === 'pending_approval' || tx.workflowStatus === 'approved';
    case 'posted':
      return ['posted', 'reversed', 'corrected'].includes(tx.workflowStatus);
    case 'errors':
      return tx.issueCounts.errors > 0 || tx.workflowStatus === 'integration_error';
    case 'transfers':
      return Boolean(tx.transfer) && !['posted', 'reversed', 'corrected'].includes(tx.workflowStatus);
    case 'missing_receipt':
      return tx.flags.includes('missing_receipt');
    case 'duplicates':
      return tx.flags.includes('duplicate_suspected');
    default:
      return true;
  }
}

export function getQueueCounts(transactions: Transaction[]): Record<InboxQueueKey, number> {
  return (Object.keys(inboxQueueLabels) as InboxQueueKey[]).reduce((acc, queue) => {
    acc[queue] = transactions.filter((tx) => txMatchesQueue(tx, queue)).length;
    return acc;
  }, {} as Record<InboxQueueKey, number>);
}

export function getStatusPresentation(status: BookingWorkflowStatus): {
  label: string;
  className: string;
} {
  const map: Record<BookingWorkflowStatus, { label: string; className: string }> = {
    imported: { label: 'Neu', className: 'bg-surface-muted text-muted' },
    suggested: { label: 'Vorschlag', className: 'bg-info-bg text-info-text' },
    incomplete: { label: 'Unvollständig', className: 'bg-warning-bg text-warning-text' },
    ready_for_review: { label: 'Zur Prüfung', className: 'bg-info-bg text-info-text' },
    pending_approval: { label: 'Freigabe offen', className: 'bg-warning-bg text-warning-text' },
    approved: { label: 'Freigegeben', className: 'bg-success-bg text-success-text' },
    posted: { label: 'Gebucht', className: 'bg-success-bg text-success-text' },
    reversed: { label: 'Storniert', className: 'bg-error-bg text-error-text' },
    corrected: { label: 'Korrigiert', className: 'bg-info-bg text-info-text' },
    period_locked: { label: 'Periode gesperrt', className: 'bg-error-bg text-error-text' },
    integration_error: { label: 'Integrationsfehler', className: 'bg-error-bg text-error-text' },
  };
  return map[status];
}

/** Five-step pipeline for the workbench stepper; -1 when the status sits outside it. */
export const WORKFLOW_STEPS = ['Importiert', 'Vorschlag', 'Prüfung', 'Freigegeben', 'Gebucht'] as const;

export function getWorkflowStep(status: BookingWorkflowStatus): number {
  switch (status) {
    case 'imported':
      return 0;
    case 'suggested':
    case 'incomplete':
      return 1;
    case 'ready_for_review':
      return 2;
    case 'pending_approval':
    case 'approved':
      return 3;
    case 'posted':
    case 'corrected':
      return 4;
    default:
      return -1;
  }
}

export function getFlagLabel(flag: TransactionFlag): string {
  const labels: Record<TransactionFlag, string> = {
    missing_receipt: 'Ohne Beleg',
    duplicate_suspected: 'Dublette?',
    tax_unclear: 'Steuer unklar',
    period_locked: 'Periode gesperrt',
  };
  return labels[flag];
}
