import { Badge, Button, Card, CardHeader, EmptyState } from '@billme/ui';
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
  totalLabel,
  total,
  onSelectLine,
}: {
  title: string;
  lines: BalanceSheetPreviewLine[];
  totalLabel: string;
  total: number;
  onSelectLine: (line: BalanceSheetPreviewLine) => void;
}) {
  return (
    <div className="min-w-0">
      <div className="px-3.5 pb-1.5 pt-3 text-eyebrow uppercase text-muted">{title}</div>
      {lines.map((line) => (
        <button
          key={line.id}
          type="button"
          onClick={() => onSelectLine(line)}
          disabled={!line.accountRefs?.length}
          title={line.accountRefs?.length ? 'Konten-Drilldown öffnen' : 'Kein Konten-Mapping verfügbar'}
          aria-label={`${positionTitle(line, ' ')}${line.accountRefs?.length ? '' : ' (kein Konten-Mapping verfügbar)'}`}
          className={`flex w-full items-start justify-between gap-3 border-b border-border px-3.5 py-2.25 text-left text-control transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-60 ${line.accountRefs?.length ? 'hover:bg-surface-muted' : ''} ${line.isSubtotal ? 'bg-surface-muted' : ''}`}
        >
          <span className="block min-w-0" style={{ paddingLeft: `${line.level * 14}px` }}>
            {displayPositionCode(line.code) ? <span className="block text-caption text-muted tabular-nums">{displayPositionCode(line.code)}</span> : null}
            <span className={`block text-foreground ${line.isSubtotal ? 'font-semibold' : ''}`}>{line.label}</span>
          </span>
          <span className={`shrink-0 font-medium tabular-nums ${line.amount < 0 ? 'text-error-text' : 'text-foreground'}`}>
            {euro(line.amount)}
          </span>
        </button>
      ))}
      <div className="flex items-center justify-between gap-3 px-3.5 py-3 text-control font-bold text-foreground">
        <span>{totalLabel}</span>
        <span className="tabular-nums">{euro(total)}</span>
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

  const statusTone = report.quality.status === 'ok' ? 'success' : report.quality.status === 'warning' ? 'warning' : 'error';

  return (
    <div className="space-y-3.5">
      <ReportSummaryCards
        cards={[
          {
            label: 'Differenz',
            value: euro(report.totals.difference),
            tone: report.totals.difference === 0 ? 'ok' : 'danger',
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

      <Card padding="none" className="overflow-hidden">
        <CardHeader
          className="border-b border-border px-3.5 py-3"
          title="Bilanz (HGB)"
          count={`Stand: ${new Date(report.quality.generatedAt).toLocaleString('de-DE')}`}
          actions={(
            <Badge tone={statusTone}>
              {report.quality.status === 'ok' ? 'OK' : report.quality.status === 'warning' ? 'Prüfen' : 'Fehler'}
            </Badge>
          )}
        />
        {report.quality.notes.length > 0 ? (
          <ul className="space-y-1 border-b border-border px-3.5 py-3 text-control text-muted">
            {report.quality.notes.map((note) => (
              <li key={note} className="flex items-start gap-2">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted" aria-hidden="true" />
                <span>{note}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="grid grid-cols-1 divide-y divide-border-strong xl:grid-cols-2 xl:divide-x xl:divide-y-0">
          <SideColumn title="Aktiva" lines={report.aktiva} totalLabel="Aktiva gesamt" total={report.totals.aktiva} onSelectLine={onSelectLine} />
          <SideColumn title="Passiva" lines={report.passiva} totalLabel="Passiva gesamt" total={report.totals.passiva} onSelectLine={onSelectLine} />
        </div>
      </Card>
    </div>
  );
}
