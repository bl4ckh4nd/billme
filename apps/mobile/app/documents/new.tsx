import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, ArrowRight, Check, Send } from 'lucide-react-native';
import {
  clientSchema,
  mobileDocumentFinalizeResponseSchema,
} from '@billme/server-core';
import { z } from 'zod';
import { AppHeader, Button, Feedback, ListRow, Money, Screen, SectionTitle, StatusPill, Surface, TextField } from '@/components';
import { useRuntime } from '@/runtime';
import { cacheGet, cacheSet, loadLatestDraft, removeDraft, saveDraft } from '@/storage';
import { colors, space, typography } from '@/theme';

const addDays = (date: string, days: number): string => {
  const next = new Date(`${date}T12:00:00`);
  next.setDate(next.getDate() + days);
  return next.toISOString().slice(0, 10);
};

export default function NewDocumentScreen() {
  const params = useLocalSearchParams<{ kind?: 'invoice' | 'offer'; clientId?: string }>();
  const kind = params.kind === 'offer' ? 'offer' : 'invoice';
  const runtime = useRuntime();
  const router = useRouter();
  const [draftId, setDraftId] = useState(() => Crypto.randomUUID());
  const [mutationId, setMutationId] = useState(() => Crypto.randomUUID());
  const [hydrated, setHydrated] = useState(false);
  const [step, setStep] = useState(0);
  const [clients, setClients] = useState<z.output<typeof clientSchema>[]>([]);
  const [clientId, setClientId] = useState(params.clientId ?? '');
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [price, setPrice] = useState('');
  const [sendNow, setSendNow] = useState(true);
  const [subject, setSubject] = useState(kind === 'invoice' ? 'Your invoice' : 'Your offer');
  const [bodyText, setBodyText] = useState(kind === 'invoice' ? 'Thank you for your business.' : 'We are pleased to send you our offer.');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const client = clients.find((entry) => entry.id === clientId);
  const total = (Number(quantity) || 0) * (Number(price.replace(',', '.')) || 0);

  useEffect(() => {
    void runtime.request('/clients', z.array(clientSchema)).then(async (next) => {
      setClients(next);
      await cacheSet(`clients:${runtime.session?.tenantId}:${runtime.session?.product}`, next);
    }).catch(async (cause) => {
      const stored = await cacheGet<z.output<typeof clientSchema>[]>(`clients:${runtime.session?.tenantId}:${runtime.session?.product}`);
      if (stored) setClients(stored);
      else setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, []);
  useEffect(() => {
    void loadLatestDraft<{
      mutationId: string; clientId: string; description: string; quantity: string; price: string;
      sendNow: boolean; subject: string; bodyText: string; step: number;
    }>(kind).then((saved) => {
      if (saved) {
        setDraftId(saved.id);
        setMutationId(saved.value.mutationId);
        if (!params.clientId) setClientId(saved.value.clientId);
        setDescription(saved.value.description);
        setQuantity(saved.value.quantity);
        setPrice(saved.value.price);
        setSendNow(saved.value.sendNow);
        setSubject(saved.value.subject);
        setBodyText(saved.value.bodyText);
        setStep(saved.value.step);
      }
      setHydrated(true);
    });
  }, [kind]);
  useEffect(() => {
    if (!hydrated) return;
    void saveDraft(draftId, kind, { mutationId, clientId, description, quantity, price, sendNow, subject, bodyText, step });
  }, [bodyText, clientId, description, draftId, hydrated, kind, mutationId, price, quantity, sendNow, step, subject]);

  const valid = step === 0 ? Boolean(client) : step === 1 ? Boolean(description.trim() && Number(quantity) > 0 && total > 0) : true;
  const finish = async () => {
    if (!client) return;
    setBusy(true);
    setError('');
    try {
      const today = new Date().toISOString().slice(0, 10);
      const address = client.addresses.find((entry) => entry.isDefaultBilling) ?? client.addresses[0];
      const item = { description: description.trim(), quantity: Number(quantity), price: Number(price.replace(',', '.')), total };
      const common = {
        kind,
        id: draftId,
        clientId: client.id,
        clientNumber: client.customerNumber,
        projectId: client.projects.find((project) => project.status === 'active')?.id,
        client: client.company,
        clientEmail: client.email,
        clientAddress: client.address,
        billingAddress: address ? {
          company: address.company,
          contactPerson: address.contactPerson,
          street: address.street,
          line2: address.line2,
          city: address.city,
          postalCode: address.zip,
          country: address.country,
        } : undefined,
        taxMode: 'standard_vat' as const,
        date: today,
        amount: total,
        items: [item],
        history: [],
      };
      const draft = kind === 'invoice'
        ? { ...common, kind: 'invoice' as const, dueDate: addDays(today, 14), status: 'open' as const, payments: [] }
        : { ...common, kind: 'offer' as const, validUntil: addDays(today, 30), status: 'open' as const };
      const result = await runtime.request(`/documents/${kind}/finalize`, mobileDocumentFinalizeResponseSchema, {
        method: 'POST',
        body: JSON.stringify({
          clientMutationId: mutationId,
          reason: 'Created and finalized in Billme Mobile',
          draft,
          delivery: sendNow ? {
            recipientEmail: client.email,
            recipientName: client.contactPerson || client.company,
            subject,
            bodyText,
          } : undefined,
        }),
      });
      await removeDraft(draftId);
      router.replace(`/documents/${kind}/${result.document.id}` as never);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Button label="Close" variant="light" icon={<ArrowLeft size={20} color={colors.ink} />} onPress={() => router.back()} />
      <AppHeader eyebrow={`${kind === 'invoice' ? 'Invoice' : 'Offer'} · Step ${step + 1} of 3`} title={step === 0 ? 'Who is it for?' : step === 1 ? 'What did you deliver?' : 'Ready to finalize'} action={<StatusPill label="Autosaved" tone="success" />} />
      {error ? <Feedback message={error} /> : null}
      {step === 0 ? (
        <Surface>
          {clients.map((entry) => <ListRow key={entry.id} title={entry.company} detail={entry.email} trailing={entry.id === clientId ? <Check size={22} color={colors.success} /> : undefined} onPress={() => setClientId(entry.id)} />)}
        </Surface>
      ) : null}
      {step === 1 ? (
        <Surface style={styles.form}>
          <TextField label="Description" value={description} onChangeText={setDescription} placeholder="Consulting, materials, service…" />
          <View style={styles.row}>
            <View style={styles.flex}><TextField label="Quantity" keyboardType="decimal-pad" value={quantity} onChangeText={setQuantity} /></View>
            <View style={styles.flex}><TextField label="Unit price" keyboardType="decimal-pad" value={price} onChangeText={setPrice} /></View>
          </View>
          <View style={styles.total}><Text style={styles.totalLabel}>Subtotal</Text><Money amount={total} large /></View>
          <Text style={styles.note}>VAT and the legal total are recalculated by the server at finalization.</Text>
        </Surface>
      ) : null}
      {step === 2 ? (
        <View style={styles.form}>
          <Surface accent style={styles.review}>
            <Text style={styles.totalLabel}>{client?.company}</Text>
            <Money amount={total} large />
            <Text style={styles.note}>{description} · {quantity} × {price} €</Text>
          </Surface>
          <Surface style={styles.form}>
            <SectionTitle>Delivery</SectionTitle>
            <Button label={sendNow ? 'Send after finalizing' : 'Finalize without sending'} variant={sendNow ? 'dark' : 'light'} onPress={() => setSendNow((value) => !value)} />
            {sendNow ? <>
              <TextField label="Subject" value={subject} onChangeText={setSubject} />
              <TextField label="Message" multiline value={bodyText} onChangeText={setBodyText} />
            </> : null}
          </Surface>
        </View>
      ) : null}
      <View style={styles.navigation}>
        {step > 0 ? <Button label="Back" variant="light" onPress={() => setStep((value) => value - 1)} /> : null}
        {step < 2 ? <Button label="Continue" disabled={!valid} icon={<ArrowRight size={20} color={colors.white} />} onPress={() => setStep((value) => value + 1)} />
          : <Button label={sendNow ? 'Finalize and send' : 'Finalize'} loading={busy} icon={<Send size={20} color={colors.white} />} onPress={finish} />}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: { gap: space.lg },
  row: { flexDirection: 'row', gap: space.md },
  flex: { flex: 1 },
  total: { gap: space.xs, alignItems: 'flex-end' },
  totalLabel: { ...typography.small, color: colors.inkSecondary },
  note: { ...typography.small, color: colors.inkSecondary },
  review: { gap: space.sm },
  navigation: { gap: space.sm },
});
