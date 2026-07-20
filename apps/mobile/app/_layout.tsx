import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack, useRouter } from 'expo-router';
import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { RuntimeProvider } from '@/runtime';
import { colors } from '@/theme';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

export default function RootLayout() {
  const router = useRouter();
  useEffect(() => Notifications.addNotificationResponseReceivedListener((response) => {
    const route = response.notification.request.content.data?.route;
    if (typeof route === 'string' && route.startsWith('/')) router.push(route as never);
  }).remove, [router]);
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <RuntimeProvider>
          <StatusBar style="dark" />
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.canvas } }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="pair" options={{ presentation: 'fullScreenModal' }} />
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="receipts/[id]" />
            <Stack.Screen name="documents/[kind]/[id]" />
            <Stack.Screen name="documents/new" options={{ presentation: 'modal' }} />
            <Stack.Screen name="accounting/review" />
          </Stack>
        </RuntimeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
