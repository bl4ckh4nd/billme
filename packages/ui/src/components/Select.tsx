import React from 'react';
import { cn } from '../utils/cn';
import { Field } from './Field';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: React.ReactNode;
  error?: React.ReactNode;
  hint?: React.ReactNode;
  fullWidth?: boolean;
  children: React.ReactNode;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({
    label,
    error,
    hint,
    fullWidth = false,
    className,
    id,
    required,
    'aria-describedby': ariaDescribedBy,
    children,
    ...props
  }, ref) => {
    const generatedId = React.useId();
    const selectId = id ?? generatedId;

    const select = (
      <select
        ref={ref}
        className={cn(
          'h-10 bg-surface border rounded-control pl-3 pr-8 text-sm text-foreground',
          'transition-[border-color,box-shadow,outline-color] motion-reduce:transition-none hover:border-ink-500',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
          'disabled:border-disabled-foreground disabled:bg-disabled-surface disabled:text-disabled-foreground disabled:placeholder:text-disabled-foreground disabled:cursor-not-allowed disabled:opacity-100',
          error ? 'border-error' : 'border-control-border',
          fullWidth && 'w-full',
          className,
        )}
        {...props}
        required={required}
      >
        {children}
      </select>
    );

    return (
      <Field
        id={selectId}
        label={label}
        required={required}
        hint={hint}
        error={error}
        className={cn(fullWidth && 'w-full')}
        aria-describedby={ariaDescribedBy}
      >
        {select}
      </Field>
    );
  },
);

Select.displayName = 'Select';
