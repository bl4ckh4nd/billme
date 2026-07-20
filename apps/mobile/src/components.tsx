import type { PropsWithChildren, ReactNode } from 'react';
import * as Haptics from 'expo-haptics';
import { ActivityIndicator, Animated, PanResponder, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions, type TextInputProps } from 'react-native';
import { Check, ChevronRight, CircleAlert, CloudOff, Inbox } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, money, radius, space, typography } from './theme';

export const Screen = ({ children, scroll = true }: PropsWithChildren<{ scroll?: boolean }>) => (
  <SafeAreaView style={styles.safe} edges={['top']}>
    {scroll ? <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">{children}</ScrollView>
      : <View style={styles.screen}>{children}</View>}
  </SafeAreaView>
);

export const AppHeader = ({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: ReactNode }) => (
  <View style={styles.header}>
    <View style={styles.headerCopy}>
      {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
      <Text accessibilityRole="header" style={styles.title}>{title}</Text>
    </View>
    {action}
  </View>
);

export const Surface = ({ children, accent = false, style }: PropsWithChildren<{ accent?: boolean; style?: object }>) => (
  <View style={[styles.surface, accent && styles.accentSurface, style]}>{children}</View>
);

export const Button = ({
  label,
  onPress,
  disabled,
  loading,
  variant = 'dark',
  icon,
}: {
  label: string;
  onPress(): void | Promise<void>;
  disabled?: boolean;
  loading?: boolean;
  variant?: 'dark' | 'light' | 'accent' | 'danger';
  icon?: ReactNode;
}) => (
  <Pressable
    accessibilityRole="button"
    accessibilityState={{ disabled: disabled || loading, busy: loading }}
    disabled={disabled || loading}
    onPress={() => {
      void Haptics.selectionAsync();
      void onPress();
    }}
    style={({ pressed }) => [
      styles.button,
      styles[`button_${variant}`],
      pressed && styles.pressed,
      (disabled || loading) && styles.disabled,
    ]}
  >
    {loading ? <ActivityIndicator color={variant === 'light' ? colors.ink : colors.white} /> : icon}
    <Text style={[styles.buttonLabel, variant === 'light' && styles.buttonLabelDark]}>{label}</Text>
  </Pressable>
);

export const TextField = ({ label, error, ...props }: TextInputProps & { label: string; error?: string }) => (
  <View style={styles.fieldGroup}>
    <Text style={styles.fieldLabel}>{label}</Text>
    <TextInput
      {...props}
      accessibilityLabel={label}
      accessibilityHint={error}
      placeholderTextColor={colors.muted}
      style={[styles.field, props.multiline && styles.fieldMultiline, error && styles.fieldError]}
    />
    {error ? <Text style={styles.errorText}>{error}</Text> : null}
  </View>
);

export const SectionTitle = ({ children, action }: PropsWithChildren<{ action?: ReactNode }>) => (
  <View style={styles.sectionHeader}>
    <Text style={styles.sectionTitle}>{children}</Text>
    {action}
  </View>
);

export const Money = ({ amount, large = false, tone = 'default' }: {
  amount: number;
  large?: boolean;
  tone?: 'default' | 'positive' | 'negative';
}) => (
  <Text style={[
    large ? styles.moneyLarge : styles.money,
    tone === 'positive' && styles.positive,
    tone === 'negative' && styles.negative,
  ]}>{money(amount)}</Text>
);

export const StatusPill = ({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'success' | 'danger' | 'warning' }) => (
  <View style={[styles.pill, styles[`pill_${tone}`]]}>
    <Text style={[styles.pillText, tone === 'success' && styles.positive, tone === 'danger' && styles.negative]}>{label}</Text>
  </View>
);

export const ListRow = ({ title, detail, trailing, onPress }: {
  title: string;
  detail?: string;
  trailing?: ReactNode;
  onPress?: () => void;
}) => (
  <Pressable
    accessibilityRole={onPress ? 'button' : undefined}
    onPress={onPress}
    style={({ pressed }) => [styles.row, pressed && onPress && styles.rowPressed]}
  >
    <View style={styles.rowCopy}>
      <Text numberOfLines={1} style={styles.rowTitle}>{title}</Text>
      {detail ? <Text numberOfLines={2} style={styles.rowDetail}>{detail}</Text> : null}
    </View>
    {trailing ?? (onPress ? <ChevronRight size={20} color={colors.muted} /> : null)}
  </Pressable>
);

export const EmptyState = ({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) => (
  <View style={styles.empty}>
    <View style={styles.emptyIcon}><Inbox size={24} color={colors.inkSecondary} /></View>
    <Text style={styles.emptyTitle}>{title}</Text>
    <Text style={styles.emptyDetail}>{detail}</Text>
    {action}
  </View>
);

export const Feedback = ({ message, tone = 'error' }: { message: string; tone?: 'error' | 'offline' }) => (
  <View accessibilityRole="alert" style={[styles.feedback, tone === 'offline' && styles.feedbackOffline]}>
    {tone === 'offline' ? <CloudOff size={18} color={colors.inkSecondary} /> : <CircleAlert size={18} color={colors.error} />}
    <Text style={styles.feedbackText}>{message}</Text>
  </View>
);

export const SlideConfirm = ({ label, onConfirm, disabled }: { label: string; onConfirm(): void | Promise<void>; disabled?: boolean }) => {
  const travel = Math.min(useWindowDimensions().width - 96, 320) - 52;
  const x = new Animated.Value(0);
  const responder = PanResponder.create({
    onStartShouldSetPanResponder: () => !disabled,
    onMoveShouldSetPanResponder: (_, gesture) => !disabled && Math.abs(gesture.dx) > 4,
    onPanResponderMove: (_, gesture) => x.setValue(Math.max(0, Math.min(travel, gesture.dx))),
    onPanResponderRelease: (_, gesture) => {
      if (gesture.dx >= travel * 0.82) {
        Animated.timing(x, { toValue: travel, duration: 120, useNativeDriver: true }).start(() => void onConfirm());
      } else {
        Animated.spring(x, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
      }
    },
  });
  return (
    <View accessibilityRole="button" accessibilityLabel={label} style={[styles.slider, disabled && styles.disabled]}>
      <Text style={styles.sliderLabel}>{label}</Text>
      <Animated.View {...responder.panHandlers} style={[styles.sliderThumb, { transform: [{ translateX: x }] }]}>
        <Check size={20} color={colors.white} />
      </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  screen: { flexGrow: 1, paddingHorizontal: space.xl, paddingTop: space.lg, paddingBottom: 120, gap: space.xxl },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 56, gap: space.md },
  headerCopy: { flex: 1, gap: space.xs },
  eyebrow: { ...typography.label, color: colors.inkSecondary, textTransform: 'uppercase', letterSpacing: 1 },
  title: { ...typography.title, color: colors.ink },
  surface: {
    borderRadius: radius.xl,
    backgroundColor: colors.surface,
    padding: space.xl,
    shadowColor: colors.shadow,
    shadowOpacity: 0.09,
    shadowOffset: { width: 0, height: 10 },
    shadowRadius: 24,
    elevation: 3,
  },
  accentSurface: { backgroundColor: colors.accent },
  button: {
    minHeight: 54,
    borderRadius: radius.pill,
    paddingHorizontal: space.xl,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: space.sm,
  },
  button_dark: { backgroundColor: colors.ink },
  button_light: { backgroundColor: colors.surface },
  button_accent: { backgroundColor: colors.accent },
  button_danger: { backgroundColor: colors.error },
  buttonLabel: { ...typography.label, color: colors.white },
  buttonLabelDark: { color: colors.ink },
  pressed: { transform: [{ scale: 0.96 }], opacity: 0.92 },
  disabled: { opacity: 0.35 },
  fieldGroup: { gap: space.sm },
  fieldLabel: { ...typography.label, color: colors.inkSecondary },
  field: {
    minHeight: 52,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    color: colors.ink,
    fontSize: 17,
    paddingHorizontal: space.lg,
    borderWidth: 1,
    borderColor: 'rgba(20,20,19,0.08)',
  },
  fieldMultiline: { minHeight: 104, paddingTop: space.lg, textAlignVertical: 'top' },
  fieldError: { borderColor: colors.error },
  errorText: { ...typography.small, color: colors.error },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { ...typography.section, color: colors.ink },
  moneyLarge: { ...typography.display, color: colors.ink, fontVariant: ['tabular-nums'] },
  money: { ...typography.bodyStrong, color: colors.ink, fontVariant: ['tabular-nums'] },
  positive: { color: colors.success },
  negative: { color: colors.error },
  pill: { alignSelf: 'flex-start', borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 6, backgroundColor: colors.surfaceMuted },
  pill_neutral: { backgroundColor: colors.surfaceMuted },
  pill_success: { backgroundColor: colors.successBg },
  pill_danger: { backgroundColor: colors.errorBg },
  pill_warning: { backgroundColor: colors.warningBg },
  pillText: { ...typography.small, color: colors.inkSecondary, fontWeight: '600' },
  row: { minHeight: 68, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  rowPressed: { opacity: 0.65, transform: [{ scale: 0.99 }] },
  rowCopy: { flex: 1, gap: space.xs },
  rowTitle: { ...typography.bodyStrong, color: colors.ink },
  rowDetail: { ...typography.small, color: colors.muted },
  empty: { alignItems: 'center', paddingVertical: 48, gap: space.md },
  emptyIcon: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted },
  emptyTitle: { ...typography.section, color: colors.ink, textAlign: 'center' },
  emptyDetail: { ...typography.body, color: colors.inkSecondary, textAlign: 'center', maxWidth: 300 },
  feedback: { flexDirection: 'row', alignItems: 'center', gap: space.sm, borderRadius: radius.md, padding: space.md, backgroundColor: colors.errorBg },
  feedbackOffline: { backgroundColor: colors.warningBg },
  feedbackText: { ...typography.small, color: colors.inkSecondary, flex: 1 },
  slider: { height: 56, borderRadius: radius.pill, backgroundColor: colors.ink, justifyContent: 'center', padding: 4, overflow: 'hidden' },
  sliderLabel: { ...typography.label, color: colors.white, textAlign: 'center', opacity: 0.9 },
  sliderThumb: { position: 'absolute', left: 4, width: 48, height: 48, borderRadius: 24, backgroundColor: colors.success, alignItems: 'center', justifyContent: 'center' },
});
