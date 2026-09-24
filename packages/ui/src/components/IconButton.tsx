import React from 'react';
import { cn } from '../utils/cn';
import { Tooltip } from './Tooltip';

export type IconButtonVariant = 'ghost' | 'secondary' | 'inverse';
export type IconButtonSize = 'sm' | 'md';

export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  /** Required: an icon-only control has no other accessible name. */
  'aria-label': string;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  /** Hover/focus label. Defaults to `aria-label`; pass shorter text, or `false` where a tooltip would be noise. */
  tooltip?: React.ReactNode | false;
  children: React.ReactNode;
}

const variantStyles: Record<IconButtonVariant, string> = {
  ghost: 'text-muted hover:bg-surface-sunken hover:text-foreground focus-visible:outline-focus-ring',
  secondary: 'bg-surface text-foreground border border-control-border hover:bg-surface-muted focus-visible:outline-focus-ring',
  inverse: 'text-inverse-muted hover:bg-surface-inverse-overlay hover:text-inverse-foreground focus-visible:outline-focus-ring-dark',
};

const sizeStyles: Record<IconButtonSize, string> = {
  sm: 'size-8',
  md: 'size-9',
};

/**
 * Square icon-only button. The visible box is 32 or 36px; a pseudo-element
 * extends the hit area to at least 40px without changing layout.
 */
export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ variant = 'ghost', size = 'md', tooltip, className, type = 'button', children, ...props }, ref) => {
    const button = (
      <button
        ref={ref}
        type={type}
        className={cn(
          'relative inline-flex shrink-0 items-center justify-center rounded-control transition-[color,background-color,border-color,scale] duration-(--dur-micro) motion-safe:active:scale-[0.96] motion-reduce:transition-none',
          'before:absolute before:-inset-1 before:content-[""]',
          'focus-visible:outline-2 focus-visible:outline-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-50',
          variantStyles[variant],
          sizeStyles[size],
          className,
        )}
        {...props}
      >
        {children}
      </button>
    );
    if (tooltip === false) return button;
    const content = tooltip ?? props['aria-label'];
    return (
      <Tooltip content={content} describe={content !== props['aria-label']}>
        {button}
      </Tooltip>
    );
  },
);

IconButton.displayName = 'IconButton';
