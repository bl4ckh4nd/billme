import React from 'react';
import {
  AlertTriangle,
  BarChart3,
  Briefcase,
  Building2,
  FileText,
  Home,
  FileInput,
  Inbox,
  LayoutTemplate,
  Landmark,
  Layers,
  ListChecks,
  Package,
  ReceiptText,
  Repeat,
  Scale,
  Users,
  Wallet,
} from 'lucide-react';
import {
  DashboardLayout as ShellDashboardLayout,
  type DashboardLayoutProps,
  type ShellNavItem,
} from '@billme/desktop-ui';
import { useSettingsQuery } from '../hooks/useSettings';
import { Titlebar } from './Titlebar';

type ProNavItem = ShellNavItem & { profit?: 'eur' | 'double_entry' };

// Accounting areas are tabs of /accounting; `view` opens one directly.
const NAV_ITEMS: readonly ProNavItem[] = [
  { id: 'dashboard', label: 'Übersicht', icon: Home, group: 'Arbeit', to: '/' },
  { id: 'booking', label: 'Buchen', icon: Inbox, group: 'Arbeit', to: '/accounting', search: { view: 'inbox' } },
  { id: 'reconciliation', label: 'Bankabgleich', icon: Landmark, group: 'Arbeit', to: '/accounting', search: { view: 'reconciliation' } },
  { id: 'exceptions', label: 'Ausnahmen', icon: AlertTriangle, group: 'Arbeit', to: '/accounting', search: { view: 'exceptions' }, profit: 'double_entry' },
  { id: 'receipts', label: 'Belege', icon: FileInput, group: 'Arbeit', to: '/accounting', search: { view: 'receipts' }, profit: 'double_entry' },
  { id: 'accounts', label: 'Konten', icon: Wallet, group: 'Arbeit', to: '/accounts', also: ['/finance'] },
  { id: 'documents', label: 'Rechnungen & Angebote', icon: FileText, group: 'Verkauf', to: '/documents' },
  { id: 'recurring', label: 'Wiederkehrend', icon: Repeat, group: 'Verkauf', to: '/recurring' },
  { id: 'clients', label: 'Kunden', icon: Users, group: 'Verkauf', to: '/clients' },
  { id: 'projects', label: 'Projekte', icon: Briefcase, group: 'Verkauf', to: '/projects' },
  { id: 'articles', label: 'Leistungen', icon: Package, group: 'Verkauf', to: '/articles' },
  { id: 'opos', label: 'Offene Posten', icon: ListChecks, group: 'Verkauf', to: '/accounting', search: { view: 'opos' }, profit: 'double_entry' },
  { id: 'reports', label: 'Auswertungen', icon: BarChart3, group: 'Abschluss', to: '/accounting', search: { view: 'reports' } },
  { id: 'tax-filing', label: 'Steuer', icon: Scale, group: 'Abschluss', to: '/tax-filing' },
  { id: 'assets', label: 'Anlagen', icon: Building2, group: 'Abschluss', to: '/accounting', search: { view: 'assets' } },
  { id: 'special', label: 'Sonderbuchungen', icon: Layers, group: 'Abschluss', to: '/accounting', search: { view: 'special' } },
  { id: 'templates', label: 'Vorlagen', icon: LayoutTemplate, group: 'Abschluss', to: '/templates' },
];

type Props = Omit<DashboardLayoutProps, 'navItems' | 'titlebar'>;

export const DashboardLayout: React.FC<Props> = (props) => {
  const { data: settings } = useSettingsQuery();
  const profit = settings?.businessReportingProfile?.profitDetermination;
  // Until the profile is set up every area stays reachable.
  const navItems = React.useMemo(
    () =>
      NAV_ITEMS.filter((item) => (!item.profit || !profit || item.profit === profit) && !(profit === 'eur' && item.id === 'accounts')).map((item): ShellNavItem => {
        // EÜR businesses book payments, not Soll/Haben: "Buchen" is the EÜR workbench and
        // "Bankabgleich" the invoice matching on the accounts screen, as in Lite.
        if (profit !== 'eur') return item;
        if (item.id === 'booking') return { ...item, icon: ReceiptText, to: '/eur', search: undefined };
        if (item.id === 'reconciliation') return { ...item, to: '/accounts', search: undefined };
        return item;
      }),
    [profit],
  );
  return <ShellDashboardLayout {...props} navItems={navItems} titlebar={<Titlebar />} />;
};
