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

// A single grey ramp by size: the semantic hues stay reserved for states, so a
// large cost block never reads as an error. The largest segment carries lime.
const RAMP = ['var(--color-accent)', 'var(--color-foreground)', 'var(--color-ink-600)', 'var(--color-ink-400)', 'var(--color-ink-300)', 'var(--color-ink-200)'];

const pctFormat = new Intl.NumberFormat('de-DE', { style: 'percent', maximumFractionDigits: 0 });

export const Donut: React.FC<DonutProps> = ({ segments, total, totalLabel = 'Gesamt', label, size = 148, className }) => {
  const sorted = [...segments].filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
  const sum = sorted.reduce((acc, s) => acc + s.value, 0);
  const stroke = size * 0.15;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;

  return (
    // Side by side only when the card is wide enough for legend names; otherwise stacked.
    <div className={cn('@container', className)}>
    <div className="grid items-center gap-4 @[26rem]:grid-cols-[auto_minmax(0,1fr)]">
      <figure className="relative mx-auto" style={{ width: size, height: size }}>
        <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-surface-sunken)" strokeWidth={stroke} />
          {sum > 0 && sorted.map((s, i) => {
            const len = (s.value / sum) * c;
            const dash = `${Math.max(0, len - 1.5)} ${c}`;
            const el = (
              <circle
                key={s.key}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={RAMP[Math.min(i, RAMP.length - 1)]}
                strokeWidth={stroke}
                strokeDasharray={dash}
                strokeDashoffset={-offset}
              />
            );
            offset += len;
            return el;
          })}
        </svg>
        <figcaption className="absolute inset-0 grid place-content-center text-center">
          <span className="text-caption text-muted">{totalLabel}</span>
          <span className="text-sm font-bold tabular-nums text-foreground">{total}</span>
        </figcaption>
      </figure>
      <ul className="flex min-w-0 flex-col gap-1.5">
        {sorted.map((s, i) => (
          <li key={s.key} className="flex items-center gap-2.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-label">
            <span
              aria-hidden="true"
              className="h-3.5 w-[3px] shrink-0 self-stretch rounded-full"
              style={{ background: RAMP[Math.min(i, RAMP.length - 1)], boxShadow: i === 0 ? 'inset 0 0 0 1px var(--color-foreground)' : undefined }}
            />
            <span className="min-w-0 flex-1 font-normal text-foreground [overflow-wrap:anywhere]">{s.label}</span>
            <span className="shrink-0 font-bold tabular-nums text-foreground">{pctFormat.format(sum ? s.value / sum : 0)}</span>
            <span className="shrink-0 whitespace-nowrap tabular-nums text-muted">{s.formatted}</span>
          </li>
        ))}
      </ul>
    </div>
    </div>
  );
};
