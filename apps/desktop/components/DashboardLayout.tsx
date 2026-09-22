import React from 'react';
import {
  DashboardLayout as ShellDashboardLayout,
  type DashboardLayoutProps,
  type ShellNavItem,
} from '@billme/desktop-ui';
import { Titlebar } from './Titlebar';
import billmeFullLogo from '../assets/billme-full-logo.svg';
import { getBillmeRuntimeConfig, type BillmeNavigationPage } from '../runtime';

const ALL_ITEMS: ReadonlyArray<{ id: BillmeNavigationPage; label: string }> = [
  { id: 'dashboard', label: 'Übersicht' },
  { id: 'clients', label: 'Kunden' },
  { id: 'projects', label: 'Projekte' },
  { id: 'documents', label: 'Dokumente' },
  { id: 'finance', label: 'Finanzen' },
  { id: 'articles', label: 'Artikel' },
];

type Props = Omit<DashboardLayoutProps, 'navItems' | 'logoUrl' | 'titlebar'>;

// The web shell ships a runtime navigation config that hides sections.
export const DashboardLayout: React.FC<Props> = (props) => {
  const runtime = React.useMemo(() => getBillmeRuntimeConfig(), []);
  const navItems: readonly ShellNavItem[] = React.useMemo(() => {
    if (!runtime.navigation || runtime.navigation.length === 0) {
      return ALL_ITEMS;
    }

    return ALL_ITEMS.filter((item) => runtime.navigation?.includes(item.id));
  }, [runtime.navigation]);

  return (
    <ShellDashboardLayout
      {...props}
      navItems={navItems}
      logoUrl={billmeFullLogo}
      titlebar={<Titlebar />}
    />
  );
};
