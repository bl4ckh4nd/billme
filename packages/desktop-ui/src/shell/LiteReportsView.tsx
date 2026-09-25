import React, { useMemo } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import {
  EmptyState, ErrorState, PageHeader, SegmentedControl,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@billme/ui';
import { useInvoicesQuery } from '@billme/desktop-renderer/hooks/useInvoices';
import { useSettingsQuery } from '@billme/desktop-renderer/hooks/useSettings';
import { EurReportPanel } from '@billme/desktop-renderer/components/EurReportPanel';
import { StatisticsView } from './StatisticsView';
import { estimateMonthVat } from './vatEstimate';
import { SkeletonLoader } from '../components/SkeletonLoader';

type ReportTab = 'umsatz' | 'eur' | 'ust';

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);

/** Output VAT per month for the last twelve Voranmeldungen, newest first. */
const VatPanel: React.FC = () => {
  const invoicesQuery = useInvoicesQuery();
  const settingsQuery = useSettingsQuery();
  const settings = settingsQuery.data;
  const method = settings?.legal.taxAccountingMethod ?? 'soll';
  const rows = useMemo(() => {
    if (!invoicesQuery.data || !settings) return [];
    const now = new Date();
    return Array.from({ length: 12 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      return { key: `${d.getFullYear()}-${d.getMonth()}`, ...estimateMonthVat(invoicesQuery.data, settings, method, d.getFullYear(), d.getMonth()) };
    });
  }, [invoicesQuery.data, settings, method]);

  if (invoicesQuery.isError || settingsQuery.isError) {
    return <ErrorState title="Umsatzsteuer konnte nicht berechnet werden" description="Rechnungen oder Einstellungen sind nicht verfügbar." onRetry={() => { void invoicesQuery.refetch(); void settingsQuery.refetch(); }} />;
  }
  if (!invoicesQuery.data || !settings) return <SkeletonLoader variant="card" count={1} />;
  if (settings.legal.smallBusinessRule) {
    return <EmptyState title="Keine Umsatzsteuer" description="Als Kleinunternehmer nach § 19 UStG weisen Sie keine Umsatzsteuer aus." />;
  }

  return (
    <section aria-labelledby="vat-report-title" className="rounded-panel bg-surface p-5 shadow-xs">
      <h2 id="vat-report-title" className="text-section">Umsatzsteuer je Voranmeldungszeitraum</h2>
      <p className="mb-4 mt-1 text-caption text-muted">
        {method === 'ist' ? 'Ist-Versteuerung: nach Zahlungseingang.' : 'Soll-Versteuerung: nach Rechnungsdatum.'} Nur Umsatzsteuer aus Rechnungen, ohne Vorsteuer.
      </p>
      <Table aria-label="Umsatzsteuer nach Monat" density="compact" bare>
        <TableHeader>
          <TableRow>
            <TableHead>Zeitraum</TableHead>
            <TableHead numeric>Netto</TableHead>
            <TableHead numeric>Umsatzsteuer</TableHead>
            <TableHead numeric>Brutto</TableHead>
            <TableHead>Fällig am</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key}>
              <TableCell>{row.periodLabel}</TableCell>
              <TableCell numeric>{formatCurrency(row.net)}</TableCell>
              <TableCell numeric className="font-medium">{formatCurrency(row.vat)}</TableCell>
              <TableCell numeric>{formatCurrency(row.gross)}</TableCell>
              <TableCell muted className="tabular-nums">{row.dueDate.toLocaleDateString('de-DE')}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
};

/** Lite Auswertungen: revenue statistics, Anlage EÜR and the VAT view behind one tab row (`?view=`). */
export const LiteReportsView: React.FC = () => {
  const navigate = useNavigate();
  const search = useRouterState({ select: (s) => s.location.search as Record<string, unknown> });
  const { data: settings } = useSettingsQuery();
  const showEur = settings?.businessReportingProfile?.profitDetermination !== 'double_entry';
  const options = [
    { value: 'umsatz' as const, label: 'Umsatz' },
    ...(showEur ? [{ value: 'eur' as const, label: 'EÜR' }] : []),
    { value: 'ust' as const, label: 'Umsatzsteuer' },
  ];
  const requested = search.view as ReportTab | undefined;
  // The URL is the only tab state, so a rail click back to /statistics resets to Umsatz.
  const tab: ReportTab = options.some((o) => o.value === requested) ? requested! : 'umsatz';
  const select = (next: ReportTab) => {
    void navigate({ to: '.', search: next === 'umsatz' ? {} : { view: next }, replace: true });
  };
  const tabs = <SegmentedControl aria-label="Auswertung" value={tab} onChange={select} options={options} />;

  if (tab === 'umsatz') return <StatisticsView title="Auswertungen" toolbar={tabs} />;
  return (
    <div className="flex flex-col gap-3 pb-4">
      <PageHeader title="Auswertungen" description="Finanzüberblick, Anlage EÜR und Umsatzsteuer" className="px-1 pt-2" toolbar={tabs} />
      {tab === 'eur' ? <EurReportPanel /> : <VatPanel />}
    </div>
  );
};
