import React from 'react';
import { cn } from '../utils/cn';

export interface DonutSegment {
  key: string;
  label: string;
  value: number;
  /** Pre-formatted amount for the legend row. */
  formatted: string;
}

export interface DonutProps {
  segments: DonutSegment[];
  /** Centre figure, pre-formatted. */
  total: string;
  totalLabel?: string;
  /** Accessible name of the chart. */
  label: string;
  size?: number;
  className?: string;
}

// One hue, lightness by size: the semantic hues stay reserved for states, so a
// large cost block never reads as an error. The largest segment carries lime.
const RAMP = ['var(--color-accent)', 'var(--color-donut-2)', 'var(--color-donut-3)', 'var(--color-donut-4)', 'var(--color-donut-5)'];

// Drawn on a 160 grid like the prototype: an 18 wide ring with 3 between segments.
const BOX = 160;
const STROKE = 18;
const GAP = 3;
const R = (BOX - STROKE) / 2;
const C = 2 * Math.PI * R;

const pctFormat = new Intl.NumberFormat('de-DE', { style: 'percent', maximumFractionDigits: 0 });

export const Donut: React.FC<DonutProps> = ({ segments, total, totalLabel = 'Gesamt', label, size = 134, className }) => {
  const sorted = [...segments].filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
  const sum = sorted.reduce((acc, s) => acc + s.value, 0);
  let offset = 0;

  return (
    // Legend beside the ring once a row keeps room for its name; stacked in a narrower card.
    <div className={cn('@container', className)}>
    <div className="grid items-center justify-items-center gap-3.5 @[24rem]:grid-cols-[auto_minmax(0,1fr)]">
      <figure className="relative" style={{ width: size, height: size }}>
        <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${BOX} ${BOX}`} className="-rotate-90">
          <circle cx={BOX / 2} cy={BOX / 2} r={R} fill="none" stroke="var(--color-surface-sunken)" strokeWidth={STROKE} />
          {sum > 0 && sorted.map((s, i) => {
            const len = (s.value / sum) * C;
            const shown = sorted.length > 1 ? Math.max(0.5, len - GAP) : len;
            const el = (
              <circle
                key={s.key}
                cx={BOX / 2}
                cy={BOX / 2}
                r={R}
                fill="none"
                stroke={RAMP[Math.min(i, RAMP.length - 1)]}
                strokeWidth={STROKE}
                strokeDasharray={`${shown} ${C - shown}`}
                strokeDashoffset={-offset}
              />
            );
            offset += len;
            return el;
          })}
          <circle cx={BOX / 2} cy={BOX / 2} r={R - STROKE / 2 - 1} fill="none" stroke="var(--color-border)" strokeWidth={1} />
        </svg>
        <figcaption className="absolute inset-0 grid place-content-center text-center">
          <span className="text-base font-bold tabular-nums text-foreground">{total}</span>
          <span className="text-micro text-muted">{totalLabel}</span>
        </figcaption>
      </figure>
      <ul className="flex w-full min-w-0 flex-col gap-1.75">
        {sorted.map((s, i) => (
          <li key={s.key} className="flex items-center gap-2.25 rounded-control border border-border bg-surface px-2.5 py-1.75 text-control">
            <span
              aria-hidden="true"
              className={i === 0 ? 'min-h-3.75 w-0.75 shrink-0 self-stretch rounded-xs outline outline-foreground' : 'min-h-3.75 w-0.75 shrink-0 self-stretch rounded-xs'}
              style={{ background: RAMP[Math.min(i, RAMP.length - 1)] }}
            />
            <span className="min-w-0 flex-1 text-foreground [overflow-wrap:anywhere]">{s.label}</span>
            <span className="shrink-0 font-bold tabular-nums text-foreground">{pctFormat.format(sum ? s.value / sum : 0)}</span>
            <span className="shrink-0 whitespace-nowrap tabular-nums text-muted">{s.formatted}</span>
          </li>
        ))}
      </ul>
    </div>
    </div>
  );
};
