import React from 'react';
import { cn } from '../utils/cn';

export type BadgeStatus =
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

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'error' | 'accent' | 'inverse';

export type BadgeProps =
  | { status: BadgeStatus; tone?: never; children?: never; className?: string }
  | { tone: BadgeTone; status?: never; children: React.ReactNode; className?: string };

type BadgeConfig = {
  bg: string;
  text: string;
  border: string;
  label: string;
};

const statusConfig: Record<BadgeStatus, BadgeConfig> = {
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

type ToneConfig = Omit<BadgeConfig, 'label'>;

// Every pill keeps a >=3:1 boundary: the shape is what makes status scannable.
const toneConfig: Record<BadgeTone, ToneConfig> = {
  neutral: { bg: 'bg-surface-muted', text: 'text-ink-700', border: 'border-ink-500' },
  info: { bg: 'bg-info-bg', text: 'text-info-text', border: 'border-info-text' },
  success: { bg: 'bg-success-bg', text: 'text-success-text', border: 'border-success-text' },
  warning: { bg: 'bg-warning-bg', text: 'text-warning-text', border: 'border-warning-text' },
  error: { bg: 'bg-error-bg', text: 'text-error-text', border: 'border-error-text' },
  accent: { bg: 'bg-accent', text: 'text-accent-foreground', border: 'border-accent-700' },
  inverse: { bg: 'bg-surface-inverse', text: 'text-inverse-foreground', border: 'border-surface-inverse' },
};

export const Badge: React.FC<BadgeProps> = (props) => {
  const config = props.status !== undefined ? statusConfig[props.status] : toneConfig[props.tone];
  const label = props.status !== undefined ? statusConfig[props.status].label : props.children;

  return (
    <span
      className={cn(
        // ponytail: wrapping preserves complete labels on narrow layouts; replace with truncation plus an accessible description only if badges must become single-line.
        'inline-flex max-w-full items-center gap-1 whitespace-normal rounded-full border px-2 py-0.5 text-xs font-medium leading-4',
        config.bg,
        config.text,
        config.border,
        props.className
      )}
    >
      {/* inline-flex keeps a leading icon (svg is display:block) on the label's line. */}
      <span className="inline-flex min-w-0 items-center gap-1">{label}</span>
    </span>
  );
};
