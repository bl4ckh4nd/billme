import React from 'react';
import { cn } from '../utils/cn';

export interface FieldProps {
  id: string;
  label?: React.ReactNode;
  required?: boolean;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  className?: string;
  'aria-describedby'?: string;
  children: React.ReactElement;
}

const hasContent = (value: React.ReactNode): boolean =>
  value !== undefined && value !== null && value !== false;

export const Field: React.FC<FieldProps> = ({
  id,
  label,
  required = false,
  hint,
  error,
  className,
  'aria-describedby': ariaDescribedBy,
  children,
}) => {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const hasHint = hasContent(hint);
  const hasError = hasContent(error);
  const childProps = children.props as Record<string, unknown>;
  const describedBy = [
    childProps['aria-describedby'],
    ariaDescribedBy,
    hasHint ? hintId : undefined,
    hasError ? errorId : undefined,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ') || undefined;

  const control = React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
    id,
    required: required ? true : childProps.required,
    'aria-describedby': describedBy,
    'aria-invalid': hasError ? true : childProps['aria-invalid'],
    'aria-required': required ? true : childProps['aria-required'],
  });

  return (
    <div className={cn('text-sm font-medium text-foreground', className)}>
      {label !== undefined && label !== null && (
        <div className="mb-2 flex items-baseline">
          <label htmlFor={id} className="block text-sm font-medium text-foreground">
            {label}
          </label>
          {/* outside the <label> so the accessible name stays exactly `label` */}
          {required && <span aria-hidden="true" className="ml-1 text-error">*</span>}
        </div>
      )}
      {control}
      {hasHint && <span id={hintId} className="mt-1 block text-xs text-muted">{hint}</span>}
      {hasError && <p id={errorId} className="mt-1 text-xs text-error-text">{error}</p>}
    </div>
  );
};

Field.displayName = 'Field';
