import { useMemo, useState } from 'react';
import { Button, EmptyState, EMPTY_VALUE } from '@billme/ui';
import { SusaReport, SusaRow } from '../../domain/reportTypes';
import ReportSummaryCards from './ReportSummaryCards';

function euro(value: number) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
}

type SortKey = keyof Pick<SusaRow, 'accountNumber' | 'accountName' | 'openingBalance' | 'debitTurnover' | 'creditTurnover' | 'closingBalance'>;

interface SusaTableProps {
  report: SusaReport | null;
  onSelectRow: (row: SusaRow) => void;
  onRetry?: () => void;
}

export default function SusaTable({ report, onSelectRow, onRetry }: SusaTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('accountNumber');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const rows = useMemo(() => {
    if (!report) return [];
    const list = [...report.rows];
    list.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      let cmp = 0;
      if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
      else cmp = String(av).localeCompare(String(bv), 'de');
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [report, sortKey, sortDir]);

  if (!report) {
    return (
      <EmptyState
        title="Summen- und Saldenliste nicht geladen"
        description="Für die aktuelle Periode liegt keine SuSa vor. Laden Sie den Report erneut oder prüfen Sie Zeitraum und Konten-Mapping."
        action={onRetry ? (
          <Button type="button" size="sm" variant="secondary" onClick={onRetry}>
            Erneut laden
          </Button>
        ) : undefined}
      />
    );
  }

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'accountNumber' || key === 'accountName' ? 'asc' : 'desc');
    }
  };

  return (
    <div className="space-y-4">
      <ReportSummaryCards
        cards={[
          { label: 'Umgemappte Konten', value: String(report.quality.unmappedAccounts), tone: report.quality.unmappedAccounts ? 'warning' : 'ok', emphasis: true },
          { label: 'Konten', value: String(report.rows.length) },
          { label: 'Warnungen', value: String(report.quality.warnings), tone: report.quality.warnings ? 'warning' : 'ok' },
          { label: 'Stand', value: new Date(report.quality.generatedAt).toLocaleString('de-DE') },
        ]}
        note={report.quality.source === 'live' ? undefined : 'Beispieldaten: Die Salden und Umsätze dieses Reports stammen aus dem Demo-Datensatz.'}
      />

      <div className="rounded-2xl border border-border bg-surface overflow-hidden">
        <div className="px-4 h-12 border-b border-subtle text-sm font-bold text-foreground flex items-center">
          Summen- und Saldenliste
        </div>
        <div className="max-h-[32rem] overflow-auto">
          <table className="w-full text-sm table-fixed">
            <colgroup>
              <col className="w-28" />
              <col className="w-72" />
              <col className="w-32" />
              <col className="w-32" />
              <col className="w-32" />
              <col className="w-32" />
              <col className="w-48" />
              <col className="w-32" />
            </colgroup>
            <thead className="sticky top-0 bg-surface-muted z-10">
              <tr className="text-xs uppercase tracking-wide text-muted">
                {[
                  ['accountNumber', 'Konto'],
                  ['accountName', 'Bezeichnung'],
                  ['openingBalance', 'Anfang'],
                  ['debitTurnover', 'Soll'],
                  ['creditTurnover', 'Haben'],
                  ['closingBalance', 'Ende'],
                ].map(([key, label]) => (
                  <th scope="col" key={key} className={`px-3 py-3 font-bold ${key.includes('Balance') || key === 'debitTurnover' || key === 'creditTurnover' ? 'text-right' : 'text-left'}`}>
                    <button
                      onClick={() => toggleSort(key as SortKey)}
                      className="hover:text-foreground"
                    >
                      {label}
                    </button>
                  </th>
                ))}
                <th scope="col" className="px-3 py-3 text-left font-bold">Mapping</th>
                <th scope="col" className="px-3 py-3 text-left font-bold">Hinweise</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-10 text-center text-sm text-muted">
                    Keine SuSa-Daten für die aktuelle Filterkombination.
                  </td>
                </tr>
              ) : null}
              {rows.map((row) => (
                <tr
                  key={row.accountNumber}
                  className="hover:bg-surface-muted"
                >
                  <td className="px-3 py-2.5 font-bold text-foreground whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => onSelectRow(row)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onSelectRow(row);
                        }
                      }}
 className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                    >
                      {row.accountNumber}
                    </button>
                  </td>
                  <td className="px-3 py-2.5 text-foreground">{row.accountName}</td>
                  <td className="px-3 py-2.5 text-right font-medium tabular-nums text-foreground">{euro(row.openingBalance)}</td>
                  <td className="px-3 py-2.5 text-right font-medium tabular-nums text-foreground">{euro(row.debitTurnover)}</td>
                  <td className="px-3 py-2.5 text-right font-medium tabular-nums text-foreground">{euro(row.creditTurnover)}</td>
                  <td className={`px-3 py-2.5 text-right font-bold tabular-nums ${row.closingBalance < 0 ? 'text-error-text' : 'text-foreground'}`}>{euro(row.closingBalance)}</td>
                  <td className="px-3 py-2.5">
                    {row.mappedTo ? (
                      <span className="px-2 py-0.5 rounded-full border border-border bg-border-subtle text-foreground text-xs font-bold">{row.mappedTo}</span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-full border border-warning-text bg-warning-bg text-warning-text text-xs font-bold">Ungemappt</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {row.hasWarnings ? (
                      <span className="px-2 py-0.5 rounded-full border border-warning-text bg-warning-bg text-warning-text text-xs font-bold">Prüfen</span>
                    ) : (
                      <span className="text-muted">{EMPTY_VALUE}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-surface-muted border-t border-border">
              <tr className="text-xs font-bold text-foreground tabular-nums">
                <td className="px-3 py-3" colSpan={2}>Summen</td>
                <td className="px-3 py-3 text-right">{euro(report.totals.openingDebit - report.totals.openingCredit)}</td>
                <td className="px-3 py-3 text-right">{euro(report.totals.turnoverDebit)}</td>
                <td className="px-3 py-3 text-right">{euro(report.totals.turnoverCredit)}</td>
                <td className="px-3 py-3 text-right">{euro(report.totals.closingDebit - report.totals.closingCredit)}</td>
                <td className="px-3 py-3" colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}
