import React from 'react';
import { cn } from '../utils/cn';

export interface SwitchProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'role'> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: React.ReactNode;
  description?: React.ReactNode;
}

/** An on/off setting that applies immediately. Use Checkbox inside forms that save later. */
export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onCheckedChange, label, description, className, disabled, id, ...props }, ref) => {
    const generatedId = React.useId();
    const switchId = id ?? generatedId;
    const labelId = `${switchId}-label`;

    const control = (
      <button
        ref={ref}
        id={switchId}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={label ? labelId : undefined}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent p-0.5',
          'transition-[background-color] duration-(--dur-micro) motion-reduce:transition-none',
          checked ? 'bg-surface-inverse' : 'bg-ink-300',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
          !label && className,
        )}
        {...props}
      >
        <span
          aria-hidden="true"
          className={cn(
            'size-4 rounded-full bg-surface shadow-sm transition-[translate] duration-(--dur-micro) ease-out-strong motion-reduce:transition-none',
            checked ? 'translate-x-4' : 'translate-x-0',
          )}
        />
      </button>
    );

    if (!label) return control;

    return (
      <div className={cn('flex items-start justify-between gap-4', className)}>
        <span className="min-w-0">
          <span id={labelId} className="block text-sm text-foreground">{label}</span>
          {description && <span className="mt-0.5 block text-caption text-muted">{description}</span>}
        </span>
        {control}
      </div>
    );
  },
);

Switch.displayName = 'Switch';
