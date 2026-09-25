import React from 'react';
import { cn } from '../utils/cn';

export interface StepperProps {
  steps: string[];
  /** Index of the current step; earlier steps count as done. -1 = none reached. */
  current: number;
  label: string;
  className?: string;
}

/** A workflow position as a row of pills, e.g. Importiert → Gebucht. */
export const Stepper: React.FC<StepperProps> = ({ steps, current, label, className }) => (
  <ol aria-label={label} className={cn('flex flex-wrap items-center gap-1', className)}>
    {steps.map((step, i) => (
      <li
        key={step}
        aria-current={i === current ? 'step' : undefined}
        className={cn(
          'whitespace-nowrap rounded-full border px-2 py-0.5 text-caption font-medium',
          i === current
            ? 'border-selected bg-selected font-semibold text-selected-foreground'
            : i < current
              ? 'border-control-border bg-surface-sunken text-foreground'
              : 'border-border bg-surface-sunken text-muted',
        )}
      >
        {step}
      </li>
    ))}
  </ol>
);

export interface TimelineEntry {
  key: string;
  title: React.ReactNode;
  meta?: React.ReactNode;
  tone?: 'neutral' | 'success' | 'warning';
}

const dotTone = { neutral: 'bg-control-border', success: 'bg-success', warning: 'bg-warning' };

export const Timeline: React.FC<{ entries: TimelineEntry[]; label: string; className?: string }> = ({ entries, label, className }) => (
  <ol aria-label={label} className={cn('flex flex-col', className)}>
    {entries.map((e, i) => (
      <li key={e.key} className="relative grid grid-cols-[14px_1fr] gap-2 pb-3 last:pb-0">
        {i < entries.length - 1 && <span aria-hidden="true" className="absolute bottom-0 left-[6px] top-3.5 w-px bg-border" />}
        <span aria-hidden="true" className={cn('ml-[3px] mt-[5px] size-[7px] rounded-full', dotTone[e.tone ?? 'neutral'])} />
        <span className="min-w-0">
          <span className="block text-caption text-foreground">{e.title}</span>
          {e.meta && <span className="block text-[0.6875rem] text-muted">{e.meta}</span>}
        </span>
      </li>
    ))}
  </ol>
);
