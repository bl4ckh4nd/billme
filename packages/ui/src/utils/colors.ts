/**
 * Type-safe color constants synced with CSS variables
 */
export const colors = {
  ink0: '#ffffff',
  ink25: '#f9fafb',
  ink50: '#f3f4f6',
  ink100: '#e5e6e9',
  ink200: '#d2d4d7',
  ink300: '#b5b7bb',
  ink400: '#87898d',
  ink500: '#6f7276',
  ink600: '#64686d',
  ink700: '#4a4d52',
  ink800: '#2e3034',
  ink900: '#1a1c1f',
  ink950: '#0d0e11',
  accent: '#d9f944',
  accentHover: '#cfed41',
  accentForeground: '#0d0e11',
  accent50: '#f7fee4',
  accent100: '#edfcbf',
  accent200: '#e4fc8c',
  accent400: '#cfed41',
  accent500: '#b1cd23',
  accent600: '#8ea515',
  accent700: '#6c7e06',
  accent800: '#4d5a07',
  accent900: '#313a03',
  darkBase: '#0d0e11',
  dark1: '#181a1d',
  dark2: '#222428',
  dark3: '#181a1d',
  darkBorder: '#2e3034',
  darkBorderSubtle: '#42454a',
  darkMuted: '#aeb1b6',
  surfaceInverse: '#0d0e11',
  surfaceInverseRaised: '#181a1d',
  surfaceInverseOverlay: '#222428',
  borderInverse: '#2e3034',
  inverseForeground: '#ffffff',
  inverseMuted: '#aeb1b6',
  errorInverse: '#f87171',
  infoInverse: '#93c5fd',
  background: '#ffffff',
  foreground: '#0d0e11',
  surface: '#ffffff',
  surfaceMuted: '#f9fafb',
  surfaceSunken: '#f3f4f6',
  muted: '#64686d',
  border: '#e5e6e9',
  borderSubtle: '#f3f4f6',
  controlBorder: '#87898d',
  focusRing: '#0d0e11',
  focusRingDark: '#d9f944',
  disabledForeground: '#4a4d52',
  disabledSurface: '#e5e6e9',
  success: '#22c55e',
  successBg: '#f5fdf8',
  successBorder: '#bbf7d0',
  successText: '#15803d',
  warning: '#f59e0b',
  warningBg: '#fbf5da',
  warningBorder: '#fde68a',
  warningText: '#92400e',
  error: '#dc2626',
  errorBg: '#fcf5f5',
  errorBorder: '#fecaca',
  errorText: '#b91c1c',
  info: '#3b82f6',
  infoBg: '#f3f7fd',
  infoBorder: '#bfdbfe',
  infoText: '#1d4ed8',
  statusPaid: '#d9f944',
  statusPaidText: '#0d0e11',
  statusOpen: '#ffffff',
  statusOpenText: '#0d0e11',
  statusOpenBorder: '#6f7276',
  statusOverdue: '#fcf5f5',
  statusOverdueText: '#b91c1c',
  statusDraft: '#f3f4f6',
  statusDraftText: '#4a4d52',
  statusDraftBorder: '#6f7276',
  statusCancelledBorder: '#6f7276',
  zDropdown: 30,
  zOverlay: 40,
  zToast: 50,
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
      border: 'border-status-paid-text',
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
      text: 'text-warning-text',
      border: 'border-warning-border',
    },
    2: {
      label: '2. Mahnung',
      bg: 'bg-error-bg',
      text: 'text-error-text',
      border: 'border-error-border',
    },
    3: {
      label: 'Inkasso',
      bg: 'bg-dark-base',
      text: 'text-background',
      border: 'border-dark-base',
    },
  };
  return configs[level];
};
