import React from 'react';
import { cn } from '../utils/cn';

export type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg';

export interface SpinnerProps {
  size?: SpinnerSize;
  /** Accessible name. Pass `null` when a visible label beside it already says what is loading. */
  label?: string | null;
  className?: string;
}

const sizeStyles: Record<SpinnerSize, string> = {
  xs: 'size-3.5 border-[1.5px]',
  sm: 'size-4 border-2',
  md: 'size-6 border-2',
  lg: 'size-8 border-[2.5px]',
};

/** The only loading spinner: currentColor ring, reduced-motion safe. */
export const Spinner: React.FC<SpinnerProps> = ({ size = 'md', label = 'Lädt …', className }) => (
  <span
    role={label ? 'status' : undefined}
    aria-label={label ?? undefined}
    aria-hidden={label ? undefined : true}
    className={cn(
      'inline-block shrink-0 rounded-full border-current border-t-transparent opacity-70 motion-safe:animate-spin motion-reduce:animate-none',
      sizeStyles[size],
      className,
    )}
  />
);
