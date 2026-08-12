import { BalanceSheetPreview, BalanceSheetPreviewLine } from '../../domain/reportTypes';
import ReportSummaryCards from './ReportSummaryCards';

function euro(value: number) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
}

interface BalanceSheetPreviewViewProps {
  report: BalanceSheetPreview | null;
  onSelectLine: (line: BalanceSheetPreviewLine) => void;
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
    <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 text-sm font-bold text-gray-900">{title}</div>
      <div className="divide-y divide-gray-100">
        {lines.map((line) => (
          <button
            key={line.id}
            onClick={() => onSelectLine(line)}
            className={`w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors ${line.isSubtotal ? 'bg-gray-50/70' : ''}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0" style={{ paddingLeft: `${line.level * 14}px` }}>
                <div className="text-xs font-bold uppercase tracking-wide text-gray-400">{line.code}</div>
                <div className={`text-sm ${line.isSubtotal ? 'font-bold text-gray-900' : 'font-medium text-gray-700'}`}>
                  {line.label}
                </div>
              </div>
              <div className={`shrink-0 text-sm font-bold ${line.amount < 0 ? 'text-red-700' : 'text-gray-900'}`}>
                {euro(line.amount)}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function BalanceSheetPreviewView({ report, onSelectLine }: BalanceSheetPreviewViewProps) {
  if (!report) return null;

  return (
    <div className="space-y-4">
      <ReportSummaryCards
        cards={[
          { label: 'Aktiva', value: euro(report.totals.aktiva) },
          { label: 'Passiva', value: euro(report.totals.passiva) },
          {
            label: 'Differenz',
            value: euro(report.totals.difference),
            tone: report.totals.difference === 0 ? 'ok' : 'danger',
          },
          {
            label: 'Status',
            value: report.quality.status === 'ok' ? 'Plausibel' : report.quality.status === 'warning' ? 'Prüfen' : 'Fehler',
            sublabel: `${report.quality.notes.length} Hinweise`,
            tone: report.quality.status === 'ok' ? 'ok' : report.quality.status === 'warning' ? 'warning' : 'danger',
          },
        ]}
      />

      <div className="rounded-2xl border border-gray-200 bg-white p-4 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-bold text-gray-900">Bilanz (HGB)</div>
            <div className="text-xs text-gray-500">Stand: {new Date(report.quality.generatedAt).toLocaleString('de-DE')}</div>
          </div>
          <span
            className={`px-2.5 py-1 rounded-full text-xs font-bold ${
              report.quality.status === 'ok'
                ? 'bg-emerald-100 text-emerald-700'
                : report.quality.status === 'warning'
                  ? 'bg-amber-100 text-amber-700'
                  : 'bg-red-100 text-red-700'
            }`}
          >
            {report.quality.status === 'ok' ? 'OK' : report.quality.status === 'warning' ? 'Prüfen' : 'Fehler'}
          </span>
        </div>
        <ul className="space-y-1 text-sm text-gray-600">
          {report.quality.notes.map((note) => (
            <li key={note} className="flex items-start gap-2">
              <span className="mt-1 h-1.5 w-1.5 rounded-full bg-gray-400" />
              <span>{note}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <SideColumn title="Aktiva" lines={report.aktiva} onSelectLine={onSelectLine} />
        <SideColumn title="Passiva" lines={report.passiva} onSelectLine={onSelectLine} />
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
          <div className="rounded-xl border border-gray-100 p-3">
            <div className="text-xs font-bold text-gray-400 uppercase tracking-wide">Aktiva gesamt</div>
            <div className="mt-1 text-lg font-bold text-gray-900">{euro(report.totals.aktiva)}</div>
          </div>
          <div className="rounded-xl border border-gray-100 p-3">
            <div className="text-xs font-bold text-gray-400 uppercase tracking-wide">Passiva gesamt</div>
            <div className="mt-1 text-lg font-bold text-gray-900">{euro(report.totals.passiva)}</div>
          </div>
          <div className="rounded-xl border border-gray-100 p-3">
            <div className="text-xs font-bold text-gray-400 uppercase tracking-wide">Differenz</div>
            <div className={`mt-1 text-lg font-bold ${report.totals.difference === 0 ? 'text-emerald-700' : 'text-red-700'}`}>
              {euro(report.totals.difference)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
