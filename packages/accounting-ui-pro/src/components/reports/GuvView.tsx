import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { GuvLine, GuvReport } from '../../domain/reportTypes';
import ReportSummaryCards from './ReportSummaryCards';

function euro(value: number) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
}

interface GuvViewProps {
  report: GuvReport | null;
  onSelectLine: (line: GuvLine) => void;
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

export default function GuvView({ report, onSelectLine }: GuvViewProps) {
  const [expandedIds, setExpandedIds] = useState<string[]>([]);

  const defaultExpanded = useMemo<string[]>(() => (report ? collectExpandable(report.lines) : []), [report]);
  const effectiveExpanded: Set<string> =
    expandedIds.length > 0 ? new Set<string>(expandedIds) : new Set<string>(defaultExpanded);

  const visibleLines = useMemo(
    () => (report ? flattenVisible(report.lines, effectiveExpanded) : []),
    [report, effectiveExpanded],
  );

  if (!report) return null;

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
          { label: 'Umsätze', value: euro(report.totals.revenue), tone: 'ok' },
          { label: 'Aufwendungen', value: euro(report.totals.expenses) },
          {
            label: 'Ergebnis',
            value: euro(report.totals.result),
            tone: report.totals.result >= 0 ? 'ok' : 'danger',
          },
          {
            label: 'Qualität',
            value: `${report.quality.unmappedAccounts.length} ungemappt`,
            sublabel: `${report.quality.warnings} Hinweise`,
            tone: report.quality.unmappedAccounts.length > 0 ? 'warning' : 'ok',
          },
        ]}
      />

      {report.quality.unmappedAccounts.length > 0 ? (
        <div
          data-testid="guv-unmapped-accounts"
          className="rounded-2xl border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning"
        >
          <div className="font-bold">Nicht zugeordnete Konten</div>
          <ul className="mt-1 space-y-0.5 text-xs">
            {report.quality.unmappedAccounts.map((account) => (
              <li key={account.accountNumber}>
                Konto {account.accountNumber}: {euro(account.amount)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="rounded-2xl border border-border bg-surface overflow-hidden">
        <div className="px-4 h-12 border-b border-subtle flex items-center justify-between gap-3">
          <div className="text-sm font-bold text-foreground">Gewinn- und Verlustrechnung</div>
          <div className="text-xs text-muted">
            Stand: {new Date(report.quality.generatedAt).toLocaleString('de-DE')}
          </div>
        </div>

        <div className="max-h-[32rem] overflow-auto">
          <table className="w-full text-sm table-fixed">
            <thead className="sticky top-0 bg-surface-muted z-10">
              <tr className="text-xs uppercase tracking-wide text-muted">
                <th scope="col" className="px-3 py-3 text-left font-bold">Position</th>
                <th scope="col" className="px-3 py-3 text-right font-bold">Aktuell</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {visibleLines.map(({ line, level }) => {
                const hasChildren = Boolean(line.children?.length);
                return (
                  <tr
                    key={line.id}
                    className={`hover:bg-surface-muted ${line.isSubtotal ? 'bg-surface-muted/70' : ''}`}
                  >
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2" style={{ paddingLeft: `${level * 16}px` }}>
                        {hasChildren ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggle(line.id);
                            }}
                            className="w-6 h-6 rounded-md border border-border text-muted hover:bg-surface flex items-center justify-center"
                            aria-label={effectiveExpanded.has(line.id) ? 'Einklappen' : 'Ausklappen'}
                          >
                            {effectiveExpanded.has(line.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </button>
                        ) : (
                          <span className="w-6 h-6" />
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
                          className="min-w-0 text-left rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-info"
                        >
                          <div className={`font-medium ${line.isSubtotal ? 'font-bold text-foreground' : 'text-foreground'}`}>
                            <span className="text-muted mr-2">{line.code}</span>
                            {line.label}
                          </div>
                          {line.accountRefs?.length ? (
                            <div className="text-xs text-muted">Konten: {line.accountRefs.join(', ')}</div>
                          ) : null}
                        </button>
                      </div>
                    </td>
                    <td className={`px-3 py-2.5 text-right font-bold ${line.amountCurrent < 0 ? 'text-error' : 'text-foreground'}`}>
                      {euro(line.amountCurrent)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
