import React from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft } from 'lucide-react';
import { cn } from '../utils/cn';
import { Button } from './Button';
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

type ShellSlots = { title: Element; actions: Element };

/** The app shell's top bar offers these two slots; print views, editors and tests have none. */
const findShellSlots = (): ShellSlots | null => {
  if (typeof document === 'undefined') return null;
  const title = document.querySelector('[data-shell-title]');
  const actions = document.querySelector('[data-shell-actions]');
  return title && actions ? { title, actions } : null;
};

/**
 * The one page title per view. Inside the app shell the title, description and
 * actions render into the top bar and only the back button and the toolbar row
 * stay in the content; without a shell everything renders in place.
 */
export const PageHeader: React.FC<PageHeaderProps> = ({ title, description, actions, back, toolbar, className }) => {
  const [shell, setShell] = React.useState(findShellSlots);
  // The shell can mount in the same commit as the page, so its slots are looked up again once attached.
  React.useLayoutEffect(() => {
    const next = findShellSlots();
    setShell((prev) => (prev?.title === next?.title && prev?.actions === next?.actions ? prev : next));
  }, []);

  if (shell) {
    return (
      <>
        {createPortal(
          <>
            <h1 className="truncate text-title text-foreground">{title}</h1>
            {description && (
              <p className="hidden truncate text-caption text-muted min-[1100px]:block" data-shell-subtitle>
                {description}
              </p>
            )}
          </>,
          shell.title,
        )}
        {actions && createPortal(actions, shell.actions)}
        {(back || toolbar) && (
          <div className={cn('mb-3.5 flex flex-wrap items-center gap-3', className)}>
            {back && (
              <Button variant="ghost" size="sm" onClick={back.onClick} className="-ml-1">
                <ArrowLeft size={14} aria-hidden="true" />
                {back.label}
              </Button>
            )}
            {toolbar}
          </div>
        )}
      </>
    );
  }

  return (
    <div className={cn('mb-3.5 space-y-3', className)}>
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 items-start gap-2">
          {back && (
            <IconButton aria-label={back.label} onClick={back.onClick} size="sm" className="-ml-1.5">
              <ArrowLeft size={16} aria-hidden="true" />
            </IconButton>
          )}
          <div className="min-w-0">
            <h1 className="text-title text-foreground">{title}</h1>
            {description && <p className="text-caption text-muted">{description}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {toolbar && <div className="flex flex-wrap items-center gap-3">{toolbar}</div>}
    </div>
  );
};

PageHeader.displayName = 'PageHeader';
