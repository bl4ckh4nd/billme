/**
 * Type-safe color constants synced with CSS variables
 */
export const colors = {
  accent: '#d9f944',
  accentHover: '#cbe83e',
  accentForeground: '#000000',
  darkBase: '#000000',
  dark1: '#111111',
  dark2: '#1a1a1a',
  dark3: '#1c1c1c',
  darkBorder: '#222222',
  darkBorderSubtle: '#333333',
  background: '#ffffff',
  foreground: '#0b0b0b',
  surface: '#ffffff',
  surfaceMuted: '#f9fafb',
  muted: '#6b7280',
  border: '#e5e7eb',
  borderSubtle: '#f3f4f6',
  success: '#22c55e',
  successBg: '#f0fdf4',
  successBorder: '#bbf7d0',
  warning: '#f59e0b',
  warningBg: '#fef3c7',
  warningBorder: '#fde68a',
  error: '#dc2626',
  errorBg: '#fef2f2',
  errorBorder: '#fecaca',
  info: '#3b82f6',
  infoBg: '#eff6ff',
  infoBorder: '#bfdbfe',
  statusPaid: '#d9f944',
  statusPaidText: '#000000',
  statusOpen: '#ffffff',
  statusOpenText: '#000000',
  statusOpenBorder: '#e5e7eb',
  statusOverdue: '#fef2f2',
  statusOverdueText: '#dc2626',
  statusDraft: '#f3f4f6',
  statusDraftText: '#6b7280',
} as const;

export type ColorName = keyof typeof colors;

/**
 * Get Tailwind classes for invoice status badges
 * Supports: 'paid', 'open', 'overdue', 'draft'
 */
export const getStatusColors = (status: string) => {
  const configs: Record<string, { bg: string; text: string; border: string }> = {
    paid: {
      bg: 'bg-status-paid',
      text: 'text-status-paid-text',
      border: 'border-status-paid',
    },
    open: {
      bg: 'bg-status-open',
      text: 'text-status-open-text',
      border: 'border-status-open-border',
    },
    overdue: {
      bg: 'bg-status-overdue',
      text: 'text-status-overdue-text',
      border: 'border-error',
    },
    draft: {
      bg: 'bg-status-draft',
      text: 'text-status-draft-text',
      border: 'border-border',
    },
  };
  return configs[status] || configs['draft'];
};

/**
 * Get dunning level badge configuration
 */
export const getDunningColors = (level: 1 | 2 | 3) => {
  const configs = {
    1: {
      label: '1. Mahnung',
      bg: 'bg-warning-bg',
      text: 'text-warning',
      border: 'border-warning-border',
    },
    2: {
      label: '2. Mahnung',
      bg: 'bg-error-bg',
      text: 'text-error',
      border: 'border-error-border',
    },
    3: {
      label: 'Inkasso',
      bg: 'bg-dark-base',
      text: 'text-white',
      border: 'border-dark-base',
    },
  };
  return configs[level];
};
