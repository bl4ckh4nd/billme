import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { Camera, FilePlus2, FileUp, ReceiptText } from 'lucide-react-native';
import { AppHeader, Button, Feedback, Screen, Surface } from '@/components';
import { useRuntime } from '@/runtime';
import { colors, radius, space, typography } from '@/theme';

const toHex = (buffer: ArrayBuffer): string => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export default function CaptureScreen() {
  const runtime = useRuntime();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const queueFile = async (uri: string, name: string, mimeType: string) => {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const file = new File(uri);
      const bytes = await file.bytes();
      if (bytes.byteLength > 15 * 1024 * 1024) throw new Error('Receipt is larger than 15 MB');
      const acceptedMime = mimeType === 'application/pdf' ? 'application/pdf' : mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
      const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
      const id = Crypto.randomUUID();
      await runtime.queueReceipt({
        metadata: { id, originalName: name, mimeType: acceptedMime, sha256: toHex(digest) },
        dataBase64: await file.base64(),
        sourceUri: uri,
      });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setMessage(runtime.pendingCount > 0 ? 'Receipt saved securely. Upload resumes automatically.' : 'Receipt uploaded. Extraction is running.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const camera = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return setError('Camera permission is required to capture a receipt');
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.9 });
    const asset = result.assets?.[0];
    if (!result.canceled && asset) await queueFile(asset.uri, asset.fileName || `receipt-${Date.now()}.jpg`, asset.mimeType || 'image/jpeg');
  };

  const document = async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: ['application/pdf', 'image/jpeg', 'image/png'], copyToCacheDirectory: true });
    const asset = result.assets?.[0];
    if (!result.canceled && asset) await queueFile(asset.uri, asset.name, asset.mimeType || 'application/pdf');
  };

  return (
    <Screen>
      <AppHeader eyebrow="One action at a time" title="Create" />
      <Surface accent style={styles.hero}>
        <ReceiptText size={32} color={colors.ink} />
        <Text style={styles.heroTitle}>Capture it before it disappears.</Text>
        <Text style={styles.heroCopy}>The original is encrypted locally first. Review every extracted value before it touches accounting.</Text>
        <Button label="Photograph receipt" loading={busy} icon={<Camera size={20} color={colors.white} />} onPress={camera} />
        <Button label="Choose PDF or image" variant="light" icon={<FileUp size={20} color={colors.ink} />} onPress={document} />
      </Surface>
      <View style={styles.grid}>
        <Surface style={styles.tile}><FilePlus2 size={24} color={colors.ink} /><Text style={styles.tileTitle}>Invoice</Text><Button label="Create" variant="dark" onPress={() => router.push('/documents/new?kind=invoice')} /></Surface>
        <Surface style={styles.tile}><FilePlus2 size={24} color={colors.ink} /><Text style={styles.tileTitle}>Offer</Text><Button label="Create" variant="dark" onPress={() => router.push('/documents/new?kind=offer')} /></Surface>
      </View>
      {message ? <Feedback message={message} tone="offline" /> : null}
      {error ? <Feedback message={error} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { gap: space.lg },
  heroTitle: { ...typography.title, color: colors.ink },
  heroCopy: { ...typography.body, color: colors.inkSecondary },
  grid: { flexDirection: 'row', gap: space.md },
  tile: { flex: 1, gap: space.md, borderRadius: radius.lg },
  tileTitle: { ...typography.section, color: colors.ink },
});
