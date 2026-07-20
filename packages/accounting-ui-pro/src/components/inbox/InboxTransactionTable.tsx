import { Transaction } from '../../types';
import InboxTransactionRow from './InboxTransactionRow';

interface InboxTransactionTableProps {
  filtered: Transaction[];
  selectedSet: Set<string>;
  previewId: string | null;
  allVisibleSelected: boolean;
  onToggleSelectAll: () => void;
  onToggleRowSelect: (txId: string) => void;
  onClickRow: (txId: string) => void;
}

export default function InboxTransactionTable({
  filtered,
  selectedSet,
  previewId,
  allVisibleSelected,
  onToggleSelectAll,
  onToggleRowSelect,
  onClickRow,
}: InboxTransactionTableProps) {
  return (
    <div className="flex-1 overflow-auto p-6">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="text-xs uppercase tracking-wider text-muted font-bold border-b border-border-subtle">
            <th scope="col" className="px-3 py-3 w-10">
              <input
                type="checkbox"
                aria-label="Alle sichtbaren Vorgänge markieren"
                checked={allVisibleSelected}
                onChange={onToggleSelectAll}
                className="rounded border-border"
              />
            </th>
            <th scope="col" className="px-3 py-3 w-[128px]">STATUS</th>
            <th scope="col" className="px-3 py-3 w-[90px]">DATUM</th>
            <th scope="col" className="px-3 py-3">EMPFÄNGER / ZWECK</th>
            <th scope="col" className="px-3 py-3 text-right w-[180px]">ISSUES</th>
            <th scope="col" className="px-3 py-3 text-right w-[130px]">BETRAG</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {filtered.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-6 py-12">
                <div className="rounded-xl border border-dashed border-border bg-surface-muted p-8 text-center">
                  <div className="text-sm font-bold text-muted">Keine Vorgänge in dieser Queue</div>
                  <div className="mt-1 text-sm text-muted">Passe Filter oder Queue an, um Vorgänge anzuzeigen.</div>
                </div>
              </td>
            </tr>
          ) : null}
          {filtered.map((tx) => (
            <InboxTransactionRow
              key={tx.id}
              tx={tx}
              isSelected={selectedSet.has(tx.id)}
              isPreviewSelected={previewId === tx.id}
              onToggleSelect={onToggleRowSelect}
              onClickRow={onClickRow}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
