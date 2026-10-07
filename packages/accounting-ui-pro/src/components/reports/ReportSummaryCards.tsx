import type { ReactNode } from 'react';
import { Metric, type MetricTone } from '@billme/ui';

interface ReportSummaryCardsProps {
  cards: Array<{
    label: string;
    value: string;
    sublabel?: string;
    tone?: 'default' | 'ok' | 'warning' | 'danger';
  }>;
  /** Rendered when the figures are Beispieldaten so the row cannot read as measured data. */
  note?: ReactNode;
}

const METRIC_TONE: Record<'default' | 'ok' | 'warning' | 'danger', MetricTone> = {
  default: 'neutral',
  ok: 'success',
  warning: 'warning',
  danger: 'error',
};

export default function ReportSummaryCards({ cards, note }: ReportSummaryCardsProps) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
        {cards.map((card) => (
          <div key={card.label} className="rounded-tile border border-border bg-surface px-4 py-3.5">
            <Metric marker="tick" label={card.label} value={card.value} hint={card.sublabel} tone={METRIC_TONE[card.tone ?? 'default']} />
          </div>
        ))}
      </div>
      {note ? <p className="text-caption text-muted">{note}</p> : null}
    </div>
  );
}
