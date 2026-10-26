import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  Button, Card, CardHeader, EmptyState, IconButton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@billme/ui';
import { GuvLine, GuvReport } from '../../domain/reportTypes';
import ReportSummaryCards from './ReportSummaryCards';
import { displayPositionCode } from '../../domain/references';

function euro(value: number) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
}

/** Change against the comparison as a signed percentage of its absolute value. */
function deviation(current: number, compare: number) {
  const change = (current - compare) / Math.abs(compare);
  return `${change >= 0 ? '+' : ''}${new Intl.NumberFormat('de-DE', { style: 'percent', maximumFractionDigits: 0 }).format(change)}`;
}

interface GuvViewProps {
  report: GuvReport | null;
  onSelectLine: (line: GuvLine) => void;
  title?: string;
  onRetry?: () => void;
}

interface FlatLine {
  line: GuvLine;
  level: number;
}

function collectExpandable(lines: GuvLine[]): string[] {
  return lines.flatMap((line) => [
    ...(line.children && line.children.length ? [line.id] : []),
    ...(line.children ? collectExpandable(line.children) : []),
  ]);
}

function flattenVisible(lines: GuvLine[], expanded: Set<string>, level = 0): FlatLine[] {
  return lines.flatMap((line) => {
    const current: FlatLine = { line, level };
    if (!line.children?.length || !expanded.has(line.id)) return [current];
    return [current, ...flattenVisible(line.children, expanded, level + 1)];
  });
}

export default function GuvView({ report, onSelectLine, title = 'Gewinn- und Verlustrechnung', onRetry }: GuvViewProps) {
  const [expandedIds, setExpandedIds] = useState<string[]>([]);

  const defaultExpanded = useMemo<string[]>(() => (report ? collectExpandable(report.lines) : []), [report]);
  const effectiveExpanded: Set<string> =
    expandedIds.length > 0 ? new Set<string>(expandedIds) : new Set<string>(defaultExpanded);

  const visibleLines = useMemo(
    () => (report ? flattenVisible(report.lines, effectiveExpanded) : []),
    [report, effectiveExpanded],
  );
  // "Vergleich: Vorjahr" fills amountCompare on every line: then Vorjahr and Abweichung get their own columns.
  const compared = Boolean(report?.totalsCompare) || visibleLines.some(({ line }) => line.amountCompare !== undefined);

  const retryAction = onRetry ? (
    <Button type="button" size="sm" variant="secondary" onClick={onRetry}>
      Erneut laden
    </Button>
  ) : undefined;

  if (!report) {
    return (
      <EmptyState
        title="Keine GuV-Daten geladen"
        description="Für die aktuelle Periode liegt keine Gewinn- und Verlustrechnung vor. Laden Sie den Report erneut oder prüfen Sie Zeitraum und Konten-Mapping."
        action={retryAction}
      />
    );
  }

  const toggle = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev.length ? prev : defaultExpanded);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return Array.from(next);
    });
  };

  return (
    <div className="space-y-3.5">
      <ReportSummaryCards
        cards={[
          {
            label: 'Ergebnis',
            value: euro(report.totals.result),
            ...(report.totalsCompare ? { sublabel: `Vorjahr ${euro(report.totalsCompare.result)}` } : {}),
            tone: report.totals.result >= 0 ? 'ok' : 'danger',
          },
          { label: 'Umsätze', value: euro(report.totals.revenue), ...(report.totalsCompare ? { sublabel: `Vorjahr ${euro(report.totalsCompare.revenue)}` } : {}) },
          { label: 'Aufwendungen', value: euro(report.totals.expenses), ...(report.totalsCompare ? { sublabel: `Vorjahr ${euro(report.totalsCompare.expenses)}` } : {}) },
          {
            label: 'Qualität',
            value: `${report.quality.unmappedAccounts.length} ungemappt`,
            sublabel: `${report.quality.warnings} Hinweise`,
            tone: report.quality.unmappedAccounts.length > 0 ? 'warning' : 'ok',
          },
        ]}
        note={report.quality.source === 'live' ? undefined : 'Beispieldaten: Ergebnis, Zeitraum- und Vergleichswerte stammen aus dem Demo-Datensatz.'}
      />

      {report.quality.unmappedAccounts.length > 0 ? (
        <div
          data-testid="guv-unmapped-accounts"
          className="rounded-control border border-warning-border bg-warning-bg px-3 py-2.5 text-control text-warning-text"
        >
          <div className="font-semibold">Nicht zugeordnete Konten</div>
          <ul className="mt-1 space-y-0.5 text-caption">
            {report.quality.unmappedAccounts.map((account) => (
              <li key={account.accountNumber}>
                Konto {account.accountNumber}: {euro(account.amount)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Card padding="none" className="overflow-hidden">
        <CardHeader
          className="border-b border-border px-3.5 py-3"
          title={title}
          count={`Stand: ${new Date(report.quality.generatedAt).toLocaleString('de-DE')}`}
        />

        {visibleLines.length === 0 ? (
          <EmptyState
            title="Keine GuV-Positionen im Zeitraum"
            description="Der Report wurde geladen, enthält für die gewählten Filter aber keine Positionen. Prüfen Sie Zeitraum und Konten-Mapping."
            action={retryAction}
          />
        ) : (
          <Table aria-label={title} bare containerClassName="max-h-[32rem]" className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead>Position</TableHead>
                <TableHead numeric className="w-40">Aktuell</TableHead>
                {compared ? <TableHead numeric className="w-40">Vorjahr</TableHead> : null}
                {compared ? <TableHead numeric className="w-44">Abweichung</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleLines.map(({ line, level }) => {
                const hasChildren = Boolean(line.children?.length);
                const expanded = effectiveExpanded.has(line.id);
                return (
                  <TableRow key={line.id} className={line.isSubtotal ? 'bg-surface-muted' : undefined}>
                    <TableCell>
                      <div className="flex items-center gap-2" style={{ paddingLeft: `${level * 16}px` }}>
                        {hasChildren ? (
                          <IconButton
                            size="sm"
                            onClick={() => toggle(line.id)}
                            aria-label={expanded ? 'Einklappen' : 'Ausklappen'}
                            aria-expanded={expanded}
                            className="-my-1"
                          >
                            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                          </IconButton>
                        ) : (
                          <span className="size-7.5 shrink-0" aria-hidden="true" />
                        )}
                        <button
                          type="button"
                          onClick={() => onSelectLine(line)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              onSelectLine(line);
                            }
                          }}
                          className="min-w-0 text-left rounded-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                        >
                          <div className={line.isSubtotal ? 'font-semibold' : 'font-medium'}>
                            {displayPositionCode(line.code) ? <span className="mr-2 text-muted tabular-nums">{displayPositionCode(line.code)}</span> : null}
                            {line.label}
                          </div>
                          {line.accountRefs?.length ? (
                            <div className="text-caption text-muted">Konten: {line.accountRefs.join(', ')}</div>
                          ) : null}
                        </button>
                      </div>
                    </TableCell>
                    <TableCell numeric className={`font-medium ${line.amountCurrent < 0 ? 'text-error-text' : ''}`}>
                      {euro(line.amountCurrent)}
                    </TableCell>
                    {compared ? (
                      <TableCell numeric muted>{euro(line.amountCompare ?? 0)}</TableCell>
                    ) : null}
                    {compared ? (
                      <TableCell numeric className="tabular-nums">
                        {euro(line.amountCurrent - (line.amountCompare ?? 0))}
                        {line.amountCompare ? <span className="ml-1.5 text-caption text-muted">{deviation(line.amountCurrent, line.amountCompare)}</span> : null}
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
