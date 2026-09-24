import React from 'react';
import { cn } from '../utils/cn';

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  /** Accessible name when `label` is icon-only or ambiguous. */
  ariaLabel?: string;
}

export type SegmentedSize = 'sm' | 'md';

export interface SegmentedControlProps<T extends string> {
  /** `value` alone decides T, so option literals never widen it to string. */
  options: ReadonlyArray<SegmentedOption<NoInfer<T>>>;
  value: T;
  onChange: (value: NoInfer<T>) => void;
  'aria-label': string;
  size?: SegmentedSize;
  fullWidth?: boolean;
  className?: string;
}

const itemSize: Record<SegmentedSize, string> = {
  sm: 'h-7 px-2.5',
  md: 'h-8 px-3',
};

/**
 * One choice from a small fixed set: filters, view modes, time ranges, nav.
 * A raised thumb slides to the selection; arrow keys move it (radio group).
 * The thumb is absolutely positioned, so animating its width reflows nothing.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  'aria-label': ariaLabel,
  size = 'md',
  fullWidth = false,
  className,
}: SegmentedControlProps<T>) {
  const trackRef = React.useRef<HTMLDivElement>(null);
  const itemRefs = React.useRef(new Map<T, HTMLButtonElement>());
  const [thumb, setThumb] = React.useState<{ left: number; width: number } | null>(null);
  // No slide on first paint: the thumb appears in place, then transitions.
  const [animate, setAnimate] = React.useState(false);

  const measure = React.useCallback(() => {
    const item = itemRefs.current.get(value);
    if (!item) {
      setThumb(null);
      return;
    }
    setThumb({ left: item.offsetLeft, width: item.offsetWidth });
  }, [value]);

  React.useLayoutEffect(() => {
    measure();
  }, [measure, options]);

  React.useEffect(() => {
    const frame = requestAnimationFrame(() => setAnimate(true));
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === 'undefined') return () => cancelAnimationFrame(frame);
    const observer = new ResizeObserver(() => measure());
    observer.observe(track);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [measure]);

  const move = (direction: 1 | -1) => {
    const index = options.findIndex((option) => option.value === value);
    const next = options[(index + direction + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    itemRefs.current.get(next.value)?.focus();
  };

  return (
    <div
      ref={trackRef}
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'relative isolate inline-flex items-center rounded-control bg-ink-100 p-0.5',
        fullWidth && 'flex w-full',
        className,
      )}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault();
          move(1);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault();
          move(-1);
        }
      }}
    >
      {thumb && (
        <span
          aria-hidden="true"
          className={cn(
            'absolute inset-y-0.5 left-0 -z-10 rounded-sm bg-surface shadow-sm',
            animate && 'transition-[translate,width] duration-(--dur-micro) ease-out-strong motion-reduce:transition-none',
          )}
          style={{ width: thumb.width, translate: `${thumb.left}px 0` }}
        />
      )}
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              if (node) itemRefs.current.set(option.value, node);
              else itemRefs.current.delete(option.value);
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.ariaLabel}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm text-label transition-colors motion-reduce:transition-none',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
              itemSize[size],
              fullWidth && 'flex-1',
              selected ? 'text-foreground' : 'text-muted hover:text-foreground',
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
