import { ArrowLeft, Check, FileText, Lock, ShieldAlert } from 'lucide-react';
import { BookingAction, BookingDraft, Transaction, UiPermissionContext } from '../../types';
import WorkflowActionBar from '../WorkflowActionBar';
import { formatCurrency } from './helpers';

interface EditorHeaderProps {
  transaction: Transaction;
  draft: BookingDraft;
  blocking: boolean;
  readOnly: boolean;
  statusPresentation: { label: string; className: string };
  permissionCtx: UiPermissionContext;
  allowedActions: BookingAction[];
  busy: boolean;
  onBack: () => void;
  onAction: (action: BookingAction) => void;
}

export default function EditorHeader({
  transaction,
  draft,
  blocking,
  readOnly,
  statusPresentation,
  permissionCtx,
  allowedActions,
  busy,
  onBack,
  onAction,
}: EditorHeaderProps) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-subtle shrink-0 gap-3">
      <div className="flex items-center gap-2.5 min-w-0">
        <button
          onClick={onBack}
          className="w-8 h-8 flex items-center justify-center rounded-lg border border-border text-muted hover:bg-surface-muted shrink-0"
        >
          <ArrowLeft size={15} />
        </button>
        <div className="w-8 h-8 bg-foreground rounded-lg flex items-center justify-center text-accent-lime shrink-0">
          <FileText size={15} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-black text-foreground truncate">Buchung erfassen</h2>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${statusPresentation.className}`}>
              {statusPresentation.label}
            </span>
            {blocking ? (
              <span className="px-1.5 py-0.5 rounded-md bg-error-bg text-error text-[10px] font-bold inline-flex items-center gap-0.5">
                <ShieldAlert size={10} /> Blockiert
              </span>
            ) : (
              <span className="px-1.5 py-0.5 rounded-md bg-success-bg text-success text-[10px] font-bold inline-flex items-center gap-0.5">
                <Check size={10} /> OK
              </span>
            )}
            {readOnly && (
              <span className="px-1.5 py-0.5 rounded-md bg-canvas text-muted text-[10px] font-bold inline-flex items-center gap-0.5">
                <Lock size={10} /> Read-only
              </span>
            )}
          </div>
          <p className="text-xs text-muted font-medium mt-0.5">
            {transaction.payee} • {new Date(transaction.date).toLocaleDateString('de-DE')} •{' '}
            <span className="tabular-nums">{formatCurrency(transaction.amount, transaction.currency)}</span>
          </p>
        </div>
      </div>

      <WorkflowActionBar
        draft={draft}
        permissionCtx={permissionCtx}
        allowedActions={allowedActions}
        onAction={onAction}
        isBusy={busy}
      />
    </div>
  );
}
