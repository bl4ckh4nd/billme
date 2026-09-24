import type { ReactNode } from 'react';

interface ReportSummaryCardsProps {
  cards: Array<{
    label: string;
    value: string;
    sublabel?: string;
    tone?: 'default' | 'ok' | 'warning' | 'danger';
    /**
     * The one metric that answers this report's question. It gets the full row and
     * the heavier weight; every other metric stays compact beneath it.
     */
    emphasis?: boolean;
  }>;
  /** Rendered when the figures are Beispieldaten so the row cannot read as measured data. */
  note?: ReactNode;
}

function toneText(tone: 'default' | 'ok' | 'warning' | 'danger' | undefined) {
  if (tone === 'ok') return 'text-success-text';
  if (tone === 'warning') return 'text-warning-text';
  if (tone === 'danger') return 'text-error-text';
  return 'text-foreground';
}

export default function ReportSummaryCards({ cards, note }: ReportSummaryCardsProps) {
  const focal = cards.find((card) => card.emphasis);
  const rest = cards.filter((card) => card !== focal);

  return (
    <div className="space-y-2">
      {focal ? (
        <div key={focal.label} className="rounded-xl border border-border bg-surface px-4 py-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">{focal.label}</div>
          <div className={`mt-1 text-base font-semibold tabular-nums ${toneText(focal.tone)}`}>{focal.value}</div>
          {focal.sublabel ? <div className="mt-0.5 text-xs text-muted">{focal.sublabel}</div> : null}
        </div>
      ) : null}
      {rest.length > 0 ? (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
          {rest.map((card) => (
            <div key={card.label} className="rounded-lg border border-border-subtle bg-surface-muted px-3 py-2">
              <div className="text-xs font-semibold text-muted">{card.label}</div>
              <div className={`mt-0.5 text-sm font-semibold tabular-nums ${toneText(card.tone)}`}>{card.value}</div>
              {card.sublabel ? <div className="text-xs text-muted">{card.sublabel}</div> : null}
            </div>
          ))}
        </div>
      ) : null}
      {note ? <p className="text-xs text-muted">{note}</p> : null}
    </div>
  );
}
