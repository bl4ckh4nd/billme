import React from 'react';
import { cn } from '../utils/cn';

export type MetricSize = 'md' | 'lg';
export type MetricTone = 'neutral' | 'success' | 'warning' | 'error' | 'info';

export interface MetricProps {
  label: React.ReactNode;
  /** Pre-formatted figure, e.g. from formatCurrency. Rendered with tabular numerals. */
  value: React.ReactNode;
  /** Secondary line: basis, count, or period. */
  hint?: React.ReactNode;
  /** Colours only the marker; the label always carries the meaning (never colour alone). */
  tone?: MetricTone;
  /** dot: small status dot. tick: a short bar before the label, used in KPI rows,
   *  where neutral renders in the foreground colour instead of disappearing. */
  marker?: 'dot' | 'tick';
  size?: MetricSize;
  /** Set when the metric sits on an inverse surface. */
  inverse?: boolean;
  /** Trend beside the figure, usually a `Sparkline`. */
  sparkline?: React.ReactNode;
  className?: string;
}

const toneDot: Record<MetricTone, string | null> = {
  neutral: null,
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-error',
  info: 'bg-info',
};

export const Metric: React.FC<MetricProps> = ({ label, value, hint, tone = 'neutral', marker = 'dot', size = 'md', inverse = false, sparkline, className }) => (
  <div className={cn('min-w-0', className)}>
    <div className={cn('flex items-center gap-1.5 text-label', inverse ? 'text-inverse-muted' : 'text-muted')}>
      {marker === 'tick' ? (
        <span aria-hidden="true" className={cn('h-3.5 w-[3px] shrink-0 rounded-full', toneDot[tone] ?? 'bg-foreground')} />
      ) : toneDot[tone] && <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', toneDot[tone])} />}
      <span className="truncate">{label}</span>
    </div>
    <div className="mt-1 flex items-end justify-between gap-3">
      <div
        className={cn(
          'min-w-0 tabular-nums',
          size === 'lg' ? 'text-figure' : 'text-xl font-semibold tracking-[-0.01em]',
          inverse ? 'text-inverse-foreground' : 'text-foreground',
        )}
      >
        {value}
      </div>
      {sparkline}
    </div>
    {hint && <div className={cn('mt-1 text-caption', inverse ? 'text-inverse-muted' : 'text-muted')}>{hint}</div>}
  </div>
);
