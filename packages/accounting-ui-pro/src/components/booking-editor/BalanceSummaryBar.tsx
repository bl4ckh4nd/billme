import { formatCurrency } from './helpers';

interface BalanceSummaryBarProps {
  totalSoll: number;
  totalHaben: number;
  difference: number;
  currency: string;
}

export default function BalanceSummaryBar({
  totalSoll,
  totalHaben,
  difference,
  currency,
}: BalanceSummaryBarProps) {
  return (
    <div className="bg-foreground rounded-xl p-5 text-white">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex gap-8">
          <div>
            <div className="text-xs uppercase tracking-wider text-muted font-bold">Soll</div>
            <div className="text-xl font-bold tabular-nums">{formatCurrency(totalSoll, currency)}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-muted font-bold">Haben</div>
            <div className="text-xl font-bold tabular-nums">{formatCurrency(totalHaben, currency)}</div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-wider text-muted font-bold">Differenz</div>
          <div className={`text-2xl font-bold tabular-nums ${difference < 0.01 ? 'text-accent-lime' : 'text-error'}`}>
            {formatCurrency(difference, currency)}
          </div>
        </div>
      </div>
    </div>
  );
}
