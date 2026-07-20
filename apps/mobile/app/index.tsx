import { useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { Redirect, useRouter } from 'expo-router';
import { Fingerprint, QrCode, ShieldCheck } from 'lucide-react-native';
import { AppHeader, Button, Feedback, Screen, Surface, TextField } from '@/components';
import { useRuntime } from '@/runtime';
import { colors, space, typography } from '@/theme';

export default function EntryScreen() {
  const runtime = useRuntime();
  const router = useRouter();
  const [serverUrl, setServerUrl] = useState(process.env.EXPO_PUBLIC_BILLME_API_URL || 'http://127.0.0.1:3100');
  const [product, setProduct] = useState<'lite' | 'pro'>('lite');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (runtime.loading) return <Screen><AppHeader title="Opening Billme…" /></Screen>;
  if (runtime.session && !runtime.locked) return <Redirect href="/(tabs)" />;

  if (runtime.session && runtime.locked) {
    return (
      <Screen>
        <AppHeader eyebrow="Private workspace" title="Unlock Billme" />
        <Surface accent style={styles.unlockHero}>
          <ShieldCheck size={32} color={colors.ink} />
          <Text style={styles.heroTitle}>Your numbers stay private.</Text>
          <Text style={styles.heroCopy}>Unlock the encrypted local cache with your device security.</Text>
        </Surface>
        <Button label="Unlock" icon={<Fingerprint size={20} color={colors.white} />} onPress={() => { void runtime.unlock(); }} />
        <Button label="Sign out" variant="light" onPress={runtime.logout} />
      </Screen>
    );
  }

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await runtime.login({
        serverUrl,
        product,
        email,
        password,
        deviceName: `${Platform.OS === 'ios' ? 'iPhone/iPad' : 'Android'} · Billme`,
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <AppHeader eyebrow="Mobile command center" title="Welcome to Billme" />
      <Surface accent style={styles.hero}>
        <Text style={styles.heroKicker}>TODAY, HANDLED.</Text>
        <Text style={styles.heroTitle}>Less bookkeeping. More done.</Text>
        <Text style={styles.heroCopy}>Capture, invoice, review, and follow up without carrying the desktop app around.</Text>
      </Surface>
      <View style={styles.segment} accessibilityRole="radiogroup">
        {(['lite', 'pro'] as const).map((value) => (
          <Button key={value} label={value === 'lite' ? 'Lite' : 'Pro'} variant={product === value ? 'dark' : 'light'} onPress={() => setProduct(value)} />
        ))}
      </View>
      <View style={styles.form}>
        <TextField label="Server URL" autoCapitalize="none" keyboardType="url" value={serverUrl} onChangeText={setServerUrl} />
        <TextField label="Email" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
        <TextField label="Password" secureTextEntry value={password} onChangeText={setPassword} />
        {error ? <Feedback message={error} /> : null}
        <Button label="Open workspace" loading={busy} disabled={!email || !password || !serverUrl} onPress={submit} />
        <Button label="Pair with QR code" variant="light" icon={<QrCode size={20} color={colors.ink} />} onPress={() => router.push('/pair')} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { gap: space.md },
  unlockHero: { gap: space.md, alignItems: 'flex-start' },
  heroKicker: { ...typography.label, color: colors.ink, letterSpacing: 1.2 },
  heroTitle: { ...typography.title, color: colors.ink },
  heroCopy: { ...typography.body, color: colors.inkSecondary },
  segment: { flexDirection: 'row', gap: space.sm },
  form: { gap: space.lg },
});
