import React from 'react';
import { ArrowRight, ShieldCheck, Wallet } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { useImportSkrMutation, useProLedgerStatsQuery } from '../hooks/useProLedger';

export const FinanceHubView: React.FC = () => {
  const navigate = useNavigate();
  const {
    data: ledgerStats,
    isPending: ledgerStatsLoading,
    isError: ledgerStatsError,
  } = useProLedgerStatsQuery();
  const importSkr = useImportSkrMutation();
  const [importNotice, setImportNotice] = React.useState<string | null>(null);

  const handleImportSkr = async () => {
    try {
      const result = await importSkr.mutateAsync({ preferredSource: 'auto' });
      const warningSuffix =
        result.warnings.length > 0 ? ` Hinweise: ${result.warnings[0]}` : '';
      setImportNotice(
        `SKR-Import abgeschlossen: ${result.inserted} neu, ${result.updated} aktualisiert.${warningSuffix}`,
      );
    } catch (error) {
      setImportNotice(`SKR-Import konnte nicht verarbeitet werden: ${String(error)}`);
    }
  };

  // A failed or still running stats query must not read as "0 Konten geladen".
  const ledgerTotalText = ledgerStatsError
    ? 'Kontenrahmen-Status konnte nicht geladen werden'
    : ledgerStatsLoading
      ? 'Kontenrahmen wird geladen…'
      : `Kontenrahmen geladen: ${ledgerStats?.total ?? 0}`;
  const ledgerChartText = ledgerStatsError
    ? 'SKR03 und SKR04 konnten nicht geladen werden'
    : ledgerStatsLoading
      ? 'Kontenrahmen wird geladen…'
      : `SKR03: ${ledgerStats?.byChart.SKR03 ?? 0} | SKR04: ${ledgerStats?.byChart.SKR04 ?? 0}`;

  return (
    <div className="bg-surface rounded-2xl p-8 min-h-full shadow-sm">
      <div className="mb-8">
        <h2 className="text-2xl font-black text-foreground">Finanzen</h2>
        <p className="text-sm text-muted mt-1">
          Kontoverwaltung und Pro-Buchhaltung in einem Bereich.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <button
          type="button"
          onClick={() => navigate({ to: '/accounts' })}
          className="rounded-xl border border-border bg-surface p-6 text-left transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          <div className="flex items-center justify-between mb-4">
            <div className="w-12 h-12 rounded-xl bg-dark-1 text-background flex items-center justify-center">
              <Wallet size={22} aria-hidden="true" />
            </div>
            <ArrowRight className="text-muted" aria-hidden="true" />
          </div>
          <div className="text-lg font-black text-foreground">Konten &amp; Transaktionen</div>
          <div className="text-sm text-muted mt-1">
            Bankkonten verwalten, CSV importieren und Konto-SKR-Zuordnung steuern.
          </div>
        </button>

        <button
          type="button"
          onClick={() => navigate({ to: '/accounting' })}
          className="rounded-xl border border-border bg-surface p-6 text-left transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          <div className="flex items-center justify-between mb-4">
            <div className="w-12 h-12 rounded-xl bg-dark-1 text-background flex items-center justify-center">
              <ShieldCheck size={22} aria-hidden="true" />
            </div>
            <ArrowRight className="text-muted" aria-hidden="true" />
          </div>
          <div className="text-lg font-black text-foreground">Pro Buchhaltung</div>
          <div className="text-sm text-muted mt-1">
            Inbox, Buchungssätze, Abgleich, SuSa/GuV/Bilanz und Ausnahmen.
          </div>
          <div className="mt-3 text-xs font-semibold text-foreground tabular-nums">
            {ledgerTotalText}
          </div>
        </button>
      </div>

      <div className="mt-8 rounded-xl border border-border bg-surface-muted p-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h3 className="text-base font-black text-foreground">SKR03/04 Kontenrahmen (Pro)</h3>
            <p className="text-sm text-muted mt-1">
              Lädt den vollständigen Kontenrahmen in die Pro-Datenbank.
            </p>
            <p className="text-xs text-muted mt-2 tabular-nums">
              {ledgerChartText}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleImportSkr()}
            disabled={importSkr.isPending}
            className="rounded-full bg-dark-base px-4 py-2 text-sm font-bold text-background transition-colors hover:bg-dark-1 disabled:opacity-60 disabled:hover:bg-dark-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring-dark"
          >
            {importSkr.isPending ? 'Import läuft…' : 'SKR jetzt importieren'}
          </button>
        </div>
        {importNotice ? (
          <p
            role="status"
            className={`mt-3 text-sm ${importSkr.isError ? 'text-error-text' : 'text-foreground'}`}
          >
            {importNotice}
          </p>
        ) : null}
      </div>
    </div>
  );
};
