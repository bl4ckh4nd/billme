import React from 'react';
import { cn } from '../utils/cn';

export type IconTileTone = 'neutral' | 'success' | 'warning' | 'error' | 'info';

const tileTone: Record<IconTileTone, string> = {
  neutral: 'bg-surface-sunken text-foreground-secondary',
  success: 'bg-success-bg text-success-text',
  warning: 'bg-warning-bg text-warning-text',
  error: 'bg-error-bg text-error-text',
  info: 'bg-info-bg text-info-text',
};

export interface IconTileProps {
  icon: React.ReactNode;
  /** State, not decoration: incoming = success, deadline = warning, blocking = error. */
  tone?: IconTileTone;
  className?: string;
}

export const IconTile: React.FC<IconTileProps> = ({ icon, tone = 'neutral', className }) => (
  <span aria-hidden="true" className={cn('grid size-9 shrink-0 place-items-center rounded-card', tileTone[tone], className)}>
    {icon}
  </span>
);

export interface ListRowProps {
  icon?: React.ReactNode;
  tone?: IconTileTone;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Right-aligned figure, rendered in the mono face. */
  value?: React.ReactNode;
  valueTone?: 'default' | 'success' | 'error';
  /** Makes the row a button; a trailing arrow marks it as navigation. */
  onClick?: () => void;
  className?: string;
}

const valueToneClass = { default: 'text-foreground', success: 'text-success-text', error: 'text-error-text' };

export const ListRow: React.FC<ListRowProps> = ({ icon, tone, title, subtitle, value, valueTone = 'default', onClick, className }) => {
  const content = (
    <>
      {icon && <IconTile icon={icon} tone={tone} />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-foreground">{title}</span>
        {subtitle && <span className="mt-0.5 block truncate text-caption text-muted">{subtitle}</span>}
      </span>
      {value !== undefined && (
        <span className={cn('shrink-0 whitespace-nowrap text-right text-section font-bold tabular-nums', valueToneClass[valueTone])}>{value}</span>
      )}
      {onClick && (
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0 text-muted">
          <path d="M3 8h10M9 4l4 4-4 4" />
        </svg>
      )}
    </>
  );
  const base = 'flex w-full items-center gap-3.25 border-b border-dashed border-border py-3.25 text-left last:border-b-0';
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={cn(base, 'cursor-pointer hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-focus-ring motion-safe:transition-colors', className)}
    >
      {content}
    </button>
  ) : (
    <div className={cn(base, className)}>{content}</div>
  );
};
