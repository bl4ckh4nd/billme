import React from 'react';
import { cn } from '../utils/cn';

export interface ValidationSummaryIssue {
  id: string;
  message: string;
}

export interface ValidationSummaryProps {
  errors: readonly ValidationSummaryIssue[];
  onJump: (id: string) => void;
  title?: string;
  className?: string;
}

/**
 * A compact, assertive summary for form validation errors.
 *
 * Each issue can point at the actual control that needs attention. Keeping the
 * navigation here means forms do not need to duplicate summary click logic.
 */
export const ValidationSummary: React.FC<ValidationSummaryProps> = ({
  errors,
  onJump,
  title = 'Bitte prüfe die markierten Felder.',
  className,
}) => {
  if (errors.length === 0) return null;

  const jumpTo = (id: string) => {
    const target = globalThis.document?.getElementById(id);
    if (target instanceof HTMLElement) {
      target.focus();
      target.scrollIntoView?.({ block: 'center' });
    }
    onJump(id);
  };

  return (
    <div
      className={cn('mb-3 rounded-lg border border-error-border bg-error-bg p-3 text-sm text-error', className)}
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
    >
      <p className="font-semibold">{title}</p>
      <ul className="mt-2 space-y-1">
        {errors.map((error) => (
          <li key={error.id}>
            <button
              type="button"
              aria-controls={error.id}
              className="w-full rounded text-left underline decoration-error/40 underline-offset-2 hover:decoration-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error"
              onClick={() => jumpTo(error.id)}
            >
              {error.message}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};
