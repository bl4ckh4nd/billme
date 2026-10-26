import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { KontorIcon } from '@billme/ui';
import {
  DashboardLayout as ShellDashboardLayout,
  type DashboardLayoutProps,
  type ShellNavItem,
} from '@billme/desktop-renderer/ui';
import { useOpenEurItemCount } from '@billme/desktop-renderer/hooks/useOpenEurItemCount';
import { useSettingsQuery } from '@billme/desktop-renderer/hooks/useSettings';
import { ipc } from '../ipc/client';
import { Titlebar } from './Titlebar';

type ProNavItem = ShellNavItem & { profit?: 'eur' | 'double_entry' };

// Accounting areas are tabs of /accounting; `view` opens one directly.
const NAV_ITEMS: readonly ProNavItem[] = [
  { id: 'dashboard', label: 'Übersicht', icon: KontorIcon.overview, group: 'Arbeit', to: '/' },
  { id: 'booking', label: 'Buchen', icon: KontorIcon.booking, group: 'Arbeit', to: '/accounting', search: { view: 'inbox' }, action: 'Nächsten Umsatz buchen' },
  { id: 'reconciliation', label: 'Bankabgleich', icon: KontorIcon.bank, group: 'Arbeit', to: '/accounting', search: { view: 'reconciliation' } },
  { id: 'checks', label: 'Prüfungen', icon: KontorIcon.checks, group: 'Arbeit', to: '/accounting', search: { view: 'checks' }, profit: 'double_entry', subtitle: 'Auffälligkeiten im Journal' },
  { id: 'exceptions', label: 'Ausnahmen', icon: KontorIcon.exceptions, group: 'Arbeit', to: '/accounting', search: { view: 'exceptions' }, profit: 'double_entry' },
  { id: 'receipts', label: 'Belege', icon: KontorIcon.receipts, group: 'Arbeit', to: '/accounting', search: { view: 'receipts' }, profit: 'double_entry', subtitle: 'Eingang, Zuordnung und Prüfstatus' },
  { id: 'accounts', label: 'Konten', icon: KontorIcon.accounts, group: 'Arbeit', to: '/accounts' },
  { id: 'documents', label: 'Rechnungen & Angebote', icon: KontorIcon.documents, group: 'Verkauf', to: '/documents' },
  { id: 'recurring', label: 'Wiederkehrend', icon: KontorIcon.recurring, group: 'Verkauf', to: '/recurring' },
  { id: 'clients', label: 'Kunden', icon: KontorIcon.clients, group: 'Verkauf', to: '/clients' },
  { id: 'projects', label: 'Projekte', icon: KontorIcon.projects, group: 'Verkauf', to: '/projects' },
  { id: 'articles', label: 'Leistungen', icon: KontorIcon.articles, group: 'Verkauf', to: '/articles' },
  { id: 'opos', label: 'Offene Posten', icon: KontorIcon.openItems, group: 'Verkauf', to: '/accounting', search: { view: 'opos' }, profit: 'double_entry', subtitle: 'Forderungen und Verbindlichkeiten' },
  { id: 'reports', label: 'Auswertungen', icon: KontorIcon.reports, group: 'Abschluss', to: '/accounting', search: { view: 'reports' } },
  { id: 'partners', label: 'Geschäftspartner', icon: KontorIcon.clients, group: 'Abschluss', to: '/accounting', search: { view: 'partners' }, profit: 'double_entry', subtitle: 'Einnahmen und Ausgaben je Partner' },
  { id: 'money', label: 'Geldkonten', icon: KontorIcon.money, group: 'Abschluss', to: '/accounting', search: { view: 'money' }, profit: 'double_entry', subtitle: 'Bank, Kasse und Kreditkarten je Jahr' },
  // UStVA, ZM/OSS-Vorbereitung and the period locks they set live together under Steuer (pro-abschluss B8/B19).
  { id: 'tax', label: 'Steuer', icon: KontorIcon.tax, group: 'Abschluss', to: '/accounting', search: { view: 'tax' } },
  { id: 'assets', label: 'Anlagen', icon: KontorIcon.assets, group: 'Abschluss', to: '/accounting', search: { view: 'assets' } },
  { id: 'special', label: 'Sonderbuchungen', icon: KontorIcon.special, group: 'Abschluss', to: '/accounting', search: { view: 'special' } },
  { id: 'templates', label: 'Vorlagen', icon: KontorIcon.templates, group: 'Abschluss', to: '/templates' },
];

type Props = Omit<DashboardLayoutProps, 'navItems' | 'titlebar'>;

export const DashboardLayout: React.FC<Props> = (props) => {
  const { data: settings } = useSettingsQuery();
  const profit = settings?.businessReportingProfile?.profitDetermination;
  const chart = settings?.businessReportingProfile?.chart;
  const openEurCount = useOpenEurItemCount(profit === 'eur');
  // Same key and source as the booking workbench, so the count follows its invalidations.
  // ponytail: counts every bank row not booked or matched to an invoice ("Alle" minus "Gebucht");
  // draft states the workbench derives from getDraftByTransactionId are not fanned out here.
  const { data: bankRows } = useQuery({
    queryKey: ['pro-accounting', 'transactions'],
    queryFn: () => ipc.pro.listBankTransactions(),
    enabled: profit === 'double_entry',
  });
  const openBankCount = profit === 'double_entry' ? bankRows?.filter((row) => row.status !== 'booked' && !row.linkedInvoiceId).length : undefined;
  // Prüfungen: open errors and warnings of the journal checks (the Prüfungen view refreshes this key after a change).
  const { data: checks } = useQuery({
    queryKey: ['pro-ledger-checks'],
    queryFn: () => ipc.pro.getLedgerChecks({}),
    enabled: profit === 'double_entry',
    staleTime: 60_000,
  });
  const openCheckCount = checks ? checks.openErrors + checks.openWarnings : undefined;
  // Until the profile is set up every area stays reachable.
  const navItems = React.useMemo(
    () =>
      NAV_ITEMS.filter((item) => (!item.profit || !profit || item.profit === profit) && !(profit === 'eur' && item.id === 'accounts')).map((item): ShellNavItem => {
        if (item.id === 'reports' && profit) {
          return { ...item, subtitle: profit === 'eur' ? 'EÜR und Umsatzsteuer' : 'GuV, Bilanz und Umsatzsteuer' };
        }
        if (item.id === 'booking') {
          const method = profit === 'eur' ? 'Einnahmen-Überschuss-Rechnung' : profit ? 'Doppelte Buchführung' : undefined;
          const booking = { ...item, count: profit === 'eur' ? openEurCount : openBankCount, subtitle: [method, chart].filter(Boolean).join(', ') || undefined };
          // EÜR businesses book payments, not Soll/Haben: "Buchen" is the EÜR workbench and
          // "Bankabgleich" the invoice matching on the accounts screen, as in Lite.
          return profit === 'eur' ? { ...booking, to: '/eur', search: undefined } : booking;
        }
        if (profit === 'eur' && item.id === 'reconciliation') return { ...item, to: '/accounts', search: undefined };
        if (item.id === 'checks') return { ...item, count: openCheckCount };
        return item;
      }),
    [profit, chart, openEurCount, openBankCount, openCheckCount],
  );
  return <ShellDashboardLayout {...props} navItems={navItems} titlebar={<Titlebar />} />;
};
