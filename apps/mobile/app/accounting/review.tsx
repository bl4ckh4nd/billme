import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ArrowLeft, CheckCircle2, XCircle } from 'lucide-react-native';
import { z } from 'zod';
import { AppHeader, Button, EmptyState, Feedback, ListRow, Money, Screen, SectionTitle, SlideConfirm, StatusPill, Surface, TextField } from '@/components';
import { useRuntime } from '@/runtime';
import { colors, space, typography } from '@/theme';

const draftSchema = z.object({
  id: z.string(),
  transactionId: z.string(),
  workflowStatus: z.string(),
  postingDate: z.string().optional(),
  bookingText: z.string(),
  period: z.string(),
  fiscalYear: z.number(),
  lines: z.array(z.object({ id: z.string(), accountNumber: z.string(), debitAmount: z.number(), creditAmount: z.number(), memo: z.string().optional() })),
  validationIssues: z.array(z.object({ id: z.string(), code: z.string(), severity: z.string(), message: z.string(), blocking: z.boolean() })),
  updatedAt: z.string(),
}).passthrough();
type Draft = z.infer<typeof draftSchema>;

export default function AccountingReviewScreen() {
  const runtime = useRuntime();
  const router = useRouter();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [selected, setSelected] = useState<Draft | null>(null);
  const [reason, setReason] = useState('Reviewed in Billme Mobile');
  const [error, setError] = useState('');
  const load = async () => {
    try {
      const next = await runtime.request('/accounting/review-queue', z.array(draftSchema));
      setDrafts(next);
      if (selected) setSelected(next.find((draft) => draft.id === selected.id) ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  useEffect(() => { void load(); }, []);
  const action = async (value: 'submit_for_review' | 'approve' | 'reject' | 'post') => {
    if (!selected) return;
    try {
      const updated = await runtime.request(`/accounting/booking-drafts/${selected.id}/actions`, draftSchema, {
        method: 'POST', body: JSON.stringify({ action: value, reason }),
      });
      setSelected(updated.workflowStatus === 'posted' ? null : updated);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <Screen>
      <Button label="Back" variant="light" icon={<ArrowLeft size={20} color={colors.ink} />} onPress={() => router.back()} />
      <AppHeader eyebrow="Pro accounting" title="Review queue" />
      {error ? <Feedback message={error} /> : null}
      {!selected ? (
        <Surface>
          {drafts.length ? drafts.map((draft) => <ListRow key={draft.id} title={draft.bookingText} detail={`${draft.period} · ${draft.workflowStatus.replaceAll('_', ' ')}`} trailing={<StatusPill label={draft.validationIssues.some((issue) => issue.blocking) ? 'Blocked' : 'Ready'} tone={draft.validationIssues.some((issue) => issue.blocking) ? 'danger' : 'success'} />} onPress={() => setSelected(draft)} />)
            : <EmptyState title="Review queue is clear" detail="New accounting decisions will appear here." />}
        </Surface>
      ) : <View style={styles.section}>
        <Surface accent style={styles.hero}>
          <Text style={styles.heading}>{selected.bookingText}</Text>
          <Text style={styles.copy}>{selected.period} · {selected.workflowStatus.replaceAll('_', ' ')}</Text>
          <Money amount={selected.lines.reduce((sum, line) => sum + line.debitAmount, 0)} large />
        </Surface>
        <Surface>
          <SectionTitle>Journal lines</SectionTitle>
          {selected.lines.map((line) => <ListRow key={line.id} title={line.accountNumber} detail={line.memo} trailing={<Money amount={Math.max(line.debitAmount, line.creditAmount)} />} />)}
        </Surface>
        {selected.validationIssues.length ? <Surface><SectionTitle>Validation</SectionTitle>{selected.validationIssues.map((issue) => <ListRow key={issue.id} title={issue.code} detail={issue.message} trailing={<StatusPill label={issue.severity} tone={issue.blocking ? 'danger' : 'warning'} />} />)}</Surface> : null}
        <TextField label="Audit reason" value={reason} onChangeText={setReason} />
        {['ready_for_review', 'pending_approval'].includes(selected.workflowStatus) ? <View style={styles.actions}>
          <Button label="Approve" icon={<CheckCircle2 size={20} color={colors.white} />} onPress={() => action('approve')} />
          <Button label="Reject" variant="danger" icon={<XCircle size={20} color={colors.white} />} onPress={() => action('reject')} />
        </View> : null}
        {selected.workflowStatus === 'approved' ? <>
          <SlideConfirm label="Slide to post permanently" disabled={!reason.trim() || selected.validationIssues.some((issue) => issue.blocking)} onConfirm={() => action('post')} />
          <Button label="Post with accessible confirmation" variant="light" disabled={!reason.trim() || selected.validationIssues.some((issue) => issue.blocking)} onPress={() => action('post')} />
        </> : null}
        <Button label="Back to queue" variant="light" onPress={() => setSelected(null)} />
      </View>}
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.lg },
  hero: { gap: space.sm },
  heading: { ...typography.section, color: colors.ink },
  copy: { ...typography.small, color: colors.inkSecondary },
  actions: { gap: space.sm },
});
