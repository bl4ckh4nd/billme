import { UiTaxCaseOption } from '../../domain/taxCases';
import { JournalLine } from '../../types';
import { parseAmountInput } from './helpers';

interface TaxDetailsRowProps {
  line: JournalLine;
  selectedTaxCase: UiTaxCaseOption;
  readOnly: boolean;
  onUpdateLine: (id: string, updater: (line: JournalLine) => JournalLine) => void;
}

export default function TaxDetailsRow({ line, selectedTaxCase, readOnly, onUpdateLine }: TaxDetailsRowProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
      <div>
        <label className="block text-[10px] font-bold uppercase tracking-wide text-muted mb-1">
          Steuersatz %
        </label>
        <input
          type="number"
          step="0.01"
          min="0"
          value={line.taxRate ?? ''}
          disabled={readOnly}
          onChange={(e) =>
            onUpdateLine(line.id, (current) => ({
              ...current,
              taxRate: e.target.value === '' ? undefined : Number(parseAmountInput(e.target.value)),
            }))
          }
          className="w-full border border-border rounded-lg px-2 py-2 text-sm disabled:bg-surface-muted"
        />
      </div>
      <div>
        <label className="block text-[10px] font-bold uppercase tracking-wide text-muted mb-1">
          Land
        </label>
        <input
          type="text"
          value={line.countryCode ?? ''}
          disabled={readOnly}
          onChange={(e) =>
            onUpdateLine(line.id, (current) => ({
              ...current,
              countryCode: e.target.value.toUpperCase(),
            }))
          }
          placeholder={selectedTaxCase.requiresCountry ? 'Pflicht (z.B. FR)' : 'Optional'}
          className="w-full border border-border rounded-lg px-2 py-2 text-sm disabled:bg-surface-muted"
        />
      </div>
      <div>
        <label className="block text-[10px] font-bold uppercase tracking-wide text-muted mb-1">
          USt-IdNr.
        </label>
        <input
          type="text"
          value={line.counterpartyVatId ?? ''}
          disabled={readOnly}
          onChange={(e) =>
            onUpdateLine(line.id, (current) => ({
              ...current,
              counterpartyVatId: e.target.value.toUpperCase(),
            }))
          }
          placeholder={selectedTaxCase.requiresCounterpartyVatId ? 'Pflicht' : 'Optional'}
          className="w-full border border-border rounded-lg px-2 py-2 text-sm disabled:bg-surface-muted"
        />
      </div>
      <div>
        <label className="block text-[10px] font-bold uppercase tracking-wide text-muted mb-1">
          Nachweisart
        </label>
        <input
          type="text"
          value={line.evidenceType ?? ''}
          disabled={readOnly}
          onChange={(e) => onUpdateLine(line.id, (current) => ({ ...current, evidenceType: e.target.value }))}
          placeholder={selectedTaxCase.requiresEvidence ? 'Pflicht' : 'Optional'}
          className="w-full border border-border rounded-lg px-2 py-2 text-sm disabled:bg-surface-muted"
        />
      </div>
      <div>
        <label className="block text-[10px] font-bold uppercase tracking-wide text-muted mb-1">
          Nachweis-Referenz
        </label>
        <input
          type="text"
          value={line.evidenceReference ?? ''}
          disabled={readOnly}
          onChange={(e) =>
            onUpdateLine(line.id, (current) => ({ ...current, evidenceReference: e.target.value }))
          }
          placeholder={selectedTaxCase.requiresEvidence ? 'Pflicht' : 'Optional'}
          className="w-full border border-border rounded-lg px-2 py-2 text-sm disabled:bg-surface-muted"
        />
      </div>
    </div>
  );
}
