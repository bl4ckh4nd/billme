import React from 'react';
import { KontorIcon } from '@billme/ui';
import {
  DashboardLayout as ShellDashboardLayout,
  type DashboardLayoutProps,
  type ShellNavItem,
} from '@billme/desktop-renderer/ui';
import { useOpenEurItemCount } from '@billme/desktop-renderer/hooks/useOpenEurItemCount';
import { useLiteAttentionItems } from '@billme/desktop-renderer/hooks/useAttentionItems';
import { useSettingsQuery } from '@billme/desktop-renderer/hooks/useSettings';
import { Titlebar } from './Titlebar';
import { getBillmeRuntimeConfig, type BillmeNavigationPage } from '../runtime';

// `section` is the web shell's visibility switch for the entry.
const ALL_ITEMS: ReadonlyArray<ShellNavItem & { section: BillmeNavigationPage }> = [
  { id: 'dashboard', label: 'Übersicht', icon: KontorIcon.overview, group: 'Arbeit', to: '/', section: 'dashboard' },
  { id: 'eur', label: 'Buchen', icon: KontorIcon.booking, group: 'Arbeit', to: '/eur', section: 'finance', action: 'Nächsten Umsatz buchen' },
  { id: 'accounts', label: 'Bankabgleich', icon: KontorIcon.bank, group: 'Arbeit', to: '/accounts', section: 'finance' },
  { id: 'documents', label: 'Rechnungen & Angebote', icon: KontorIcon.documents, group: 'Verkauf', to: '/documents', section: 'documents' },
  { id: 'recurring', label: 'Wiederkehrend', icon: KontorIcon.recurring, group: 'Verkauf', to: '/recurring', section: 'documents' },
  { id: 'clients', label: 'Kunden', icon: KontorIcon.clients, group: 'Verkauf', to: '/clients', section: 'clients' },
  { id: 'projects', label: 'Projekte', icon: KontorIcon.projects, group: 'Verkauf', to: '/projects', section: 'projects' },
  { id: 'articles', label: 'Leistungen', icon: KontorIcon.articles, group: 'Verkauf', to: '/articles', section: 'articles' },
  { id: 'statistics', label: 'Auswertungen', icon: KontorIcon.reports, group: 'Abschluss', to: '/statistics', section: 'finance', subtitle: 'EÜR und Umsatzsteuer' },
  { id: 'templates', label: 'Vorlagen', icon: KontorIcon.templates, group: 'Abschluss', to: '/templates', section: 'documents' },
];

type Props = Omit<DashboardLayoutProps, 'navItems' | 'titlebar'>;

// Booking actions for Ctrl/⌘K; each opens the place where the action happens.
const BOOKING_ACTIONS: NonNullable<DashboardLayoutProps['actions']> = [
  { key: 'cash-entry', title: 'Manuelle Buchung erfassen', to: '/eur', search: { create: 'cash' }, keywords: ['buchung', 'bar', 'kasse', 'beleg', 'quittung', 'eigenbeleg', 'erfassen'] },
  { key: 'csv-import', title: 'Kontoauszug importieren (CSV)', to: '/accounts', keywords: ['csv', 'import', 'kontoauszug', 'bank', 'umsätze'] },
  { key: 'vat', title: 'Umsatzsteuer-Voranmeldung öffnen', to: '/statistics', search: { view: 'ust' }, keywords: ['umsatzsteuer', 'ustva', 'voranmeldung', 'vorsteuer', 'zahllast'] },
  { key: 'eur', title: 'Anlage EÜR und DATEV-Export öffnen', to: '/statistics', search: { view: 'eur' }, keywords: ['eür', 'euer', 'anlage', 'datev', 'steuerberatung', 'export'] },
  { key: 'close-month', title: 'Monat festschreiben', to: '/eur', keywords: ['festschreiben', 'abschließen', 'monat', 'sperren'] },
];

export const DashboardLayout: React.FC<Props> = (props) => {
  const runtime = React.useMemo(() => getBillmeRuntimeConfig(), []);
  const { data: settings } = useSettingsQuery();
  const profile = settings?.businessReportingProfile;
  const openCount = useOpenEurItemCount(settings?.onboardingCompleted === true && profile?.profitDetermination === 'eur');
  const attention = useLiteAttentionItems({ enabled: settings?.onboardingCompleted === true, openEurCount: openCount ?? 0 });
  const navItems: readonly ShellNavItem[] = React.useMemo(() => {
    const visible = runtime.navigation;
    const items = visible && visible.length > 0 ? ALL_ITEMS.filter((item) => visible.includes(item.section)) : ALL_ITEMS;
    return items.map((item) =>
      item.id === 'eur'
        ? { ...item, count: openCount, subtitle: ['Einnahmen-Überschuss-Rechnung', profile?.chart].filter(Boolean).join(', ') }
        : item,
    );
  }, [runtime.navigation, openCount, profile?.chart]);

  return <ShellDashboardLayout {...props} navItems={navItems} titlebar={<Titlebar />} attention={attention} actions={BOOKING_ACTIONS} />;
};
