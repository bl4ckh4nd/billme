import { useCallback, useState } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { ArrowUpRight, Clock3, ReceiptText } from 'lucide-react-native';
import type { MobileHome } from '@billme/server-core';
import { AppHeader, Button, EmptyState, Feedback, ListRow, Money, Screen, SectionTitle, StatusPill, Surface } from '@/components';
import { useRuntime } from '@/runtime';
import { colors, space, typography } from '@/theme';

export default function TodayScreen() {
  const runtime = useRuntime();
  const router = useRouter();
  const [home, setHome] = useState<MobileHome | null>(null);
  const [cached, setCached] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const result = await runtime.loadHome();
      setHome(result.data);
      setCached(result.cached);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [runtime]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  return (
    <Screen>
      <AppHeader
        eyebrow={`${runtime.session?.product.toUpperCase()} · ${runtime.session?.user.fullName}`}
        title="Today"
        action={cached ? <StatusPill label="Offline copy" tone="warning" /> : undefined}
      />
      {runtime.message ? <Feedback message={runtime.message} tone="offline" /> : null}
      {error ? <Feedback message={error} /> : null}
      <Surface accent style={styles.hero}>
        <View style={styles.heroTop}>
          <View>
            <Text style={styles.heroLabel}>Open receivables</Text>
            <Money amount={home?.summary.openReceivables ?? 0} large />
          </View>
          <ArrowUpRight size={28} color={colors.ink} />
        </View>
        <View style={styles.heroStats}>
          <View><Text style={styles.statLabel}>Overdue</Text><Money amount={home?.summary.overdueReceivables ?? 0} tone="negative" /></View>
          <View><Text style={styles.statLabel}>Receipts</Text><Text style={styles.statValue}>{home?.summary.receiptsToReview ?? 0}</Text></View>
          <View><Text style={styles.statLabel}>Reviews</Text><Text style={styles.statValue}>{home?.summary.bookingReviews ?? 0}</Text></View>
        </View>
      </Surface>
      <View style={styles.quickRow}>
        <Button label="Invoice" variant="light" onPress={() => router.push('/documents/new?kind=invoice')} />
        <Button label="Receipt" variant="light" icon={<ReceiptText size={18} color={colors.ink} />} onPress={() => router.push('/(tabs)/capture')} />
      </View>
      <View style={styles.section}>
        <SectionTitle>Needs attention</SectionTitle>
        <Surface>
          {home?.actions.length ? home.actions.map((action) => (
            <ListRow
              key={action.id}
              title={action.title}
              detail={action.detail}
              trailing={action.amount !== undefined ? <Money amount={action.amount} tone={action.severity === 'urgent' ? 'negative' : 'default'} /> : undefined}
              onPress={() => router.push(action.route as never)}
            />
          )) : <EmptyState title={loading ? 'Checking your workspace…' : 'Nothing needs attention'} detail="You are caught up. New decisions will appear here." />}
        </Surface>
      </View>
      <View style={styles.section}>
        <SectionTitle>Recent activity</SectionTitle>
        <Surface>
          {home?.recentActivity.length ? home.recentActivity.slice(0, 6).map((item) => (
            <ListRow key={item.id} title={item.title} detail={item.detail} onPress={() => router.push(item.route as never)} />
          )) : <EmptyState title="No activity yet" detail="Create your first invoice or capture a receipt." />}
        </Surface>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { gap: space.xl },
  heroTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  heroLabel: { ...typography.small, color: colors.inkSecondary, marginBottom: space.xs },
  heroStats: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md },
  statLabel: { ...typography.small, color: colors.inkSecondary, marginBottom: space.xs },
  statValue: { ...typography.bodyStrong, color: colors.ink, fontVariant: ['tabular-nums'] },
  quickRow: { flexDirection: 'row', gap: space.sm },
  section: { gap: space.md },
});
