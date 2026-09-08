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
    const errorId = `${inputId}-error`;
    const describedBy = [props['aria-describedby'], error ? errorId : undefined]
      .filter(Boolean)
      .join(' ') || undefined;

    return (
      <div className={cn(fullWidth && 'w-full')}>
        {label && (
          <div className="mb-2 flex items-baseline">
            <label htmlFor={inputId} className="block text-sm font-medium text-foreground">
              {label}
            </label>
            {/* outside the <label> so the accessible name stays exactly `label` */}
            {props.required && (
              <span aria-hidden="true" className="ml-1 text-error">*</span>
            )}
          </div>
        )}
        <input
          id={inputId}
          ref={ref}
          className={cn(
            'bg-surface-muted border border-border rounded-xl px-4 py-3 text-sm tabular-nums',
            'outline-none transition-[border-color,box-shadow]',
            'focus:ring-2 focus:ring-accent focus:border-accent',
            error && 'border-error focus:ring-error',
            fullWidth && 'w-full',
            className
          )}
          {...props}
          aria-invalid={error ? true : props['aria-invalid']}
          aria-describedby={describedBy}
          aria-required={props.required ? true : props['aria-required']}
        />
        {error && (
          <p id={errorId} className="mt-1 text-xs text-error">{error}</p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';
