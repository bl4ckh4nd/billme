import React from 'react';
import { cn } from '../utils/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'dark';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  children: React.ReactNode;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-foreground hover:bg-accent-hover shadow-sm',
  secondary: 'bg-surface border border-border text-foreground hover:bg-surface-muted',
  danger: 'bg-error text-white hover:bg-error/90',
  ghost: 'bg-transparent hover:bg-surface-muted text-foreground',
  dark: 'bg-dark-base text-white hover:bg-dark-1',
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
    className,
    children,
    disabled,
    ...props
  }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled}
        className={cn(
          'font-bold transition-all duration-200 inline-flex items-center justify-center gap-2',
          variantStyles[variant],
          sizeStyles[size],
          fullWidth && 'w-full',
          disabled && 'opacity-50 cursor-not-allowed',
          className
        )}
        {...props}
      >
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';
