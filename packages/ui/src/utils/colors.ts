/**
 * Type-safe color constants synced with CSS variables
 */
export const colors = {
  accent: '#d9f944',
  accentHover: '#cbe83e',
  accentForeground: '#000000',
  accentLime: '#ccff00',
  darkBase: '#0b0d10',
  dark1: '#121417',
  dark2: '#181b1f',
  dark3: '#1f2329',
  dark4: '#272c33',
  dark5: '#333a42',
  darkMuted: '#8a929c',
  darkBorder: '#23282e',
  darkBorderSubtle: '#2e343b',
  editorViewport: '#16191d',
  background: '#ffffff',
  foreground: '#0b0b0b',
  surface: '#ffffff',
  surfaceMuted: '#f1f3f5',
  canvas: '#f3f4f6',
  mobileMint: '#d5ebd2',
  mobileMintCool: '#daebe2',
  mobileCanvas: '#90c3b6',
  mobileInkSecondary: '#393932',
  mobilePositive: '#3f813d',
  mobilePositiveBg: '#eef7ec',
  mobileNegative: '#975050',
  mobileNegativeBg: '#faeeee',
  mobileShadow: '#234e43',
  muted: '#6b7280',
  border: '#e4e7ec',
  borderSubtle: '#f1f3f5',
  onboardingCanvas: '#f4f4ef',
  onboardingPanel: '#121212',
  onboardingSurface: '#fbfbf8',
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
  statusOpenBorder: '#e4e7ec',
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
