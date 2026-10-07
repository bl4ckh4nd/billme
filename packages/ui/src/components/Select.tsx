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
          'min-h-8.5 appearance-none bg-surface border rounded-control py-1.5 pl-2.25 pr-6.5 text-foreground text-control',
          'bg-[linear-gradient(45deg,transparent_50%,var(--color-muted)_50%),linear-gradient(135deg,var(--color-muted)_50%,transparent_50%)] bg-[position:calc(100%-14px)_50%,calc(100%-9px)_50%] bg-[size:5px_5px,5px_5px] bg-no-repeat',
          'transition-[border-color,box-shadow,outline-color] motion-reduce:transition-none hover:border-control-border-hover',
          'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus-ring focus-visible:border-transparent',
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
