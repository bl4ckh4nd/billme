import React from 'react';
import { Button } from '@billme/ui';
import { Sparkles, TrendingUp, TrendingDown, Save, Tags } from 'lucide-react';
import {
  type EurItem,
  type EurLineOption,
  type VatMode,
  LAYER_LABELS,
  LAYER_COLORS,
  formatCurrency,
} from './types';

type Props = {
  activeItem: EurItem | undefined;
  activeLineOptions: EurLineOption[];
  selectedLineId: string;
  onSelectedLineIdChange: (id: string) => void;
  vatMode: VatMode;
  onVatModeChange: (mode: VatMode) => void;
  excluded: boolean;
  onExcludedChange: (v: boolean) => void;
  isApplying: boolean;
  onSave: () => void;
  onReset: () => void;
};

export const ClassificationPanel: React.FC<Props> = ({
  activeItem,
  activeLineOptions,
  selectedLineId,
  onSelectedLineIdChange,
  vatMode,
  onVatModeChange,
  excluded,
  onExcludedChange,
  isApplying,
  onSave,
  onReset,
}) => {
  return (
    <div className="rounded-xl border border-border p-4 lg:col-span-1">
      <h3 className="font-bold text-foreground mb-3 flex items-center gap-2">
        <Tags size={18} className="text-muted" />
        Klassifizierung
      </h3>
      {!activeItem ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted">
          <Tags size={48} className="mb-4 opacity-50" />
          <p className="text-lg font-medium">Kein Eintrag ausgewählt</p>
          <p className="text-sm text-center mt-2">Wählen Sie links einen Eintrag zur Klassifizierung aus.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Active Item Summary Card */}
          <div className="rounded-lg border border-border bg-surface-muted p-3">
            <div className="flex items-center gap-2 mb-1">
              {activeItem.flowType === 'income' ? (
                <TrendingUp size={16} className="text-success" />
              ) : (
                <TrendingDown size={16} className="text-error" />
              )}
              <span className="text-sm font-bold text-foreground truncate">{activeItem.counterparty}</span>
            </div>
            <div className="text-xs text-muted truncate">{activeItem.purpose}</div>
            <div className={`text-sm tabular-nums font-bold mt-1 ${
              activeItem.flowType === 'income' ? 'text-success' : 'text-error'
            }`}>
              {formatCurrency(activeItem.amountGross)}
            </div>
            <div className="text-xs text-muted mt-1">
              {activeItem.classification?.updatedAt
                ? `Zuletzt: ${new Date(activeItem.classification.updatedAt).toLocaleString('de-DE')}`
                : 'Noch nicht klassifiziert'}
            </div>
          </div>

          {/* Suggestion Button */}
          {activeItem.suggestedLineId && (
            <button
              onClick={() => {
                onSelectedLineIdChange(activeItem.suggestedLineId!);
                onExcludedChange(false);
              }}
              className="w-full rounded-lg border border-info-border bg-info-bg px-3 py-2.5 text-left hover:bg-info-border transition-colors duration-150 ease-out"
            >
              <div className="flex items-center gap-2">
                <Sparkles size={16} className="text-info flex-shrink-0" />
                <div className="flex-1">
                  <div className="text-xs text-info font-semibold flex items-center gap-2">
                    Vorschlag übernehmen
                    {activeItem.suggestionLayer && (
                      <span className={`px-1.5 py-0.5 rounded-full text-[10px] ${LAYER_COLORS[activeItem.suggestionLayer]}`}>
                        {LAYER_LABELS[activeItem.suggestionLayer]}
                      </span>
                    )}
                  </div>
                  {activeItem.suggestionReason && (
                    <div className="text-xs text-info">{activeItem.suggestionReason}</div>
                  )}
                </div>
              </div>
            </button>
          )}

          {/* Kennziffer Select */}
          <div>
            <label className="block text-xs font-bold text-foreground">Kennziffer</label>
            <select
              value={selectedLineId}
              onChange={(e) => onSelectedLineIdChange(e.target.value)}
              disabled={excluded}
              className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm"
            >
              <option value="">Nicht zugeordnet</option>
              {activeLineOptions.map((line) => (
                <option key={line.lineId} value={line.lineId}>
                  {line.kennziffer ? `${line.kennziffer} - ` : ''}{line.label}
                </option>
              ))}
            </select>
          </div>

          {/* VAT Mode Select */}
          <div>
            <label className="block text-xs font-bold text-foreground">USt. Modus</label>
            <select
              value={vatMode}
              onChange={(e) => onVatModeChange(e.target.value as VatMode)}
              className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm"
            >
              <option value="none">Keine USt. Umrechnung</option>
              <option value="default">Default USt. (Netto)</option>
            </select>
          </div>

          {/* Excluded Checkbox */}
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={excluded}
              onChange={(e) => onExcludedChange(e.target.checked)}
            />
            Privat/Transfer ausschließen
          </label>

          {/* Action Buttons */}
          <div className="flex items-center gap-2">
            <Button onClick={onSave} disabled={isApplying} fullWidth>
              <Save size={16} />
              {isApplying ? 'Speichern...' : 'Klassifizierung speichern'}
            </Button>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={onReset}
          >
            Zurücksetzen
          </Button>
        </div>
      )}
    </div>
  );
};
