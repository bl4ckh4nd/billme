import React from 'react';
import { cn } from '../utils/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'dark';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  loading?: boolean;
  /** Turns off the press scale where motion would distract (dense toolbars, repeated steppers). */
  static?: boolean;
  children: React.ReactNode;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-foreground hover:bg-accent-hover shadow-button focus-visible:outline-focus-ring disabled:shadow-none disabled:border disabled:border-disabled-foreground disabled:bg-disabled-surface disabled:text-disabled-foreground',
  secondary: 'bg-surface border border-control-border text-foreground hover:bg-surface-muted hover:border-ink-500 focus-visible:outline-focus-ring disabled:border-disabled-foreground disabled:bg-disabled-surface disabled:text-disabled-foreground',
  danger: 'bg-error text-background hover:bg-error/90 shadow-xs focus-visible:outline-focus-ring disabled:shadow-none disabled:border disabled:border-disabled-foreground disabled:bg-disabled-surface disabled:text-disabled-foreground',
  ghost: 'bg-transparent text-foreground hover:bg-surface-sunken focus-visible:outline-focus-ring disabled:bg-disabled-surface disabled:text-disabled-foreground',
  dark: 'bg-surface-inverse text-inverse-foreground hover:bg-surface-inverse-raised shadow-button-inverse focus-visible:outline-focus-ring disabled:shadow-none disabled:border disabled:border-dark-muted disabled:bg-dark-2 disabled:text-dark-muted',
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-10 px-4 text-sm',
  lg: 'h-11 px-5 text-sm',
  icon: 'size-10',
  'icon-sm': 'size-8',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({
    variant = 'primary',
    size = 'md',
    fullWidth = false,
    loading = false,
    static: isStatic = false,
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
          'relative inline-flex shrink-0 items-center justify-center rounded-control font-semibold transition-[color,background-color,border-color,box-shadow,scale] duration-(--dur-micro) motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2',
          !isStatic && 'motion-safe:active:scale-[0.96]',
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
