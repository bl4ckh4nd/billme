import React from 'react';
import { cn } from '../utils/cn';

export interface HatchedProgressProps {
  /** 0..1; clamped. */
  value: number;
  /** Accessible name, e.g. "Umsatzziel September". */
  label: string;
  /** Spoken value, e.g. "68 Prozent, 4.200 Euro fehlen". Defaults to the percentage. */
  valueText?: string;
  size?: 'sm' | 'md';
  className?: string;
}

/** Filled part in lime with a dark edge, remainder hatched: the reached share
 *  is the focus, what is missing stays visible as context. */
export const HatchedProgress: React.FC<HatchedProgressProps> = ({ value, label, valueText, size = 'md', className }) => {
  const pct = Math.round(Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={valueText ?? `${pct} Prozent`}
      className={cn(
        'overflow-hidden rounded-full border border-border',
        'bg-[repeating-linear-gradient(135deg,var(--color-surface-sunken)_0_5px,var(--color-border)_5px_7px)]',
        size === 'md' ? 'h-5' : 'h-2.5',
        className,
      )}
    >
      {pct > 0 && (
        <span
          className={cn('block h-full rounded-full bg-accent', pct < 100 && 'border-r-[1.5px] border-foreground')}
          style={{ width: `${pct}%` }}
        />
      )}
    </div>
  );
};
