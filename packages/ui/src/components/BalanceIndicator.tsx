import React from 'react';
import { CheckCircle2, CircleAlert } from 'lucide-react';
import { cn } from '../utils/cn';
import { Amount } from './Amount';

export interface BalanceIndicatorProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  soll: number;
  haben: number;
}

export const BalanceIndicator: React.FC<BalanceIndicatorProps> = ({
  soll,
  haben,
  className,
  ...props
}) => {
  const differenz = Math.round(Math.abs(soll - haben) * 100) / 100;
  const balanced = differenz === 0;
  const missingSide = soll > haben ? 'Haben' : 'Soll';

  return (
    <div
      {...props}
      role="status"
      aria-live="polite"
      className={cn(
        'rounded-xl border p-5',
        balanced
          ? 'border-success-border bg-success-bg'
          : 'border-error-border bg-error-bg',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {balanced ? (
          <CheckCircle2 className="shrink-0 text-success-text" size={20} aria-hidden="true" />
        ) : (
          <CircleAlert className="shrink-0 text-error-text" size={20} aria-hidden="true" />
        )}
        <span className={cn('font-bold', balanced ? 'text-success-text' : 'text-error-text')}>
          {balanced ? 'Ausgeglichen' : 'Nicht ausgeglichen'}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-wider text-muted">Soll</div>
          <Amount value={soll} className="mt-1 text-base font-bold" />
        </div>
        <div>
          <div className="text-xs font-bold uppercase tracking-wider text-muted">Haben</div>
          <Amount value={haben} className="mt-1 text-base font-bold" />
        </div>
        <div>
          <div className="text-xs font-bold uppercase tracking-wider text-muted">Differenz</div>
          <Amount value={differenz} className="mt-1 text-base font-bold" />
        </div>
      </div>

      <p className="mt-4 text-sm text-foreground">
        {balanced ? (
          'Soll und Haben sind ausgeglichen.'
        ) : (
          <>
            Bitte gleiche Soll und Haben noch an: Auf der {missingSide}-Seite fehlen{' '}
            <Amount value={differenz} className="inline-block text-sm font-bold" />.
          </>
        )}
      </p>
    </div>
  );
};

BalanceIndicator.displayName = 'BalanceIndicator';
