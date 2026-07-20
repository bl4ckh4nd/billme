import { colors as billmeColors } from '@billme/ui/colors';

export const colors = {
  canvas: billmeColors.mobileMint,
  canvasCool: billmeColors.mobileMintCool,
  canvasDeep: billmeColors.mobileCanvas,
  surface: billmeColors.surface,
  surfaceMuted: billmeColors.surfaceMuted,
  accent: billmeColors.accent,
  ink: billmeColors.foreground,
  inkSecondary: billmeColors.mobileInkSecondary,
  muted: billmeColors.muted,
  border: billmeColors.border,
  success: billmeColors.mobilePositive,
  successBg: billmeColors.mobilePositiveBg,
  error: billmeColors.mobileNegative,
  errorBg: billmeColors.mobileNegativeBg,
  warning: billmeColors.warning,
  warningBg: billmeColors.warningBg,
  white: billmeColors.background,
  shadow: billmeColors.mobileShadow,
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 } as const;
export const radius = { sm: 10, md: 16, lg: 22, xl: 28, pill: 999 } as const;
export const typography = {
  display: { fontSize: 40, lineHeight: 44, fontWeight: '600' as const, letterSpacing: -1.4 },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '700' as const, letterSpacing: -0.4 },
  section: { fontSize: 17, lineHeight: 22, fontWeight: '700' as const },
  body: { fontSize: 17, lineHeight: 24, fontWeight: '400' as const },
  bodyStrong: { fontSize: 17, lineHeight: 22, fontWeight: '600' as const },
  small: { fontSize: 14, lineHeight: 19, fontWeight: '400' as const },
  label: { fontSize: 14, lineHeight: 18, fontWeight: '700' as const },
} as const;

export const money = (amount: number, currency = 'EUR'): string => new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency,
}).format(amount);
