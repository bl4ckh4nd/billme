import React from 'react';
import { Check, Minus } from 'lucide-react';
import { cn } from '../utils/cn';

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label?: React.ReactNode;
  description?: React.ReactNode;
  indeterminate?: boolean;
}

/**
 * A native checkbox with house styling: the input keeps its semantics, keyboard
 * and form behaviour; the box and check are drawn over it.
 */
export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ label, description, indeterminate = false, className, id, disabled, ...props }, ref) => {
    const generatedId = React.useId();
    const inputId = id ?? generatedId;
    const innerRef = React.useRef<HTMLInputElement | null>(null);

    React.useEffect(() => {
      if (innerRef.current) innerRef.current.indeterminate = indeterminate;
    }, [indeterminate]);

    const setRefs = (node: HTMLInputElement | null) => {
      innerRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    };

    const box = (
      <span className="relative inline-flex size-4 shrink-0">
        <input
          ref={setRefs}
          id={inputId}
          type="checkbox"
          disabled={disabled}
          aria-checked={indeterminate ? 'mixed' : undefined}
          className={cn(
            'peer size-4 cursor-pointer appearance-none rounded-xs border border-control-border bg-surface',
            'transition-[background-color,border-color] duration-(--dur-micro) motion-reduce:transition-none',
            'hover:border-control-border-hover checked:border-selected checked:bg-selected indeterminate:border-selected indeterminate:bg-selected',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
            'disabled:cursor-not-allowed disabled:border-disabled-foreground disabled:bg-disabled-surface',
            !label && className,
          )}
          {...props}
        />
        <Check
          size={12}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 m-auto scale-50 text-selected-foreground opacity-0 transition-[opacity,scale] duration-(--dur-micro) peer-checked:scale-100 peer-checked:opacity-100 peer-indeterminate:opacity-0 motion-reduce:transition-none"
        />
        <Minus
          size={12}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 m-auto text-selected-foreground opacity-0 peer-indeterminate:opacity-100"
        />
      </span>
    );

    if (!label) return box;

    return (
      <label htmlFor={inputId} className={cn('inline-flex cursor-pointer items-start gap-2.5', disabled && 'cursor-not-allowed', className)}>
        <span className="mt-0.5">{box}</span>
        <span className="min-w-0">
          <span className="block text-control text-foreground">{label}</span>
          {description && <span className="mt-0.5 block text-caption text-muted">{description}</span>}
        </span>
      </label>
    );
  },
);

Checkbox.displayName = 'Checkbox';
