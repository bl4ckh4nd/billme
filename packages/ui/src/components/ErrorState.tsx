import React from 'react';
import { AlertCircle } from 'lucide-react';
import { cn } from '../utils/cn';
import { Button } from './Button';

export interface ErrorStateProps {
  /** What failed, in the user's language. Required: "Ein Fehler ist aufgetreten" tells the user nothing. */
  title: string;
  /** The cause when it is known, or the next step when it is not. */
  description?: React.ReactNode;
  /** Retry handler. Rendered as a real button when provided. */
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

/**
 * The view for "this failed". Always names the failure and offers the one next
 * action that can recover it.
 */
export const ErrorState: React.FC<ErrorStateProps> = ({
  title,
  description,
  onRetry,
  retryLabel = 'Erneut versuchen',
  className,
}) => (
  <div
    role="alert"
    className={cn(
      'flex flex-col items-center justify-center gap-2 rounded-xl border border-error-border bg-error-bg px-6 py-10 text-center',
      className,
    )}
  >
    <AlertCircle size={20} className="text-error-text" aria-hidden="true" />
    <p className="text-sm font-semibold text-error-text">{title}</p>
    {description && <p className="max-w-md text-xs text-error-text">{description}</p>}
    {onRetry && (
      <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
        {retryLabel}
      </Button>
    )}
  </div>
);

ErrorState.displayName = 'ErrorState';
