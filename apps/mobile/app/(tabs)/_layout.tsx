import { Redirect, Tabs } from 'expo-router';
import { ContactRound, FileText, Home, Plus, Settings } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';
import { useRuntime } from '@/runtime';
import { colors, radius, space } from '@/theme';

export default function TabLayout() {
  const runtime = useRuntime();
  if (!runtime.session || runtime.locked) return <Redirect href="/" />;
  return (
    <Tabs screenOptions={{
      headerShown: false,
      tabBarActiveTintColor: colors.ink,
      tabBarInactiveTintColor: colors.muted,
      tabBarStyle: styles.tabBar,
      tabBarLabelStyle: styles.label,
      tabBarItemStyle: styles.item,
    }}>
      <Tabs.Screen name="index" options={{ title: 'Today', tabBarIcon: ({ color }) => <Home color={color} size={21} /> }} />
      <Tabs.Screen name="documents" options={{ title: 'Documents', tabBarIcon: ({ color }) => <FileText color={color} size={21} /> }} />
      <Tabs.Screen name="capture" options={{
        title: 'Create',
        tabBarIcon: () => <View style={styles.create}><Plus color={colors.white} size={26} strokeWidth={2.5} /></View>,
      }} />
      <Tabs.Screen name="contacts" options={{ title: 'Contacts', tabBarIcon: ({ color }) => <ContactRound color={color} size={21} /> }} />
      <Tabs.Screen name="more" options={{ title: 'More', tabBarIcon: ({ color }) => <Settings color={color} size={21} /> }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    position: 'absolute',
    left: space.md,
    right: space.md,
    bottom: space.md,
    height: 70,
    borderTopWidth: 0,
    borderRadius: radius.xl,
    backgroundColor: colors.surface,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    shadowColor: colors.shadow,
    shadowOpacity: 0.16,
    shadowOffset: { width: 0, height: 12 },
    shadowRadius: 28,
    elevation: 12,
  },
  item: { minHeight: 52 },
  label: { fontSize: 11, fontWeight: '600' },
  create: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center', marginTop: -18 },
});
