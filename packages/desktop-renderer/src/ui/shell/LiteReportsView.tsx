import React from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { PageHeader, SegmentedControl } from '@billme/ui';
import { LiteVatPanel } from '../../components/eur/LiteVatPanel';
import { useSettingsQuery } from '../../hooks/useSettings';
import { EurReportPanel } from '../../components/EurReportPanel';
import { StatisticsView } from './StatisticsView';

type ReportTab = 'umsatz' | 'eur' | 'ust';

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
    <div className="flex flex-col pb-4">
      <PageHeader title="Auswertungen" description="Finanzüberblick, Anlage EÜR und Umsatzsteuer" toolbar={tabs} />
      {tab === 'eur' ? <EurReportPanel /> : <LiteVatPanel />}
    </div>
  );
};
