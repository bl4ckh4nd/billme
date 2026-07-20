import { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, CheckCircle2, RotateCw } from 'lucide-react-native';
import { receiptSchema, receiptSuggestionSchema, type Receipt, type ReceiptSuggestion } from '@billme/server-core';
import { z } from 'zod';
import { AppHeader, Button, Feedback, Screen, StatusPill, Surface, TextField } from '@/components';
import { useRuntime } from '@/runtime';
import { colors, space, typography } from '@/theme';

export default function ReceiptDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const runtime = useRuntime();
  const router = useRouter();
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [suggestion, setSuggestion] = useState<ReceiptSuggestion | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [previewUri, setPreviewUri] = useState<string | null>(null);

  const load = async () => {
    try {
      const next = await runtime.request(`/receipts/${id}`, receiptSchema);
      setReceipt(next);
      setSuggestion(next.suggestion ?? null);
      if (next.mimeType.startsWith('image/')) {
        const content = await runtime.request(`/receipts/${id}/content?format=base64`, z.object({
          mimeType: z.enum(['image/jpeg', 'image/png', 'application/pdf']),
          dataBase64: z.string().min(1),
        }));
        setPreviewUri(`data:${content.mimeType};base64,${content.dataBase64}`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  useEffect(() => { void load(); }, [id]);

  const setField = (field: keyof ReceiptSuggestion, value: string) => {
    if (!suggestion || field === 'rawText') return;
    const numeric = ['grossAmount', 'netAmount', 'vatAmount'].includes(field);
    const current = suggestion[field];
    setSuggestion({
      ...suggestion,
      [field]: { ...(current as object), value: numeric ? (value ? Number(value.replace(',', '.')) : null) : value || null, confidence: 1 },
    });
  };

  const confirm = async () => {
    if (!suggestion) return;
    setBusy(true);
    try {
      const saved = await runtime.request(`/receipts/${id}/confirm`, receiptSchema, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Reviewed and confirmed in Billme Mobile', suggestion: receiptSuggestionSchema.parse(suggestion) }),
      });
      setReceipt(saved);
      router.back();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Button label="Back" variant="light" icon={<ArrowLeft size={20} color={colors.ink} />} onPress={() => router.back()} />
      <AppHeader title="Receipt review" action={receipt ? <StatusPill label={receipt.status.replace('_', ' ')} tone={receipt.status === 'confirmed' ? 'success' : receipt.status === 'failed' ? 'danger' : 'warning'} /> : undefined} />
      {error ? <Feedback message={error} /> : null}
      {receipt?.mimeType.startsWith('image/') && previewUri ? (
        <Image
          source={{ uri: previewUri }}
          accessibilityLabel={`Original receipt ${receipt.originalName}`}
          resizeMode="contain"
          style={styles.preview}
        />
      ) : <Surface><Text style={styles.pdfLabel}>PDF · {receipt?.originalName}</Text></Surface>}
      {receipt?.status === 'failed' ? (
        <Surface style={styles.form}>
          <Text style={styles.heading}>Extraction needs another try</Text>
          <Text style={styles.copy}>{receipt.failureCode}</Text>
          <Button label="Retry extraction" icon={<RotateCw size={20} color={colors.white} />} onPress={async () => { await runtime.request(`/receipts/${id}/retry`, receiptSchema, { method: 'POST' }); await load(); }} />
        </Surface>
      ) : suggestion ? (
        <Surface style={styles.form}>
          <Text style={styles.heading}>Check every value</Text>
          <Text style={styles.copy}>Suggested values never post automatically.</Text>
          <TextField label="Merchant" value={suggestion.merchant.value ?? ''} onChangeText={(value) => setField('merchant', value)} />
          <TextField label="Invoice number" value={suggestion.invoiceNumber.value ?? ''} onChangeText={(value) => setField('invoiceNumber', value)} />
          <TextField label="Date" value={suggestion.date.value ?? ''} onChangeText={(value) => setField('date', value)} />
          <TextField label="Gross amount" keyboardType="decimal-pad" value={suggestion.grossAmount.value?.toString() ?? ''} onChangeText={(value) => setField('grossAmount', value)} />
          <TextField label="VAT amount" keyboardType="decimal-pad" value={suggestion.vatAmount.value?.toString() ?? ''} onChangeText={(value) => setField('vatAmount', value)} />
          {suggestion.suggestedAccountNumber ? <TextField label="Suggested account" value={suggestion.suggestedAccountNumber.value ?? ''} onChangeText={(value) => setField('suggestedAccountNumber', value)} /> : null}
          <Button label="Confirm receipt" loading={busy} disabled={receipt?.status !== 'needs_review'} icon={<CheckCircle2 size={20} color={colors.white} />} onPress={confirm} />
        </Surface>
      ) : <Surface><Text style={styles.copy}>Extraction is still running. This screen will update when you reopen it.</Text></Surface>}
    </Screen>
  );
}

const styles = StyleSheet.create({
  preview: { width: '100%', height: 340, borderRadius: 22, backgroundColor: colors.surface },
  pdfLabel: { ...typography.bodyStrong, color: colors.ink },
  form: { gap: space.lg },
  heading: { ...typography.section, color: colors.ink },
  copy: { ...typography.body, color: colors.inkSecondary },
});
