import { FileText, Inbox, Upload } from 'lucide-react';
import { normalizeTaxCaseKey, TAX_CASE_OPTIONS } from '../../domain/taxCases';
import { getStatusPresentation } from '../../domain/selectors';
import { mockAccounts } from '../../mocks/accounts';
import AccountCombobox from '../AccountCombobox';
import { BookingAction, BookingDraft, JournalLine, Transaction } from '../../types';
import { formatCurrency, nextActionLabel } from './helpers';

interface InboxDetailPanelProps {
  sidebarCollapsed: boolean;
  previewTx: Transaction | null;
  previewDraft: BookingDraft | undefined;
  previewCounterLine: JournalLine | undefined;
  previewAccountEditable: boolean;
  previewPrimaryAction: BookingAction | undefined;
  notesEdits: Record<string, string>;
  bookingTextEdits: Record<string, string>;
  onNotesChange: (txId: string, value: string) => void;
  onBookingTextChange: (txId: string, value: string) => void;
  onBookingTextCommit: (txId: string) => void;
  onUpdateAccount: (txId: string, accountNumber: string, accountName: string, defaultTaxCode?: string) => void;
  onUpdateTaxCase: (txId: string, value: string) => void;
  onUpdateReceipt: (txId: string, hasReceipt: boolean) => void;
  onPrimaryAction: (tx: Transaction) => void;
  onOpenTransaction: (txId: string) => void;
}

export default function InboxDetailPanel({
  sidebarCollapsed,
  previewTx,
  previewDraft,
  previewCounterLine,
  previewAccountEditable,
  previewPrimaryAction,
  notesEdits,
  bookingTextEdits,
  onNotesChange,
  onBookingTextChange,
  onBookingTextCommit,
  onUpdateAccount,
  onUpdateTaxCase,
  onUpdateReceipt,
  onPrimaryAction,
  onOpenTransaction,
}: InboxDetailPanelProps) {
  return (
    <aside
      className={`shrink-0 flex flex-col h-full border-l border-border-subtle transition-colors duration-300 overflow-hidden ${
        !sidebarCollapsed ? 'w-80 xl:w-[22rem] opacity-100' : 'w-0 opacity-0 pointer-events-none'
      }`}
      aria-hidden={sidebarCollapsed}
    >
      {!previewTx || !previewDraft ? (
        <div className="flex flex-col items-center justify-center h-full text-muted text-sm p-6 text-center gap-3">
          <Inbox size={28} className="text-muted" />
          <span>Transaktion auswählen um die Schnellbuchung zu starten</span>
        </div>
      ) : (
        <>
          {/* Header card */}
          <div className="p-4 border-b border-border-subtle shrink-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-bold text-foreground leading-tight truncate">{previewTx.payee}</div>
                <div className="text-xs text-muted mt-0.5">
                  {new Date(previewTx.date).toLocaleDateString('de-DE')}
                  {previewDraft.externalReference ? ` · ${previewDraft.externalReference}` : ''}
                </div>
              </div>
              <div className={`text-base font-bold tabular-nums shrink-0 ${previewTx.amount < 0 ? 'text-error' : 'text-success'}`}>
                {formatCurrency(previewTx.amount, previewTx.currency)}
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-2">
              <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${getStatusPresentation(previewTx.workflowStatus).className}`}>
                {getStatusPresentation(previewTx.workflowStatus).label}
              </span>
              {!previewTx.hasReceipt && (
                <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-canvas text-muted">
                  Ohne Beleg
                </span>
              )}
            </div>
          </div>

          {/* Scrollable editing form */}
          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-5">
            {/* TRANSAKTIONSDETAILS */}
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted mb-2">
                Transaktionsdetails
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between gap-3">
                  <span className="text-muted shrink-0">Verwendungszweck</span>
                  <span className="font-medium text-foreground text-right line-clamp-2">
                    {previewTx.description ?? '—'}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted shrink-0">Buchungstext</span>
                  <span className="font-medium text-foreground text-right">
                    {previewDraft.bookingText || '—'}
                  </span>
                </div>
                {previewTx.suggestion && (
                  <div className="flex justify-between gap-3">
                    <span className="text-muted shrink-0">Kategorie</span>
                    <span className="font-medium text-foreground text-right">{previewTx.suggestion}</span>
                  </div>
                )}
              </div>
            </div>

            {/* SCHNELLBUCHUNG */}
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted mb-3">
                Schnellbuchung
              </div>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-bold text-muted mb-1">Konto</label>
                  <AccountCombobox
                    accounts={mockAccounts}
                    valueAccountId={previewCounterLine?.accountId ?? ''}
                    valueAccountName={previewCounterLine?.accountName ?? ''}
                    disabled={!previewAccountEditable}
                    onSelect={(account) =>
                      onUpdateAccount(previewTx.id, account.number, account.name, account.defaultTaxCode)
                    }
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-muted mb-1">Steuerfall</label>
                  <select
                    value={normalizeTaxCaseKey(previewCounterLine?.taxCaseKey ?? previewCounterLine?.taxCode) ?? ''}
                    disabled={!previewAccountEditable}
                    onChange={(e) => onUpdateTaxCase(previewTx.id, e.target.value)}
                    className="h-10 w-full border border-border rounded-lg px-3 py-2 text-sm bg-surface disabled:bg-surface-muted"
                  >
                    <option value="">Keine</option>
                    {TAX_CASE_OPTIONS.map((option) => (
                      <option key={option.key} value={option.key}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-muted mb-1">Beleg</label>
                  {previewTx.hasReceipt ? (
                    <button
                      onClick={() => onUpdateReceipt(previewTx.id, false)}
                      disabled={!previewAccountEditable}
                      className="w-full h-10 px-3 rounded-xl border border-success-border bg-success-bg text-success text-sm font-bold hover:bg-success-bg disabled:opacity-50 inline-flex items-center justify-center gap-2"
                    >
                      <FileText size={14} /> Beleg vorhanden
                    </button>
                  ) : (
                    <button
                      onClick={() => onUpdateReceipt(previewTx.id, true)}
                      disabled={!previewAccountEditable}
                      className="w-full h-10 px-3 rounded-xl border border-dashed border-border bg-surface text-muted text-sm font-bold hover:bg-surface-muted disabled:opacity-50 inline-flex items-center justify-center gap-2"
                    >
                      <Upload size={14} /> + Beleg hinzufügen
                    </button>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-bold text-muted mb-1">Notiz</label>
                  <textarea
                    value={notesEdits[previewTx.id] ?? ''}
                    onChange={(e) => onNotesChange(previewTx.id, e.target.value)}
                    placeholder="Optionale Notiz..."
                    rows={3}
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm resize-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-muted mb-1">Buchungstext bearbeiten</label>
                  <input
                    type="text"
                    value={bookingTextEdits[previewTx.id] ?? previewDraft.bookingText ?? ''}
                    disabled={!previewAccountEditable}
                    onChange={(e) => onBookingTextChange(previewTx.id, e.target.value)}
                    onBlur={() => onBookingTextCommit(previewTx.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    }}
                    placeholder="Buchungstext eingeben"
                    className="h-10 w-full border border-border rounded-lg px-3 py-2 text-sm bg-surface disabled:bg-surface-muted"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Action bar */}
          <div className="p-4 border-t border-border-subtle flex gap-2 shrink-0">
            <button
              onClick={() => onPrimaryAction(previewTx)}
              className="flex-1 py-3 rounded-xl bg-foreground text-white font-bold text-sm hover:bg-foreground transition-colors duration-150 ease-out"
            >
              {nextActionLabel(previewPrimaryAction)}
            </button>
            <button
              onClick={() => onOpenTransaction(previewTx.id)}
              className="px-5 py-3 rounded-xl border border-border font-bold text-sm text-muted hover:bg-surface-muted transition-colors duration-150 ease-out"
            >
              Erweitern
            </button>
          </div>
        </>
      )}
    </aside>
  );
}
