import { getFlagLabel } from '../domain/selectors';
import { Transaction } from '../types';

interface IssueBadgesProps {
  transaction: Transaction;
}

export default function IssueBadges({ transaction }: IssueBadgesProps) {
  const { issueCounts, flags } = transaction;
  if (issueCounts.errors + issueCounts.warnings + issueCounts.infos === 0 && flags.length === 0) {
    return <span className="text-muted">-</span>;
  }

  return (
    <div className="flex flex-wrap gap-1 justify-end">
      {issueCounts.errors > 0 && (
        <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-error-bg text-error-text">
          {issueCounts.errors} Fehler
        </span>
      )}
      {issueCounts.warnings > 0 && (
        <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-warning-bg text-warning-text">
          {issueCounts.warnings} Warn.
        </span>
      )}
      {flags.slice(0, 2).map((flag) => (
        <span key={flag} className="px-2 py-0.5 rounded-full text-xs font-semibold bg-border-subtle text-foreground">
          {getFlagLabel(flag)}
        </span>
      ))}
    </div>
  );
}

