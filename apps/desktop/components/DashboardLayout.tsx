import React from 'react';
import {
  BarChart3,
  Briefcase,
  FileText,
  Home,
  LayoutTemplate,
  Landmark,
  Package,
  ReceiptText,
  Repeat,
  Users,
} from 'lucide-react';
import {
  DashboardLayout as ShellDashboardLayout,
  type DashboardLayoutProps,
  type ShellNavItem,
} from '@billme/desktop-ui';
import { Titlebar } from './Titlebar';
import { getBillmeRuntimeConfig, type BillmeNavigationPage } from '../runtime';

// `section` is the web shell's visibility switch for the entry.
const ALL_ITEMS: ReadonlyArray<ShellNavItem & { section: BillmeNavigationPage }> = [
  { id: 'dashboard', label: 'Übersicht', icon: Home, group: 'Arbeit', to: '/', section: 'dashboard' },
  { id: 'eur', label: 'Buchen', icon: ReceiptText, group: 'Arbeit', to: '/eur', section: 'finance' },
  { id: 'accounts', label: 'Bankabgleich', icon: Landmark, group: 'Arbeit', to: '/accounts', also: ['/finance'], section: 'finance' },
  { id: 'documents', label: 'Rechnungen & Angebote', icon: FileText, group: 'Verkauf', to: '/documents', section: 'documents' },
  { id: 'recurring', label: 'Wiederkehrend', icon: Repeat, group: 'Verkauf', to: '/recurring', section: 'documents' },
  { id: 'clients', label: 'Kunden', icon: Users, group: 'Verkauf', to: '/clients', section: 'clients' },
  { id: 'projects', label: 'Projekte', icon: Briefcase, group: 'Verkauf', to: '/projects', section: 'projects' },
  { id: 'articles', label: 'Leistungen', icon: Package, group: 'Verkauf', to: '/articles', section: 'articles' },
  { id: 'statistics', label: 'Auswertungen', icon: BarChart3, group: 'Abschluss', to: '/statistics', section: 'finance' },
  { id: 'templates', label: 'Vorlagen', icon: LayoutTemplate, group: 'Abschluss', to: '/templates', section: 'documents' },
];

type Props = Omit<DashboardLayoutProps, 'navItems' | 'titlebar'>;

export const DashboardLayout: React.FC<Props> = (props) => {
  const runtime = React.useMemo(() => getBillmeRuntimeConfig(), []);
  const navItems: readonly ShellNavItem[] = React.useMemo(() => {
    const visible = runtime.navigation;
    return visible && visible.length > 0 ? ALL_ITEMS.filter((item) => visible.includes(item.section)) : ALL_ITEMS;
  }, [runtime.navigation]);

  return <ShellDashboardLayout {...props} navItems={navItems} titlebar={<Titlebar />} />;
};
