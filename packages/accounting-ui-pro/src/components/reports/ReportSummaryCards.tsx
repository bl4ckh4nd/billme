interface ReportSummaryCardsProps {
  cards: Array<{
    label: string;
    value: string;
    sublabel?: string;
    tone?: 'default' | 'ok' | 'warning' | 'danger';
  }>;
}

export default function ReportSummaryCards({ cards }: ReportSummaryCardsProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
      {cards.map((card) => (
        <div key={card.label} className="rounded-xl border border-border bg-surface p-3">
          <div className="text-[10px] uppercase tracking-wide font-bold text-muted">{card.label}</div>
          <div
            className={`text-lg font-bold mt-1 ${
              card.tone === 'ok'
                ? 'text-success'
                : card.tone === 'warning'
                  ? 'text-warning'
                  : card.tone === 'danger'
                    ? 'text-error'
                    : 'text-foreground'
            }`}
          >
            {card.value}
          </div>
          {card.sublabel && <div className="text-xs text-muted mt-0.5">{card.sublabel}</div>}
        </div>
      ))}
    </div>
  );
}

