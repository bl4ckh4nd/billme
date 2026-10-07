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

type ToneConfig = { bg: string; text: string; border: string };

// The prototype's chip: a soft tint with a border of the same hue. The border
// is decorative; the label on its tint is what identifies the status.
const toneConfig: Record<BadgeTone, ToneConfig> = {
  neutral: { bg: 'bg-surface-sunken', text: 'text-foreground-secondary', border: 'border-border' },
  info: { bg: 'bg-info-bg', text: 'text-info-text', border: 'border-info-border' },
  success: { bg: 'bg-success-bg', text: 'text-success-text', border: 'border-success-border' },
  warning: { bg: 'bg-warning-bg', text: 'text-warning-text', border: 'border-warning-border' },
  error: { bg: 'bg-error-bg', text: 'text-error-text', border: 'border-error-border' },
  // accent-700 measures 4.38:1 on accent-50, so the label uses accent-800.
  accent: { bg: 'bg-accent-50', text: 'text-accent-800', border: 'border-accent-200' },
  inverse: { bg: 'bg-foreground', text: 'text-ground', border: 'border-foreground' },
};

const statusConfig: Record<BadgeStatus, { tone: BadgeTone; label: string }> = {
  paid: { tone: 'accent', label: 'Bezahlt' },
  open: { tone: 'info', label: 'Offen' },
  overdue: { tone: 'error', label: 'Überfällig' },
  draft: { tone: 'neutral', label: 'Entwurf' },
  cancelled: { tone: 'neutral', label: 'Storniert' },
  partially_paid: { tone: 'success', label: 'Teilweise bezahlt' },
  dunning_1: { tone: 'warning', label: '1. Mahnung' },
  dunning_2: { tone: 'error', label: '2. Mahnung' },
  dunning_3: { tone: 'inverse', label: '3. Mahnung' },
  accepted: { tone: 'success', label: 'Angenommen' },
  declined: { tone: 'error', label: 'Abgelehnt' },
  expired: { tone: 'warning', label: 'Abgelaufen' },
};

export const Badge: React.FC<BadgeProps> = (props) => {
  const tone = props.status !== undefined ? statusConfig[props.status].tone : props.tone;
  const config = toneConfig[tone];
  const label = props.status !== undefined ? statusConfig[props.status].label : props.children;

  return (
    <span
      className={cn(
        // ponytail: wrapping preserves complete labels on narrow layouts; replace with truncation plus an accessible description only if badges must become single-line.
        'inline-flex max-w-full items-center whitespace-normal rounded-full border px-1.75 py-0.5 text-micro',
        tone === 'inverse' ? 'font-semibold' : 'font-medium',
        config.bg,
        config.text,
        config.border,
        props.className
      )}
    >
      {/* inline-flex keeps a leading icon (svg is display:block) on the label's line. */}
      <span className="inline-flex min-w-0 items-center gap-1.25">{label}</span>
    </span>
  );
};
