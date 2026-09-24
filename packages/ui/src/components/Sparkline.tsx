import React from 'react';
import { cn } from '../utils/cn';

export interface SparklineProps {
  /** Oldest first; the last value is the current period and gets a dot. */
  values: readonly number[];
  /** Spoken summary, e.g. "Umsatz der letzten 6 Monate". The trend is appended. */
  'aria-label': string;
  /** Set on an inverse surface: lime line instead of ink. */
  inverse?: boolean;
  className?: string;
}

/**
 * Word-sized trend line: no axes, no labels, shape only. The figure beside it
 * carries the number, so the line never has to be read exactly.
 */
export const Sparkline: React.FC<SparklineProps> = ({ values, 'aria-label': ariaLabel, inverse = false, className }) => {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  // x and y in percent of the box; y is inverted and kept inside a 2px inset so the stroke is not clipped.
  const points = values.map((value, index) => ({
    x: (index / (values.length - 1)) * 100,
    y: 100 - ((value - min) / span) * 100,
  }));
  const last = points[points.length - 1]!;
  const previous = values[values.length - 2]!;
  const current = values[values.length - 1]!;
  const trend = current > previous ? 'zuletzt steigend' : current < previous ? 'zuletzt fallend' : 'zuletzt unverändert';

  return (
    <span
      role="img"
      aria-label={`${ariaLabel}, ${trend}`}
      className={cn('relative inline-block h-8 w-24 shrink-0 py-0.5', inverse ? 'text-accent' : 'text-ink-500', className)}
    >
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="size-full overflow-visible" aria-hidden="true">
        <polyline
          points={points.map((point) => `${point.x},${point.y}`).join(' ')}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span
        aria-hidden="true"
        className={cn('absolute size-1.5 -translate-1/2 rounded-full', inverse ? 'bg-accent' : 'bg-foreground')}
        style={{ left: `${last.x}%`, top: `calc(0.125rem + (100% - 0.25rem) * ${last.y / 100})` }}
      />
    </span>
  );
};

Sparkline.displayName = 'Sparkline';
