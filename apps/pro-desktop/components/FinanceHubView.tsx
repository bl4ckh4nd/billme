import React from 'react';
import { ArrowRight, ShieldCheck, Wallet } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { useImportSkrMutation, useProLedgerStatsQuery } from '../hooks/useProLedger';

export const FinanceHubView: React.FC = () => {
  const navigate = useNavigate();
  const { data: ledgerStats } = useProLedgerStatsQuery();
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
      setImportNotice(`SKR-Import fehlgeschlagen: ${String(error)}`);
    }
  };

  return (
    <div className="bg-surface rounded-xl p-8 min-h-full shadow-sm">
      <div className="mb-8">
        <h2 className="text-2xl font-black text-foreground">Finanzen</h2>
        <p className="text-sm text-muted mt-1">
          Kontoverwaltung und Pro-Buchhaltung in einem Bereich.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <button
          onClick={() => navigate({ to: '/accounts' })}
          className="text-left p-6 rounded-xl border border-border bg-surface-muted hover:bg-canvas hover:shadow-sm transition-colors duration-200 ease-out"
        >
          <div className="flex items-center justify-between mb-4">
            <div className="w-12 h-12 rounded-lg bg-foreground text-white flex items-center justify-center">
              <Wallet size={22} />
            </div>
            <ArrowRight className="text-muted" />
          </div>
          <div className="text-lg font-black text-foreground">Konten &amp; Transaktionen</div>
          <div className="text-sm text-muted mt-1">
            Bankkonten verwalten, CSV importieren und Konto-SKR-Zuordnung steuern.
          </div>
        </button>

        <button
          onClick={() => navigate({ to: '/accounting' })}
          className="text-left p-6 rounded-xl border border-border bg-surface-muted hover:bg-canvas hover:shadow-sm transition-colors duration-200 ease-out"
        >
          <div className="flex items-center justify-between mb-4">
            <div className="w-12 h-12 rounded-lg bg-foreground text-white flex items-center justify-center">
              <ShieldCheck size={22} />
            </div>
            <ArrowRight className="text-muted" />
          </div>
          <div className="text-lg font-black text-foreground">Pro Buchhaltung</div>
          <div className="text-sm text-muted mt-1">
            Inbox, Buchungssätze, Abgleich, SuSa/GuV/Bilanz und Exceptions.
          </div>
          <div className="mt-3 text-xs font-semibold text-muted tabular-nums">
            Kontenrahmen geladen: {ledgerStats?.total ?? 0}
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
              SKR03: {ledgerStats?.byChart.SKR03 ?? 0} | SKR04: {ledgerStats?.byChart.SKR04 ?? 0}
            </p>
          </div>
          <button
            onClick={() => void handleImportSkr()}
            disabled={importSkr.isPending}
            className="px-4 py-2 rounded-full bg-foreground text-white hover:bg-dark-1 font-bold text-sm transition-colors duration-200 ease-out disabled:opacity-60 disabled:hover:bg-foreground"
          >
            {importSkr.isPending ? 'Import läuft…' : 'SKR jetzt importieren'}
          </button>
        </div>
        {importNotice ? (
          <div className="mt-3 text-sm text-muted">{importNotice}</div>
        ) : null}
      </div>
    </div>
  );
};
