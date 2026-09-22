import React from 'react';
import {
  DashboardLayout as ShellDashboardLayout,
  type DashboardLayoutProps,
  type ShellNavItem,
} from '@billme/desktop-ui';
import { Titlebar } from './Titlebar';
import billmeFullLogo from '../assets/billme-full-logo.svg';

const NAV_ITEMS: readonly ShellNavItem[] = [
  { id: 'dashboard', label: 'Übersicht' },
  { id: 'clients', label: 'Kunden' },
  { id: 'projects', label: 'Projekte' },
  { id: 'documents', label: 'Dokumente' },
  { id: 'finance', label: 'Finanzen' },
  { id: 'tax-filing', label: 'Steuer' },
  { id: 'articles', label: 'Artikel' },
];

type Props = Omit<DashboardLayoutProps, 'navItems' | 'logoUrl' | 'titlebar'>;

export const DashboardLayout: React.FC<Props> = (props) => (
  <ShellDashboardLayout
    {...props}
    navItems={NAV_ITEMS}
    logoUrl={billmeFullLogo}
    titlebar={<Titlebar />}
  />
);
