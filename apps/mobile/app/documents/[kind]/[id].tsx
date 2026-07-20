import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, Download } from 'lucide-react-native';
import { invoiceSchema, offerSchema } from '@billme/server-core';
import { z } from 'zod';
import { AppHeader, Button, Feedback, ListRow, Money, Screen, SectionTitle, StatusPill, Surface } from '@/components';
import { useRuntime } from '@/runtime';
import { colors, space, typography } from '@/theme';

export default function DocumentDetailScreen() {
  const { id, kind } = useLocalSearchParams<{ id: string; kind: 'invoice' | 'offer' }>();
  const runtime = useRuntime();
  const router = useRouter();
  const [document, setDocument] = useState<z.output<typeof invoiceSchema> | z.output<typeof offerSchema> | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    void runtime.request(`/documents/${kind}/${id}`, z.union([invoiceSchema, offerSchema]))
      .then(setDocument)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [id, kind]);

  const share = async () => {
    try {
      const response = await runtime.fetchAuthorized(`/documents/${kind}/${id}/pdf`);
      if (response.status === 202) return setMessage('PDF rendering started. Try again in a few seconds.');
      if (!response.ok) throw new Error(`PDF failed with ${response.status}`);
      const file = new File(Paths.cache, `${document?.number || id}.pdf`);
      file.create({ overwrite: true });
      file.write(new Uint8Array(await response.arrayBuffer()));
      try {
        await Sharing.shareAsync(file.uri, { mimeType: 'application/pdf', dialogTitle: `Share ${document?.number}` });
      } finally {
        file.delete();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <Screen>
      <Button label="Back" variant="light" icon={<ArrowLeft size={20} color={colors.ink} />} onPress={() => router.back()} />
      <AppHeader eyebrow={kind === 'invoice' ? 'Invoice' : 'Offer'} title={document?.number ?? 'Loading…'} action={document ? <StatusPill label={document.status} /> : undefined} />
      {error ? <Feedback message={error} /> : null}
      {message ? <Feedback message={message} tone="offline" /> : null}
      {document ? <>
        <Surface accent style={styles.hero}>
          <Text style={styles.label}>Total</Text>
          <Money amount={document.amount} large />
          <Text style={styles.client}>{document.client}</Text>
        </Surface>
        <View style={styles.actions}>
          <Button label="Share PDF" icon={<Download size={20} color={colors.white} />} onPress={share} />
        </View>
        <View style={styles.section}>
          <SectionTitle>Line items</SectionTitle>
          <Surface>{document.items.map((item, index) => <ListRow key={`${item.description}:${index}`} title={item.description} detail={`${item.quantity} × ${item.price.toFixed(2)} €`} trailing={<Money amount={item.total} />} />)}</Surface>
        </View>
        <View style={styles.section}>
          <SectionTitle>History</SectionTitle>
          <Surface>{document.history.length ? document.history.map((item, index) => <ListRow key={`${item.date}:${index}`} title={item.action} detail={item.date} />) : <Text style={styles.client}>No history yet.</Text>}</Surface>
        </View>
      </> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { gap: space.sm },
  label: { ...typography.small, color: colors.inkSecondary },
  client: { ...typography.body, color: colors.inkSecondary },
  actions: { gap: space.sm },
  section: { gap: space.md },
});
