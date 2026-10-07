import { Badge, type BadgeTone } from '@billme/ui';
import { getFlagLabel, getStatusPresentation } from '../domain/selectors';
import { BookingWorkflowStatus, Transaction } from '../types';

interface IssueBadgesProps {
  transaction: Transaction;
}

const STATUS_TONE: Record<BookingWorkflowStatus, BadgeTone> = {
  imported: 'neutral',
  suggested: 'info',
  incomplete: 'warning',
  ready_for_review: 'info',
  pending_approval: 'warning',
  approved: 'success',
  posted: 'success',
  reversed: 'error',
  corrected: 'info',
  period_locked: 'error',
  integration_error: 'error',
};

export function StatusBadge({ status }: { status: BookingWorkflowStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{getStatusPresentation(status).label}</Badge>;
}

export default function IssueBadges({ transaction }: IssueBadgesProps) {
  const { issueCounts, flags } = transaction;
  if (issueCounts.errors + issueCounts.warnings + issueCounts.infos === 0 && flags.length === 0) {
    return <span className="text-muted">-</span>;
  }

  return (
    <span className="inline-flex gap-1 whitespace-nowrap">
      {issueCounts.errors > 0 && <Badge tone="error" className="whitespace-nowrap">{issueCounts.errors} Fehler</Badge>}
      {issueCounts.warnings > 0 && <Badge tone="warning" className="whitespace-nowrap">{issueCounts.warnings} Warn.</Badge>}
      {flags.slice(0, 2).map((flag) => (
        <Badge key={flag} tone="warning" className="whitespace-nowrap">{getFlagLabel(flag)}</Badge>
      ))}
    </span>
  );
}
