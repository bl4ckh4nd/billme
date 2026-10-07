import { Check, Info, TriangleAlert } from 'lucide-react';
import { ValidationIssue } from '../types';

interface ValidationSummaryProps {
  issues: ValidationIssue[];
}

const ROW = 'flex items-start gap-2 rounded-control border px-2.25 py-1.75 text-caption';

const SEVERITY = {
  error: { label: 'Fehler', tone: 'border-error-border bg-error-bg text-error-text', Icon: TriangleAlert },
  warning: { label: 'Warnung', tone: 'border-warning-border bg-warning-bg text-warning-text', Icon: TriangleAlert },
  info: { label: 'Hinweis', tone: 'border-border bg-surface-muted text-foreground', Icon: Info },
} as const;

export default function ValidationSummary({ issues }: ValidationSummaryProps) {
  return (
    <section aria-live="polite">
      <h3 className="mb-2 text-eyebrow uppercase text-muted">
        Validierung{issues.length > 0 ? ` (${issues.length})` : ''}
      </h3>
      {issues.length === 0 ? (
        <div className={`${ROW} border-success-border bg-success-bg text-success-text`}>
          <Check size={14} aria-hidden="true" className="mt-px shrink-0" />
          <span>Keine Validierungsprobleme. Buchung ist prüfbar.</span>
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {(['error', 'warning', 'info'] as const).flatMap((severity) =>
            issues
              .filter((issue) => issue.severity === severity)
              .map((issue) => {
                const { label, tone, Icon } = SEVERITY[severity];
                return (
                  <li key={issue.id} className={`${ROW} ${tone}`}>
                    <Icon size={14} aria-hidden="true" className="mt-px shrink-0" />
                    <span>
                      <strong className="font-semibold">{label}.</strong> {issue.message}
                    </span>
                  </li>
                );
              }),
          )}
        </ul>
      )}
    </section>
  );
}
