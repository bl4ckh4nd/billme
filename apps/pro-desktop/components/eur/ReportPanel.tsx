import React from 'react';
import { Layers, Inbox } from 'lucide-react';
import { Spinner } from '../Spinner';
import { type EurReport, formatCurrency } from './types';

type Props = {
  report: EurReport | undefined;
  reportLoading: boolean;
};

export const ReportPanel: React.FC<Props> = ({ report, reportLoading }) => {
  return (
    <div className="rounded-xl border border-border p-4 lg:col-span-1">
      <h3 className="font-bold text-foreground mb-3 flex items-center gap-2">
        <Layers size={18} className="text-muted" />
        Report
      </h3>
      {reportLoading || !report ? (
        <div className="flex flex-col items-center justify-center py-12">
          <Spinner size="md" />
          <p className="text-sm text-muted mt-3">Report wird geladen...</p>
        </div>
      ) : (
        <>
          {/* Summary Stat Cards */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="rounded-lg bg-success-bg border border-success-border p-3">
              <div className="text-[11px] font-bold uppercase tracking-wider text-success">Einnahmen</div>
              <div className="text-lg tabular-nums font-bold text-success mt-1">{formatCurrency(report.summary.incomeTotal)}</div>
            </div>
            <div className="rounded-lg bg-error-bg border border-error-border p-3">
              <div className="text-[11px] font-bold uppercase tracking-wider text-error">Ausgaben</div>
              <div className="text-lg tabular-nums font-bold text-error mt-1">{formatCurrency(report.summary.expenseTotal)}</div>
            </div>
            <div className="rounded-lg bg-surface-muted border border-border p-3">
              <div className="text-[11px] font-bold uppercase tracking-wider text-muted">Überschuss</div>
              <div className={`text-lg tabular-nums font-bold mt-1 ${report.summary.surplus >= 0 ? 'text-success' : 'text-error'}`}>
                {formatCurrency(report.summary.surplus)}
              </div>
            </div>
            <div className="rounded-lg bg-warning-bg border border-warning-border p-3">
              <div className="text-[11px] font-bold uppercase tracking-wider text-warning">Unklassifiziert</div>
              <div className="text-lg tabular-nums font-bold text-warning mt-1">{report.unclassifiedCount}</div>
            </div>
          </div>

          {/* Report Table */}
          {report.rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted">
              <Inbox size={40} className="mb-3 opacity-50" />
              <p className="text-sm font-medium">Keine Positionen</p>
              <p className="text-xs text-center mt-1">Für dieses Steuerjahr liegen noch keine EÜR-Positionen vor.</p>
            </div>
          ) : (
            <div className="max-h-[470px] overflow-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted border-b border-border">
                    <th className="py-2 pr-2 font-semibold">Kz</th>
                    <th className="py-2 pr-2 font-semibold">Bezeichnung</th>
                    <th className="py-2 text-right font-semibold">Betrag</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((row) => (
                    <tr key={row.lineId} className="border-b border-border-subtle hover:bg-surface-muted transition-colors duration-150 ease-out">
                      <td className="py-2 pr-2 align-top font-mono text-muted">{row.kennziffer ?? '-'}</td>
                      <td className="py-2 pr-2">{row.label}</td>
                      <td className={`py-2 text-right tabular-nums font-semibold ${
                        row.kind === 'income' ? 'text-success' :
                        row.kind === 'expense' ? 'text-error' :
                        'text-foreground'
                      }`}>
                        {formatCurrency(row.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
};
