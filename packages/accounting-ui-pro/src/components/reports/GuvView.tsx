import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  Button, EmptyState, IconButton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@billme/ui';
import { GuvLine, GuvReport } from '../../domain/reportTypes';
import ReportSummaryCards from './ReportSummaryCards';
import { displayPositionCode } from '../../domain/references';

function euro(value: number) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
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
    <div className="space-y-4">
      <ReportSummaryCards
        cards={[
          {
            label: 'Ergebnis',
            value: euro(report.totals.result),
            tone: report.totals.result >= 0 ? 'ok' : 'danger',
            emphasis: true,
          },
          { label: 'Umsätze', value: euro(report.totals.revenue) },
          { label: 'Aufwendungen', value: euro(report.totals.expenses) },
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
          className="rounded-2xl border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning-text"
        >
          <div className="font-semibold">Nicht zugeordnete Konten</div>
          <ul className="mt-1 space-y-0.5 text-xs">
            {report.quality.unmappedAccounts.map((account) => (
              <li key={account.accountNumber}>
                Konto {account.accountNumber}: {euro(account.amount)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-card bg-surface shadow-xs">
        <div className="px-4 h-12 border-b border-border-subtle flex items-center justify-between gap-3">
          <div className="text-sm font-semibold text-foreground">{title}</div>
          <div className="text-xs text-muted">
            Stand: {new Date(report.quality.generatedAt).toLocaleString('de-DE')}
          </div>
        </div>

        {visibleLines.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title="Keine GuV-Positionen im Zeitraum"
              description="Der Report wurde geladen, enthält für die gewählten Filter aber keine Positionen. Prüfen Sie Zeitraum und Konten-Mapping."
              action={retryAction}
            />
          </div>
        ) : (
          <Table aria-label={title} bare containerClassName="max-h-[32rem]" className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead>Position</TableHead>
                <TableHead numeric className="w-40">Aktuell</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleLines.map(({ line, level }) => {
                const hasChildren = Boolean(line.children?.length);
                const expanded = effectiveExpanded.has(line.id);
                return (
                  <TableRow key={line.id} className={line.isSubtotal ? 'bg-surface-muted' : undefined}>
                    <TableCell className="py-2">
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
                          <span className="size-8 shrink-0" aria-hidden="true" />
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
                            <div className="text-xs text-muted">Konten: {line.accountRefs.join(', ')}</div>
                          ) : null}
                        </button>
                      </div>
                    </TableCell>
                    <TableCell numeric className={`font-medium ${line.amountCurrent < 0 ? 'text-error-text' : ''}`}>
                      {euro(line.amountCurrent)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
