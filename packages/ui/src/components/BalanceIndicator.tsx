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
        'rounded-card border p-3.5',
        balanced
          ? 'border-success-border bg-success-bg'
          : 'border-error-border bg-error-bg',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {balanced ? (
          <CheckCircle2 className="shrink-0 text-success-text" size={16} aria-hidden="true" />
        ) : (
          <CircleAlert className="shrink-0 text-error-text" size={16} aria-hidden="true" />
        )}
        <span className={cn('text-sm font-semibold', balanced ? 'text-success-text' : 'text-error-text')}>
          {balanced ? 'Ausgeglichen' : 'Nicht ausgeglichen'}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <div className="text-eyebrow uppercase text-muted">Soll</div>
          <Amount value={soll} className="mt-1 text-base font-semibold" />
        </div>
        <div>
          <div className="text-eyebrow uppercase text-muted">Haben</div>
          <Amount value={haben} className="mt-1 text-base font-semibold" />
        </div>
        <div>
          <div className="text-eyebrow uppercase text-muted">Differenz</div>
          <Amount value={differenz} className="mt-1 text-base font-semibold" />
        </div>
      </div>

      <p className="mt-3 text-control text-foreground">
        {balanced ? (
          'Soll und Haben sind ausgeglichen.'
        ) : (
          <>
            Bitte gleiche Soll und Haben noch an: Auf der {missingSide}-Seite fehlen{' '}
            <Amount value={differenz} className="inline-block font-semibold" />.
          </>
        )}
      </p>
    </div>
  );
};

BalanceIndicator.displayName = 'BalanceIndicator';
