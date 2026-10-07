import React from 'react';
import { cn } from '../utils/cn';

export interface CardHeaderProps {
  title: React.ReactNode;
  /** One line under the title: what the card answers, or its basis. */
  subtitle?: React.ReactNode;
  /** Right-aligned quiet count, e.g. "6 Vorgänge". */
  count?: React.ReactNode;
  /** Trailing controls: a segmented period switch, a `Menu` kebab. */
  actions?: React.ReactNode;
  /** Heading level; cards on a page are sections, so h2 by default. */
  as?: 'h2' | 'h3';
  /** lg: the 17px title of an overview card (Übersicht). */
  size?: 'md' | 'lg';
  className?: string;
}

export const CardHeader: React.FC<CardHeaderProps> = ({ title, subtitle, count, actions, as: Heading = 'h2', size = 'md', className }) => (
  <div className={cn('flex flex-wrap items-start gap-x-3 gap-y-2', className)}>
    <div className="min-w-[12rem] flex-1">
      <Heading className={size === 'lg' ? 'text-heading text-foreground' : 'text-section text-foreground'}>{title}</Heading>
      {subtitle && <p className="mt-0.5 text-caption text-muted">{subtitle}</p>}
    </div>
    {count && <span className="shrink-0 whitespace-nowrap pt-0.5 text-control text-muted">{count}</span>}
    {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
  </div>
);
