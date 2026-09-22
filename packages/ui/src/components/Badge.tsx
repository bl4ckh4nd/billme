import React from 'react';
import { cn } from '../utils/cn';

export interface BadgeProps {
  status:
    | 'paid'
    | 'open'
    | 'overdue'
    | 'draft'
    | 'cancelled'
    | 'partially_paid'
    | 'dunning_1'
    | 'dunning_2'
    | 'dunning_3'
    | 'accepted'
    | 'declined'
    | 'expired';
  className?: string;
}

type BadgeConfig = {
  bg: string;
  text: string;
  border: string;
  label: string;
};

const statusConfig: Record<BadgeProps['status'], BadgeConfig> = {
  paid: {
    bg: 'bg-status-paid',
    text: 'text-status-paid-text',
    border: 'border-status-paid-text',
    label: 'Bezahlt',
  },
  open: {
    bg: 'bg-status-open',
    text: 'text-status-open-text',
    border: 'border-status-open-border',
    label: 'Offen',
  },
  overdue: {
    bg: 'bg-status-overdue',
    text: 'text-status-overdue-text',
    border: 'border-error',
    label: 'Überfällig',
  },
  draft: {
    bg: 'bg-status-draft',
    text: 'text-status-draft-text',
    border: 'border-status-draft-border',
    label: 'Entwurf',
  },
  cancelled: {
    bg: 'bg-surface-muted',
    text: 'text-muted',
    border: 'border-status-cancelled-border',
    label: 'Storniert',
  },
  partially_paid: {
    bg: 'bg-success-bg',
    text: 'text-success-text',
    border: 'border-success-text',
    label: 'Teilweise bezahlt',
  },
  dunning_1: {
    bg: 'bg-warning-bg',
    text: 'text-warning-text',
    border: 'border-warning-text',
    label: '1. Mahnung',
  },
  dunning_2: {
    bg: 'bg-error-bg',
    text: 'text-error-text',
    border: 'border-error-text',
    label: '2. Mahnung',
  },
  dunning_3: {
    bg: 'bg-dark-base',
    text: 'text-background',
    border: 'border-dark-base',
    label: '3. Mahnung',
  },
  accepted: {
    bg: 'bg-success-bg',
    text: 'text-success-text',
    border: 'border-success-text',
    label: 'Angenommen',
  },
  declined: {
    bg: 'bg-error-bg',
    text: 'text-error-text',
    border: 'border-error-text',
    label: 'Abgelehnt',
  },
  expired: {
    bg: 'bg-warning-bg',
    text: 'text-warning-text',
    border: 'border-warning-text',
    label: 'Abgelaufen',
  },
};

export const Badge: React.FC<BadgeProps> = ({ status, className }) => {
  const config = statusConfig[status];

  return (
    <span
      className={cn(
        // ponytail: wrapping preserves complete labels on narrow layouts; replace with truncation plus an accessible description only if badges must become single-line.
        'max-w-full px-3 py-1 rounded-full text-xs font-bold border inline-flex items-center gap-1 whitespace-normal',
        config.bg,
        config.text,
        config.border,
        className
      )}
    >
      <span className="min-w-0">{config.label}</span>
    </span>
  );
};
