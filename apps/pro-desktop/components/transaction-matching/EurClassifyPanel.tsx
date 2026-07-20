import React from 'react';
import { Tags, Layers } from 'lucide-react';
import { Button } from '@billme/ui';
import type { EurTxItem } from './types';
import { formatCurrency } from './formatters';

type EurLineOption = { lineId: string; kennziffer?: string | null; label: string; kind: string };

interface EurClassifyPanelProps {
  eurActive: EurTxItem | null;
  eurLineId: string;
  onEurLineIdChange: (id: string) => void;
  eurVatMode: 'none' | 'default';
  onEurVatModeChange: (mode: 'none' | 'default') => void;
  eurExcluded: boolean;
  onEurExcludedChange: (excluded: boolean) => void;
  eurPending: boolean;
  eurActiveLineOptions: EurLineOption[];
  onApplySingle: () => void;
  onReset: () => void;
}

export const EurClassifyPanel: React.FC<EurClassifyPanelProps> = ({
  eurActive,
  eurLineId,
  onEurLineIdChange,
  eurVatMode,
  onEurVatModeChange,
  eurExcluded,
  onEurExcludedChange,
  eurPending,
  eurActiveLineOptions,
  onApplySingle,
  onReset,
}) => {
  return (
    <div className="w-1/2 overflow-y-auto bg-surface-muted p-6">
      {!eurActive ? (
        <div className="h-full flex flex-col items-center justify-center text-muted">
          <Tags size={42} className="mb-3 opacity-50" />
          <p className="font-medium">Kein Eintrag ausgewählt</p>
          <p className="text-sm">Wählen Sie links eine Transaktion zur EÜR-Klassifizierung.</p>
        </div>
      ) : (
        <div className="bg-surface rounded-xl border border-border p-5 space-y-4">
          <div>
            <h2 className="text-lg font-bold text-foreground">EÜR-Klassifizierung</h2>
            <p className="text-sm text-muted">Direkt in der Bank-Ansicht klassifizieren.</p>
          </div>

          <div className="text-sm text-foreground">
            <div className="font-semibold">{eurActive.counterparty}</div>
            <div className="text-muted">{eurActive.purpose}</div>
            <div className="tabular-nums font-semibold mt-1">{formatCurrency(eurActive.amountGross)}</div>
          </div>

          {eurActive.suggestedLineId && (
            <button
              onClick={() => {
                onEurLineIdChange(eurActive.suggestedLineId ?? '');
                onEurExcludedChange(false);
              }}
              className="w-full rounded-lg border border-info-border bg-info-bg px-3 py-2 text-left"
            >
              <div className="text-xs text-info font-semibold">Vorschlag übernehmen</div>
              <div className="text-xs text-info">{eurActive.suggestionReason ?? 'Automatischer Vorschlag'}</div>
            </button>
          )}

          <div>
            <label className="text-xs font-semibold text-muted">Kennziffer</label>
            <select
              value={eurLineId}
              onChange={(e) => onEurLineIdChange(e.target.value)}
              disabled={eurExcluded}
              className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm"
            >
              <option value="">Nicht zugeordnet</option>
              {eurActiveLineOptions.map((line) => (
                <option key={line.lineId} value={line.lineId}>
                  {line.kennziffer ? `${line.kennziffer} - ` : ''}{line.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-semibold text-muted">USt. Modus</label>
            <select
              value={eurVatMode}
              onChange={(e) => onEurVatModeChange(e.target.value as 'none' | 'default')}
              className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm"
            >
              <option value="none">Keine USt. Umrechnung</option>
              <option value="default">Default USt. (Netto)</option>
            </select>
          </div>

          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={eurExcluded}
              onChange={(e) => onEurExcludedChange(e.target.checked)}
            />
            Privat/Transfer ausschließen
          </label>

          <div className="flex items-center gap-2">
            <Button onClick={() => void onApplySingle()} disabled={eurPending}>
              {eurPending ? 'Speichern...' : 'Klassifizierung speichern'}
            </Button>
            <Button variant="secondary" onClick={onReset}>
              Zurücksetzen
            </Button>
          </div>

          <div className="pt-3 border-t border-border-subtle text-xs text-muted flex items-center gap-1">
            <Layers size={14} />
            Änderungen sind sofort in EÜR-Report und Export sichtbar.
          </div>
        </div>
      )}
    </div>
  );
};
