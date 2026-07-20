import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { GuvLine, GuvReport, ReportFilterState } from '../../domain/reportTypes';
import ReportSummaryCards from './ReportSummaryCards';

function euro(value: number) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
}

interface GuvViewProps {
  report: GuvReport | null;
  compareMode: ReportFilterState['compareMode'];
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

export default function GuvView({ report, compareMode, onSelectLine }: GuvViewProps) {
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
            value: `${report.quality.unmappedAccounts} ungemappt`,
            sublabel: `${report.quality.warnings} Hinweise`,
            tone: report.quality.unmappedAccounts > 0 ? 'warning' : 'ok',
          },
        ]}
      />

      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <div className="px-4 h-12 border-b border-border-subtle flex items-center justify-between gap-3">
          <div className="text-sm font-bold text-foreground">Gewinn- und Verlustrechnung (Preview)</div>
          <div className="text-xs text-muted">
            Stand: {new Date(report.quality.generatedAt).toLocaleString('de-DE')}
          </div>
        </div>

        <div className="max-h-[32rem] overflow-auto">
          <table className="w-full text-sm table-fixed">
            <colgroup>
              <col className="w-[55%]" />
              <col className="w-[15%]" />
              {compareMode !== 'none' ? <col className="w-[15%]" /> : null}
              {compareMode !== 'none' ? <col className="w-[15%]" /> : null}
            </colgroup>
            <thead className="sticky top-0 bg-surface-muted z-10">
              <tr className="text-xs uppercase tracking-wide text-muted">
                <th className="px-3 py-3 text-left font-bold">Position</th>
                <th className="px-3 py-3 text-right font-bold">Aktuell</th>
                {compareMode !== 'none' && <th className="px-3 py-3 text-right font-bold">Vergleich</th>}
                {compareMode !== 'none' && <th className="px-3 py-3 text-right font-bold">Delta</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {visibleLines.map(({ line, level }) => {
                const hasChildren = Boolean(line.children?.length);
                const delta = (line.amountCompare ?? 0) !== undefined && line.amountCompare !== undefined
                  ? line.amountCurrent - line.amountCompare
                  : undefined;
                return (
                  <tr
                    key={line.id}
                    className={`cursor-pointer hover:bg-surface-muted ${line.isSubtotal ? 'bg-surface-muted/70' : ''}`}
                    onClick={() => onSelectLine(line)}
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
                        <div className="min-w-0">
                          <div className={`font-medium ${line.isSubtotal ? 'font-bold text-foreground' : 'text-foreground'}`}>
                            <span className="text-muted mr-2">{line.code}</span>
                            {line.label}
                          </div>
                          {line.accountRefs?.length ? (
                            <div className="text-xs text-muted">Konten: {line.accountRefs.join(', ')}</div>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td className={`px-3 py-2.5 text-right font-bold ${line.amountCurrent < 0 ? 'text-error' : 'text-foreground'}`}>
                      {euro(line.amountCurrent)}
                    </td>
                    {compareMode !== 'none' && (
                      <td className={`px-3 py-2.5 text-right font-medium ${(line.amountCompare ?? 0) < 0 ? 'text-error' : 'text-muted'}`}>
                        {line.amountCompare !== undefined ? euro(line.amountCompare) : '—'}
                      </td>
                    )}
                    {compareMode !== 'none' && (
                      <td className={`px-3 py-2.5 text-right font-medium ${delta !== undefined && delta < 0 ? 'text-error' : 'text-success'}`}>
                        {delta !== undefined ? euro(delta) : '—'}
                      </td>
                    )}
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
