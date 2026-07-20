import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { clientSchema } from '@billme/server-core';
import { z } from 'zod';
import { AppHeader, EmptyState, Feedback, ListRow, Screen, SectionTitle, StatusPill, Surface, TextField } from '@/components';
import { useRuntime } from '@/runtime';
import { cacheGet, cacheSet } from '@/storage';
import { space } from '@/theme';

export default function ContactsScreen() {
  const runtime = useRuntime();
  const router = useRouter();
  const [clients, setClients] = useState<z.output<typeof clientSchema>[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [cached, setCached] = useState(false);
  const load = useCallback(async () => {
    try {
      const next = await runtime.request('/clients', z.array(clientSchema));
      setClients(next);
      await cacheSet(`clients:${runtime.session?.tenantId}:${runtime.session?.product}`, next);
      setCached(false);
      setError('');
    } catch (cause) {
      const stored = await cacheGet<z.output<typeof clientSchema>[]>(`clients:${runtime.session?.tenantId}:${runtime.session?.product}`);
      if (stored) {
        setClients(stored);
        setCached(true);
        setError('');
      } else {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  }, [runtime]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  const visible = useMemo(() => clients.filter((client) =>
    `${client.company} ${client.contactPerson} ${client.email}`.toLocaleLowerCase('de-DE').includes(query.toLocaleLowerCase('de-DE'))
  ), [clients, query]);
  return (
    <Screen>
      <AppHeader title="Contacts" action={cached ? <StatusPill label="Offline copy" tone="warning" /> : undefined} />
      <TextField label="Search" value={query} onChangeText={setQuery} placeholder="Company, person, or email" />
      {error ? <Feedback message={error} /> : null}
      <View style={styles.section}>
        <SectionTitle>{visible.length} customers</SectionTitle>
        <Surface>
          {visible.length ? visible.map((client) => (
            <ListRow
              key={client.id}
              title={client.company}
              detail={[client.contactPerson, client.email].filter(Boolean).join(' · ')}
              trailing={<StatusPill label={client.status} tone={client.status === 'active' ? 'success' : 'neutral'} />}
              onPress={() => router.push(`/documents/new?kind=invoice&clientId=${client.id}` as never)}
            />
          )) : <EmptyState title="No customers found" detail="Customers created on desktop or web appear here immediately." />}
        </Surface>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({ section: { gap: space.md } });
