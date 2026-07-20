import React from 'react';
import { cn } from '../utils/cn';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  fullWidth?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, fullWidth = false, className, ...props }, ref) => {
    const generatedId = React.useId();
    const inputId = props.id ?? generatedId;

    return (
      <div className={cn(fullWidth && 'w-full')}>
        {label && (
          <label htmlFor={inputId} className="block text-sm font-medium text-foreground mb-2">
            {label}
          </label>
        )}
        <input
          id={inputId}
          ref={ref}
          aria-invalid={error ? true : undefined}
          className={cn(
            'bg-surface-muted border border-border rounded-lg px-4 py-3 text-sm',
            'outline-none transition-all',
            'focus:ring-2 focus:ring-accent focus:border-accent',
            // Numeric inputs align by place value and don't jitter while typing.
            (props.type === 'number' || props.inputMode === 'numeric' || props.inputMode === 'decimal') && 'tabular-nums',
            error && 'border-error focus:ring-error',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            fullWidth && 'w-full',
            className
          )}
          {...props}
        />
        {error && (
          <p className="mt-1 text-xs text-error">{error}</p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';
