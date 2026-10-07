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
  primary: 'border-accent bg-accent font-semibold text-accent-foreground hover:border-accent-hover hover:bg-accent-hover focus-visible:outline-focus-ring',
  secondary: 'border-border-strong bg-surface text-foreground hover:border-control-border hover:bg-surface-sunken focus-visible:outline-focus-ring',
  danger: 'border-error-border bg-error-bg text-error-text hover:border-control-border hover:bg-surface-sunken focus-visible:outline-focus-ring',
  ghost: 'bg-transparent text-foreground hover:bg-surface-sunken focus-visible:outline-focus-ring',
  dark: 'bg-surface-inverse text-inverse-foreground hover:bg-surface-inverse-raised shadow-button-inverse focus-visible:outline-focus-ring disabled:shadow-none',
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.25 text-caption',
  md: 'h-8.5 px-3',
  lg: 'h-11 px-5 text-sm',
  icon: 'size-8.5',
  'icon-sm': 'size-7',
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
          'relative inline-flex shrink-0 items-center justify-center rounded-control border border-transparent text-label font-medium transition-[color,background-color,border-color,box-shadow,scale] duration-(--dur-micro) motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2',
          !isStatic && 'motion-safe:active:scale-[0.96]',
          variantStyles[variant],
          sizeStyles[size],
          fullWidth && 'w-full',
          isDisabled && 'cursor-not-allowed active:scale-100',
          disabled && 'opacity-50',
          className
        )}
        {...props}
      >
        {/* The label row is its own flex line: Tailwind's preflight makes svg
            block-level, so an inline icon would otherwise stack above the text. */}
        <span className={cn('inline-flex items-center gap-1.75 whitespace-nowrap', loading && 'opacity-0')}>{children}</span>
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
