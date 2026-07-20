import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { FilePlus2, Search } from 'lucide-react-native';
import { invoiceSchema, offerSchema } from '@billme/server-core';
import { z } from 'zod';
import { AppHeader, Button, EmptyState, Feedback, ListRow, Money, Screen, SectionTitle, StatusPill, Surface, TextField } from '@/components';
import { useRuntime } from '@/runtime';
import { cacheGet, cacheSet } from '@/storage';
import { colors, space } from '@/theme';

type Document = z.output<typeof invoiceSchema> | z.output<typeof offerSchema>;

const statusTone = (status: string): 'neutral' | 'success' | 'danger' | 'warning' =>
  ['paid', 'accepted'].includes(status) ? 'success' : ['overdue', 'declined', 'expired'].includes(status) ? 'danger'
    : ['open'].includes(status) ? 'warning' : 'neutral';

export default function DocumentsScreen() {
  const runtime = useRuntime();
  const router = useRouter();
  const [documents, setDocuments] = useState<Document[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'invoice' | 'offer'>('all');
  const [cached, setCached] = useState(false);

  const load = useCallback(async () => {
    try {
      const [invoices, offers] = await Promise.all([
        runtime.request('/invoices', z.array(invoiceSchema)),
        runtime.request('/offers', z.array(offerSchema)),
      ]);
      const next = [...invoices, ...offers].sort((a, b) => b.date.localeCompare(a.date));
      setDocuments(next);
      await cacheSet(`documents:${runtime.session?.tenantId}:${runtime.session?.product}`, next);
      setCached(false);
      setError('');
    } catch (cause) {
      const stored = await cacheGet<Document[]>(`documents:${runtime.session?.tenantId}:${runtime.session?.product}`);
      if (stored) {
        setDocuments(stored);
        setCached(true);
        setError('');
      } else {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  }, [runtime]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const visible = useMemo(() => documents.filter((document) => {
    const matchesKind = filter === 'all' || document.kind === filter;
    const needle = query.trim().toLocaleLowerCase('de-DE');
    return matchesKind && (!needle || `${document.number} ${document.client}`.toLocaleLowerCase('de-DE').includes(needle));
  }), [documents, filter, query]);

  return (
    <Screen>
      <AppHeader title="Documents" action={cached ? <StatusPill label="Offline copy" tone="warning" /> : <Button label="New" variant="light" icon={<FilePlus2 size={18} color={colors.ink} />} onPress={() => router.push('/documents/new?kind=invoice')} />} />
      <TextField label="Search" value={query} onChangeText={setQuery} placeholder="Number or customer" />
      <View style={styles.filters}>
        {(['all', 'invoice', 'offer'] as const).map((value) => (
          <Button key={value} label={value === 'all' ? 'All' : value === 'invoice' ? 'Invoices' : 'Offers'} variant={filter === value ? 'dark' : 'light'} onPress={() => setFilter(value)} />
        ))}
      </View>
      {error ? <Feedback message={error} /> : null}
      <View style={styles.section}>
        <SectionTitle>{visible.length} documents</SectionTitle>
        <Surface>
          {visible.length ? visible.map((document) => (
            <ListRow
              key={`${document.kind}:${document.id}`}
              title={document.number}
              detail={`${document.client} · ${document.date}`}
              trailing={<View style={styles.trailing}><Money amount={document.amount} /><StatusPill label={document.status} tone={statusTone(document.status)} /></View>}
              onPress={() => router.push(`/documents/${document.kind}/${document.id}` as never)}
            />
          )) : <EmptyState title="No matching documents" detail="Change the filter or create a new document." />}
        </Surface>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  filters: { flexDirection: 'row', gap: space.sm },
  section: { gap: space.md },
  trailing: { alignItems: 'flex-end', gap: space.sm },
});
