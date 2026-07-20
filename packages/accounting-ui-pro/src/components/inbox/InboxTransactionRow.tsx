import { getBookingDraftByTransactionId } from '../../services/mockBookingStore';
import { getStatusPresentation } from '../../domain/selectors';
import { Transaction } from '../../types';
import IssueBadges from '../IssueBadges';
import { formatCurrency } from './helpers';

interface InboxTransactionRowProps {
  tx: Transaction;
  isSelected: boolean;
  isPreviewSelected: boolean;
  onToggleSelect: (txId: string) => void;
  onClickRow: (txId: string) => void;
}

export default function InboxTransactionRow({
  tx,
  isSelected,
  isPreviewSelected,
  onToggleSelect,
  onClickRow,
}: InboxTransactionRowProps) {
  const draft = getBookingDraftByTransactionId(tx.id);
  const status = getStatusPresentation(tx.workflowStatus);
  const blockerCount = draft?.validationIssues.filter((issue) => issue.blocking).length ?? 0;

  return (
    <tr
      onClick={() => onClickRow(tx.id)}
      className={`hover:bg-surface-muted/60 transition-colors duration-150 ease-out cursor-pointer ${
        isPreviewSelected ? 'bg-surface-muted/90 shadow-[inset_3px_0_0_0_#111827]' : ''
      } ${blockerCount > 0 ? 'shadow-[inset_1px_0_0_0_#fecaca]' : ''}`}
    >
      <td className="px-3 py-4 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          aria-label={`${tx.payee} markieren`}
          checked={isSelected}
          onChange={() => onToggleSelect(tx.id)}
          className="rounded border-border"
        />
      </td>
      <td className="px-3 py-4 whitespace-nowrap align-top">
        <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-bold ${status.className}`}>
          {status.label}
        </span>
      </td>
      <td className="px-3 py-4 whitespace-nowrap text-sm text-muted font-medium align-top">
        {new Date(tx.date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}
      </td>
      <td className="px-3 py-4 align-top">
        <div className="font-bold text-foreground text-sm">{tx.payee}</div>
        <div className="text-xs text-muted mt-0.5 line-clamp-1">{tx.description}</div>
      </td>
      <td className="px-3 py-4 text-right align-top">
        <div className="flex flex-col items-end gap-1">
          <IssueBadges transaction={tx} />
        </div>
      </td>
      <td className={`px-3 py-4 whitespace-nowrap text-sm font-bold text-right tabular-nums align-top ${tx.amount < 0 ? 'text-error' : 'text-success'}`}>
        {formatCurrency(tx.amount, tx.currency)}
      </td>
    </tr>
  );
}
