import React from 'react';
import { cn } from '../utils/cn';

export interface BarListItem {
  key: string;
  label: string;
  /** Secondary line, e.g. the account number or a count. */
  hint?: string;
  value: number;
  /** The figure as shown; defaults to formatValue(value). */
  formatted?: string;
}

export interface BarListProps {
  items: ReadonlyArray<BarListItem>;
  formatValue: (value: number) => string;
  /** Names the list for assistive tech. */
  'aria-label': string;
  /** Row click, e.g. open the bookings of that category; rows become buttons. */
  onSelect?: (key: string) => void;
  /** `foreground` for the measure in focus, `muted` for context (e.g. expenses beside income). */
  tone?: 'foreground' | 'muted';
  className?: string;
}

/**
 * Ranked list with a share bar behind each row: the bar is the value against the largest one, the figure sits at the
 * end. Rows are buttons when the list opens something. No colour carries meaning; the label and figure do.
 */
export const BarList: React.FC<BarListProps> = ({ items, formatValue, 'aria-label': ariaLabel, onSelect, tone = 'foreground', className }) => {
  const max = Math.max(0, ...items.map((item) => Math.abs(item.value)));
  return (
    <ul aria-label={ariaLabel} className={cn('flex flex-col gap-1', className)}>
      {items.map((item) => {
        const share = max > 0 ? Math.abs(item.value) / max : 0;
        const content = (
          <>
            <span
              aria-hidden="true"
              className={cn('absolute inset-y-0 left-0 rounded-control', tone === 'foreground' ? 'bg-surface-sunken' : 'bg-surface-muted')}
              style={{ width: `${Math.max(share * 100, 2)}%` }}
            />
            <span className="relative min-w-0 flex-1 truncate text-left">
              <span className="text-control text-foreground">{item.label}</span>
              {item.hint ? <span className="ml-2 text-caption text-muted">{item.hint}</span> : null}
            </span>
            <span className="relative shrink-0 text-control font-medium tabular-nums text-foreground">{item.formatted ?? formatValue(item.value)}</span>
          </>
        );
        return (
          <li key={item.key}>
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(item.key)}
                className="relative flex w-full items-center gap-3 overflow-hidden rounded-control px-2.5 py-1.5 hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              >
                {content}
              </button>
            ) : (
              <div className="relative flex items-center gap-3 overflow-hidden rounded-control px-2.5 py-1.5">{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
};
