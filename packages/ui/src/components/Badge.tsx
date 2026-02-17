import React from 'react';
import { cn } from '../utils/cn';

export interface BadgeProps {
  status: 'paid' | 'open' | 'overdue' | 'draft' | 'cancelled';
  className?: string;
}

const statusConfig = {
  paid: {
    bg: 'bg-status-paid',
    text: 'text-status-paid-text',
    border: 'border-status-paid',
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
    border: 'border-border',
    label: 'Entwurf',
  },
  cancelled: {
    bg: 'bg-gray-100',
    text: 'text-gray-600',
    border: 'border-gray-300',
    label: 'Storniert',
  },
};

export const Badge: React.FC<BadgeProps> = ({ status, className }) => {
  const config = statusConfig[status];

  return (
    <span
      className={cn(
        'px-3 py-1 rounded-full text-xs font-bold border inline-flex items-center gap-1',
        config.bg,
        config.text,
        config.border,
        className
      )}
    >
      {config.label}
    </span>
  );
};
