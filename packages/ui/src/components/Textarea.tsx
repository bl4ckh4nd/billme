import React from 'react';
import { cn } from '../utils/cn';
import { Field } from './Field';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: React.ReactNode;
  error?: React.ReactNode;
  hint?: React.ReactNode;
  fullWidth?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({
    label,
    error,
    hint,
    fullWidth = false,
    className,
    id,
    required,
    readOnly,
    'aria-describedby': ariaDescribedBy,
    ...props
  }, ref) => {
    const generatedId = React.useId();
    const textareaId = id ?? generatedId;

    const textarea = (
      <textarea
        ref={ref}
        className={cn(
          'bg-surface border rounded-control px-2.25 py-1.5 text-foreground text-control min-h-24 resize-y hover:border-control-border-hover',
          'transition-[border-color,box-shadow,outline-color] motion-reduce:transition-none',
          'placeholder:text-muted',
          'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus-ring focus-visible:border-transparent',
          'disabled:border-disabled-foreground disabled:bg-disabled-surface disabled:text-disabled-foreground disabled:placeholder:text-disabled-foreground disabled:cursor-not-allowed disabled:opacity-100',
          readOnly && 'bg-surface-sunken read-only:text-muted',
          error ? 'border-error' : 'border-control-border',
          fullWidth && 'w-full',
          className,
        )}
        {...props}
        required={required}
        readOnly={readOnly}
      />
    );

    return (
      <Field
        id={textareaId}
        label={label}
        required={required}
        hint={hint}
        error={error}
        className={cn(fullWidth && 'w-full')}
        aria-describedby={ariaDescribedBy}
      >
        {textarea}
      </Field>
    );
  },
);

Textarea.displayName = 'Textarea';
