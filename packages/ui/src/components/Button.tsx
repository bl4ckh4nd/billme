import React from 'react';
import { cn } from '../utils/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'dark';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  loading?: boolean;
  children: React.ReactNode;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-foreground hover:bg-accent-hover shadow-sm focus-visible:outline-focus-ring disabled:border disabled:border-disabled-foreground disabled:bg-disabled-surface disabled:text-disabled-foreground',
  secondary: 'bg-surface border border-control-border text-foreground hover:bg-surface-muted focus-visible:outline-focus-ring disabled:border-disabled-foreground disabled:bg-disabled-surface disabled:text-disabled-foreground',
  danger: 'bg-error text-background hover:bg-error/90 focus-visible:outline-focus-ring disabled:border disabled:border-disabled-foreground disabled:bg-disabled-surface disabled:text-disabled-foreground',
  ghost: 'bg-surface-muted text-foreground hover:bg-border-subtle focus-visible:outline-focus-ring disabled:bg-disabled-surface disabled:text-disabled-foreground',
  dark: 'bg-dark-base text-background hover:bg-dark-1 focus-visible:outline-focus-ring-dark disabled:border disabled:border-dark-muted disabled:bg-dark-2 disabled:text-dark-muted',
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-sm rounded-lg',
  md: 'px-5 py-3 text-sm rounded-xl',
  lg: 'px-6 py-4 text-base rounded-2xl',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({
    variant = 'primary',
    size = 'md',
    fullWidth = false,
    loading = false,
    className,
    children,
    disabled,
    type = 'button',
    'aria-busy': ariaBusy,
    ...props
  }, ref) => {
    const isDisabled = Boolean(disabled || loading);

    return (
      <button
        ref={ref}
        type={type}
        disabled={isDisabled}
        aria-busy={loading ? true : ariaBusy}
        className={cn(
          'relative font-bold inline-flex items-center justify-center transition-[color,background-color,border-color,box-shadow,scale] motion-safe:active:scale-[0.96] motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2',
          variantStyles[variant],
          sizeStyles[size],
          fullWidth && 'w-full',
          isDisabled && 'cursor-not-allowed active:scale-100',
          className
        )}
        {...props}
      >
        {/* The label row is its own flex line: Tailwind's preflight makes svg
            block-level, so an inline icon would otherwise stack above the text. */}
        <span className={cn('inline-flex items-center gap-2 whitespace-nowrap', loading && 'opacity-0')}>{children}</span>
        {loading && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 m-auto size-4 rounded-full border-2 border-current border-t-transparent motion-safe:animate-spin motion-reduce:animate-none"
          />
        )}
      </button>
    );
  }
);

Button.displayName = 'Button';
