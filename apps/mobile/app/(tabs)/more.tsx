import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { Bell, Fingerprint, LogOut, RefreshCw, ShieldCheck } from 'lucide-react-native';
import { mobileDeviceSchema, type MobileDevice } from '@billme/server-core';
import { z } from 'zod';
import { AppHeader, Button, Feedback, ListRow, Screen, SectionTitle, StatusPill, Surface } from '@/components';
import { useRuntime } from '@/runtime';
import { colors, space, typography } from '@/theme';

export default function MoreScreen() {
  const runtime = useRuntime();
  const [devices, setDevices] = useState<MobileDevice[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setDevices(await runtime.request('/auth/device-sessions', z.array(mobileDeviceSchema)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [runtime]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const notifications = async () => {
    try {
      const permission = await Notifications.requestPermissionsAsync();
      if (!permission.granted) throw new Error('Notifications were not enabled');
      const token = await Notifications.getExpoPushTokenAsync();
      await runtime.request(`/auth/device-sessions/${runtime.session?.device.id}/push`, z.object({ ok: z.literal(true) }), {
        method: 'POST', body: JSON.stringify({ token: token.data, provider: 'expo' }),
      });
      setMessage('Actionable notifications are enabled. Sensitive amounts stay hidden.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const revoke = async (id: string) => {
    try {
      await runtime.request(`/auth/device-sessions/${id}`, z.object({ ok: z.literal(true) }), { method: 'DELETE' });
      await load();
      setMessage('Device access revoked.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <Screen>
      <AppHeader title="More" />
      <Surface accent style={styles.profile}>
        <View style={styles.avatar}><Text style={styles.avatarText}>{runtime.session?.user.fullName.slice(0, 1).toUpperCase()}</Text></View>
        <View style={styles.profileCopy}>
          <Text style={styles.name}>{runtime.session?.user.fullName}</Text>
          <Text style={styles.email}>{runtime.session?.user.email}</Text>
          <StatusPill label={`${runtime.session?.product.toUpperCase()} · ${runtime.session?.role}`} />
        </View>
      </Surface>
      {message ? <Feedback message={message} tone="offline" /> : null}
      {error ? <Feedback message={error} /> : null}
      <View style={styles.section}>
        <SectionTitle>Privacy and sync</SectionTitle>
        <Surface>
          <ListRow title="Encrypted offline cache" detail="SQLCipher · last 30 days" trailing={<ShieldCheck size={22} color={colors.success} />} />
          <ListRow title="Biometric unlock" detail="Uses device security, never sent to Billme" trailing={<Fingerprint size={22} color={colors.ink} />} />
          <ListRow title="Pending uploads" detail={`${runtime.pendingCount} waiting`} trailing={<Button label="Retry" variant="light" icon={<RefreshCw size={18} color={colors.ink} />} onPress={runtime.flushOutbox} />} />
          <ListRow title="Notifications" detail="Offers, receipts, and accounting decisions" trailing={<Button label="Enable" variant="light" icon={<Bell size={18} color={colors.ink} />} onPress={notifications} />} />
        </Surface>
      </View>
      <View style={styles.section}>
        <SectionTitle>Connected devices</SectionTitle>
        <Surface>
          {devices.map((device) => <ListRow
            key={device.id}
            title={device.name}
            detail={`Last active ${new Date(device.lastActiveAt).toLocaleString('de-DE')}`}
            trailing={device.id === runtime.session?.device.id
              ? <StatusPill label="This device" tone="success" />
              : <Button label="Revoke" variant="light" onPress={() => revoke(device.id)} />}
          />)}
        </Surface>
      </View>
      <Button label="Sign out and clear cache" variant="danger" icon={<LogOut size={20} color={colors.white} />} onPress={runtime.logout} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  profile: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  avatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  avatarText: { ...typography.title, color: colors.white },
  profileCopy: { flex: 1, gap: space.xs },
  name: { ...typography.section, color: colors.ink },
  email: { ...typography.small, color: colors.inkSecondary },
  section: { gap: space.md },
});
