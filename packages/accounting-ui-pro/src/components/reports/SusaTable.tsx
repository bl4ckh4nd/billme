import { useMemo, useState } from 'react';
import {
  Badge, Button, EmptyState, EMPTY_VALUE, Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow,
} from '@billme/ui';
import { SusaReport, SusaRow } from '../../domain/reportTypes';
import ReportSummaryCards from './ReportSummaryCards';

function euro(value: number) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
}

type SortKey = keyof Pick<SusaRow, 'accountNumber' | 'accountName' | 'openingBalance' | 'debitTurnover' | 'creditTurnover' | 'closingBalance'>;

const SORT_COLUMNS: Array<{ key: SortKey; label: string; numeric: boolean }> = [
  { key: 'accountNumber', label: 'Konto', numeric: false },
  { key: 'accountName', label: 'Bezeichnung', numeric: false },
  { key: 'openingBalance', label: 'Anfang', numeric: true },
  { key: 'debitTurnover', label: 'Soll', numeric: true },
  { key: 'creditTurnover', label: 'Haben', numeric: true },
  { key: 'closingBalance', label: 'Ende', numeric: true },
];

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

      <div className="overflow-hidden rounded-card bg-surface shadow-xs">
        <div className="px-4 h-12 border-b border-border-subtle text-sm font-semibold text-foreground flex items-center">
          Summen- und Saldenliste
        </div>
        <Table aria-label="Summen- und Saldenliste" bare containerClassName="max-h-[32rem]">
          <TableHeader>
            <TableRow>
              {SORT_COLUMNS.map(({ key, label, numeric }) => (
                <TableHead
                  key={key}
                  numeric={numeric}
                  sort={sortKey === key ? sortDir : false}
                  onSort={() => toggleSort(key)}
                >
                  {label}
                </TableHead>
              ))}
              <TableHead>Mapping</TableHead>
              <TableHead>Hinweise</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} muted className="h-24 text-center">
                  Keine SuSa-Daten für die aktuelle Filterkombination.
                </TableCell>
              </TableRow>
            ) : null}
            {rows.map((row) => (
              <TableRow key={row.accountNumber}>
                <TableCell className="whitespace-nowrap font-medium tabular-nums">
                  <button
                    type="button"
                    onClick={() => onSelectRow(row)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onSelectRow(row);
                      }
                    }}
                    className="rounded-xs underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                  >
                    {row.accountNumber}
                  </button>
                </TableCell>
                <TableCell className="min-w-40">{row.accountName}</TableCell>
                <TableCell numeric>{euro(row.openingBalance)}</TableCell>
                <TableCell numeric>{euro(row.debitTurnover)}</TableCell>
                <TableCell numeric>{euro(row.creditTurnover)}</TableCell>
                <TableCell numeric className={`font-medium ${row.closingBalance < 0 ? 'text-error-text' : ''}`}>{euro(row.closingBalance)}</TableCell>
                <TableCell>
                  {row.mappedTo ? <Badge tone="neutral">{row.mappedTo}</Badge> : <Badge tone="warning">Ungemappt</Badge>}
                </TableCell>
                <TableCell>
                  {row.hasWarnings ? <Badge tone="warning">Prüfen</Badge> : <span className="text-muted">{EMPTY_VALUE}</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={2}>Summen</TableCell>
              <TableCell numeric>{euro(report.totals.openingDebit - report.totals.openingCredit)}</TableCell>
              <TableCell numeric>{euro(report.totals.turnoverDebit)}</TableCell>
              <TableCell numeric>{euro(report.totals.turnoverCredit)}</TableCell>
              <TableCell numeric>{euro(report.totals.closingDebit - report.totals.closingCredit)}</TableCell>
              <TableCell colSpan={2} />
            </TableRow>
          </TableFooter>
        </Table>
      </div>
    </div>
  );
}
