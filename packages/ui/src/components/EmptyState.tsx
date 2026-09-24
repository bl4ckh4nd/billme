import React from 'react';
import { cn } from '../utils/cn';

export interface EmptyStateProps {
  /** What is missing, from the user's point of view. Required: an empty state that does not name the cause is a defect. */
  title: string;
  /** Why it is empty and what fills it. Optional only when the title already carries both. */
  description?: React.ReactNode;
  /** The single action that fills the empty view. */
  action?: React.ReactNode;
  className?: string;
}

/**
 * The view for "there is nothing here yet".
 *
 * Distinct from a filtered-to-nothing result and from a permission denial: the
 * caller owns that distinction and passes the matching copy.
 */
export const EmptyState: React.FC<EmptyStateProps> = ({
  title,
  description,
  action,
  className,
}) => (
  <div
    className={cn(
      'flex flex-col items-center justify-center gap-1.5 rounded-card bg-surface-muted px-6 py-10 text-center',
      className,
    )}
  >
    <p className="text-sm font-medium text-foreground">{title}</p>
    {description && <p className="max-w-md text-caption text-muted">{description}</p>}
    {action && <div className="mt-2">{action}</div>}
  </div>
);

EmptyState.displayName = 'EmptyState';
