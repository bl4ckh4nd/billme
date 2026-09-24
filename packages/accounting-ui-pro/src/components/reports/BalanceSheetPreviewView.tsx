import { Button, EmptyState } from '@billme/ui';
import { BalanceSheetPreview, BalanceSheetPreviewLine } from '../../domain/reportTypes';
import { displayPositionCode, positionTitle } from '../../domain/references';
import ReportSummaryCards from './ReportSummaryCards';

function euro(value: number) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
}

interface BalanceSheetPreviewViewProps {
  report: BalanceSheetPreview | null;
  onSelectLine: (line: BalanceSheetPreviewLine) => void;
  onRetry?: () => void;
}

function SideColumn({
  title,
  lines,
  onSelectLine,
}: {
  title: string;
  lines: BalanceSheetPreviewLine[];
  onSelectLine: (line: BalanceSheetPreviewLine) => void;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface overflow-hidden">
      <div className="px-4 py-3 border-b border-subtle text-sm font-semibold text-foreground">{title}</div>
      <div className="divide-y divide-border-subtle">
        {lines.map((line) => (
          <button
            key={line.id}
            type="button"
            onClick={() => onSelectLine(line)}
            disabled={!line.accountRefs?.length}
            title={line.accountRefs?.length ? 'Konten-Drilldown öffnen' : 'Kein Konten-Mapping verfügbar'}
            aria-label={`${positionTitle(line, ' ')}${line.accountRefs?.length ? '' : ' (kein Konten-Mapping verfügbar)'}`}
            className={`w-full text-left px-4 py-3 transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${line.accountRefs?.length ? 'hover:bg-surface-muted' : ''} ${line.isSubtotal ? 'bg-surface-muted/70' : ''}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0" style={{ paddingLeft: `${line.level * 14}px` }}>
                {displayPositionCode(line.code) ? <div className="text-xs font-medium text-muted tabular-nums">{displayPositionCode(line.code)}</div> : null}
                <div className={`text-sm ${line.isSubtotal ? 'font-semibold text-foreground' : 'font-medium text-foreground'}`}>
                  {line.label}
                </div>
              </div>
              <div className={`shrink-0 text-sm font-semibold tabular-nums ${line.amount < 0 ? 'text-error-text' : 'text-foreground'}`}>
                {euro(line.amount)}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function BalanceSheetPreviewView({ report, onSelectLine, onRetry }: BalanceSheetPreviewViewProps) {
  if (!report) {
    return (
      <EmptyState
        title="Bilanzvorschau nicht geladen"
        description="Für den Stichtag liegt keine Bilanz nach HGB vor. Laden Sie den Report erneut oder prüfen Sie Zeitraum und Konten-Mapping."
        action={onRetry ? (
          <Button type="button" size="sm" variant="secondary" onClick={onRetry}>
            Erneut laden
          </Button>
        ) : undefined}
      />
    );
  }

  return (
    <div className="space-y-4">
      <ReportSummaryCards
        cards={[
          {
            label: 'Differenz',
            value: euro(report.totals.difference),
            tone: report.totals.difference === 0 ? 'ok' : 'danger',
            emphasis: true,
          },
          { label: 'Aktiva', value: euro(report.totals.aktiva) },
          { label: 'Passiva', value: euro(report.totals.passiva) },
          {
            label: 'Status',
            value: report.quality.status === 'ok' ? 'Plausibel' : report.quality.status === 'warning' ? 'Prüfen' : 'Fehler',
            sublabel: `${report.quality.notes.length} Hinweise`,
            tone: report.quality.status === 'ok' ? 'ok' : report.quality.status === 'warning' ? 'warning' : 'danger',
          },
        ]}
      />

      <div className="rounded-2xl border border-border bg-surface p-4 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-foreground">Bilanz (HGB)</div>
            <div className="text-xs text-muted">Stand: {new Date(report.quality.generatedAt).toLocaleString('de-DE')}</div>
          </div>
          <span
            className={`px-2.5 py-1 rounded-full text-xs font-semibold ${
              report.quality.status === 'ok'
                ? 'bg-success-bg text-success-text'
                : report.quality.status === 'warning'
                  ? 'bg-warning-bg text-warning-text'
                  : 'bg-error-bg text-error-text'
            }`}
          >
            {report.quality.status === 'ok' ? 'OK' : report.quality.status === 'warning' ? 'Prüfen' : 'Fehler'}
          </span>
        </div>
        <ul className="space-y-1 text-sm text-muted">
          {report.quality.notes.map((note) => (
            <li key={note} className="flex items-start gap-2">
              <span className="mt-1 h-1.5 w-1.5 rounded-full bg-muted" />
              <span>{note}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <SideColumn title="Aktiva" lines={report.aktiva} onSelectLine={onSelectLine} />
        <SideColumn title="Passiva" lines={report.passiva} onSelectLine={onSelectLine} />
      </div>

      <div className="rounded-2xl border border-border bg-surface p-4">
        <div className="rounded-xl border border-border-subtle bg-surface-muted px-4 py-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">Differenz</div>
          <div className={`mt-1 text-base font-semibold tabular-nums ${report.totals.difference === 0 ? 'text-success-text' : 'text-error-text'}`}>
            {euro(report.totals.difference)}
          </div>
        </div>
        <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2 text-sm">
          <div className="rounded-lg border border-border-subtle px-3 py-2">
            <div className="text-xs font-semibold text-muted">Aktiva gesamt</div>
            <div className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">{euro(report.totals.aktiva)}</div>
          </div>
          <div className="rounded-lg border border-border-subtle px-3 py-2">
            <div className="text-xs font-semibold text-muted">Passiva gesamt</div>
            <div className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">{euro(report.totals.passiva)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
