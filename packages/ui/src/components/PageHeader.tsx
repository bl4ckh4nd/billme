import React from 'react';
import { ArrowLeft } from 'lucide-react';
import { cn } from '../utils/cn';
import { IconButton } from './IconButton';

export interface PageHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Right-aligned actions; the primary action goes last. */
  actions?: React.ReactNode;
  back?: { label: string; onClick: () => void };
  /** Toolbar row under the title: search, filters, view switch. */
  toolbar?: React.ReactNode;
  className?: string;
}

/**
 * The one page title per view. Every route uses it so the title role, spacing
 * and action placement stay identical between neighbouring destinations.
 */
export const PageHeader: React.FC<PageHeaderProps> = ({ title, description, actions, back, toolbar, className }) => (
  <div className={cn('mb-6 space-y-5', className)}>
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="flex min-w-0 items-start gap-2">
        {back && (
          <IconButton aria-label={back.label} onClick={back.onClick} size="sm" className="mt-0.5 -ml-1.5">
            <ArrowLeft size={16} aria-hidden="true" />
          </IconButton>
        )}
        <div className="min-w-0">
          <h1 className="text-title text-foreground">{title}</h1>
          {description && <p className="mt-1 text-sm text-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
    {toolbar && <div className="flex flex-wrap items-center gap-3">{toolbar}</div>}
  </div>
);

PageHeader.displayName = 'PageHeader';
