import { Trash2 } from 'lucide-react';
import { findTaxCaseOption, normalizeTaxCaseKey, TAX_CASE_OPTIONS, toLegacyTaxCode } from '../../domain/taxCases';
import { mockAccounts } from '../../mocks/accounts';
import { JournalLine } from '../../types';
import AccountCombobox from '../AccountCombobox';
import { parseAmountInput } from './helpers';
import TaxDetailsRow from './TaxDetailsRow';

interface JournalLineRowProps {
  line: JournalLine;
  readOnly: boolean;
  lineCount: number;
  onUpdateLine: (id: string, updater: (line: JournalLine) => JournalLine) => void;
  onRemoveLine: (id: string) => void;
}

export default function JournalLineRow({
  line,
  readOnly,
  lineCount,
  onUpdateLine,
  onRemoveLine,
}: JournalLineRowProps) {
  const selectedTaxCaseKey = normalizeTaxCaseKey(line.taxCaseKey ?? line.taxCode);
  const selectedTaxCase = findTaxCaseOption(selectedTaxCaseKey);

  return (
    <div className="px-4 py-3 space-y-3">
      <div className="grid grid-cols-12 gap-3 items-center">
        <div className="col-span-1">
          <select
            value={line.type}
            disabled={readOnly}
            onChange={(e) =>
              onUpdateLine(line.id, (current) => ({
                ...current,
                type: e.target.value as 'Soll' | 'Haben',
              }))
            }
            className="w-full border border-border rounded-lg px-2 py-2 text-sm disabled:bg-surface-muted"
          >
            <option value="Soll">Soll</option>
            <option value="Haben">Haben</option>
          </select>
        </div>

        <div className="col-span-4">
          <AccountCombobox
            accounts={mockAccounts}
            valueAccountId={line.accountId}
            valueAccountName={line.accountName}
            disabled={readOnly}
            onSelect={(account) =>
              onUpdateLine(line.id, (current) => {
                const normalized = normalizeTaxCaseKey(
                  current.taxCaseKey ?? current.taxCode ?? account.defaultTaxCode,
                );
                const def = findTaxCaseOption(normalized);
                return {
                  ...current,
                  accountId: account.number,
                  accountName: account.name,
                  taxCaseKey: normalized,
                  taxCode:
                    toLegacyTaxCode(normalized) ??
                    current.taxCode ??
                    account.defaultTaxCode ??
                    '',
                  taxRate: current.taxRate ?? def?.defaultRate,
                };
              })
            }
          />
        </div>

        <div className="col-span-2">
          <label className="sr-only" htmlFor={`cost-center-${line.id}`}>
            Kostenstelle
          </label>
          <input
            id={`cost-center-${line.id}`}
            type="text"
            value={line.costCenter ?? ''}
            disabled={readOnly}
            onChange={(e) =>
              onUpdateLine(line.id, (current) => ({ ...current, costCenter: e.target.value }))
            }
            className="w-full border border-border rounded-lg px-2 py-2 text-sm disabled:bg-surface-muted"
            placeholder="-"
          />
        </div>

        <div className="col-span-2">
          <label className="sr-only" htmlFor={`tax-case-${line.id}`}>
            Steuerfall
          </label>
          <select
            id={`tax-case-${line.id}`}
            value={selectedTaxCaseKey ?? ''}
            disabled={readOnly}
            onChange={(e) =>
              onUpdateLine(line.id, (current) => {
                const nextTaxCase = normalizeTaxCaseKey(e.target.value);
                const nextOption = findTaxCaseOption(nextTaxCase);
                return {
                  ...current,
                  taxCaseKey: nextTaxCase,
                  taxCode: toLegacyTaxCode(nextTaxCase) ?? (nextTaxCase ?? ''),
                  taxRate: nextTaxCase ? current.taxRate ?? nextOption?.defaultRate : undefined,
                };
              })
            }
            className="w-full border border-border rounded-lg px-2 py-2 text-sm disabled:bg-surface-muted"
          >
            <option value="">Keine</option>
            {TAX_CASE_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="col-span-2">
          <label className="sr-only" htmlFor={`amount-${line.id}`}>
            Betrag
          </label>
          <input
            id={`amount-${line.id}`}
            type="number"
            step="0.01"
            min="0"
            value={line.amount}
            disabled={readOnly}
            onChange={(e) =>
              onUpdateLine(line.id, (current) => ({
                ...current,
                amount: parseAmountInput(e.target.value),
              }))
            }
            className="w-full border border-border rounded-lg px-2 py-2 text-sm text-right tabular-nums disabled:bg-surface-muted"
          />
        </div>

        <div className="col-span-1 flex justify-end">
          <button
            onClick={() => onRemoveLine(line.id)}
            disabled={readOnly || lineCount <= 2}
            className="p-2 rounded-lg text-muted hover:text-error hover:bg-error-bg disabled:opacity-40"
            aria-label="Zeile löschen"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      {selectedTaxCase && (
        <TaxDetailsRow
          line={line}
          selectedTaxCase={selectedTaxCase}
          readOnly={readOnly}
          onUpdateLine={onUpdateLine}
        />
      )}
    </div>
  );
}
