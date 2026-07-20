import { useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { ArrowLeft, ScanLine } from 'lucide-react-native';
import { Button, Feedback, Screen } from '@/components';
import { useRuntime } from '@/runtime';
import { colors, radius, space, typography } from '@/theme';

export default function PairScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const runtime = useRuntime();
  const router = useRouter();

  const scanned = async ({ data }: { data: string }) => {
    if (busy) return;
    setBusy(true);
    try {
      await runtime.exchangePairing(data, `${Platform.OS === 'ios' ? 'iPhone/iPad' : 'Android'} · Billme`, Platform.OS === 'ios' ? 'ios' : 'android');
      router.replace('/(tabs)');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  if (!permission?.granted) {
    return (
      <Screen>
        <Button label="Back" variant="light" icon={<ArrowLeft size={20} color={colors.ink} />} onPress={() => router.back()} />
        <View style={styles.center}>
          <ScanLine size={40} color={colors.ink} />
          <Text style={styles.title}>Pair this device</Text>
          <Text style={styles.copy}>Camera access is used only to scan the single-use code shown in Billme Web.</Text>
        </View>
        <Button label="Allow camera" onPress={() => { void requestPermission(); }} />
      </Screen>
    );
  }

  return (
    <View style={styles.cameraScreen}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={busy ? undefined : scanned}
      />
      <View style={styles.overlay}>
        <Button label="Back" variant="light" icon={<ArrowLeft size={20} color={colors.ink} />} onPress={() => router.back()} />
        <View style={styles.guide}><ScanLine size={48} color={colors.white} /></View>
        <Text style={styles.cameraCopy}>{busy ? 'Pairing securely…' : 'Point at the Billme pairing code'}</Text>
        {error ? <Feedback message={error} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md },
  title: { ...typography.title, color: colors.ink },
  copy: { ...typography.body, color: colors.inkSecondary, textAlign: 'center' },
  cameraScreen: { flex: 1, backgroundColor: colors.ink },
  overlay: { flex: 1, justifyContent: 'space-between', paddingHorizontal: space.xl, paddingTop: 64, paddingBottom: 64 },
  guide: { alignSelf: 'center', width: 260, height: 260, borderRadius: radius.xl, borderWidth: 3, borderColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  cameraCopy: { ...typography.bodyStrong, color: colors.white, textAlign: 'center', backgroundColor: 'rgba(20,20,19,.72)', padding: space.md, borderRadius: radius.pill },
});
