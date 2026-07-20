import { BookingDraft, Transaction } from '../../types';

interface TransactionMetaPanelProps {
  draft: BookingDraft;
  transaction: Transaction;
  readOnly: boolean;
  showReceipt: boolean;
  onToggleReceipt: () => void;
  onPatchDraft: (updater: (prev: BookingDraft) => BookingDraft) => void;
}

export default function TransactionMetaPanel({
  draft,
  transaction,
  readOnly,
  showReceipt,
  onToggleReceipt,
  onPatchDraft,
}: TransactionMetaPanelProps) {
  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <div className="p-4 border-b border-border-subtle bg-surface-muted/50 flex items-center justify-between">
        <h3 className="text-sm font-bold text-foreground">Transaktion & Meta</h3>
        <button
          onClick={onToggleReceipt}
          className="text-xs font-bold px-3 py-1 rounded-full border border-border bg-surface"
        >
          Beleg {showReceipt ? 'ausblenden' : 'einblenden'}
        </button>
      </div>
      <div className="p-4 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-bold uppercase tracking-wide text-muted mb-1">
              Belegdatum
            </label>
            <input
              type="date"
              value={draft.documentDate ?? ''}
              disabled={readOnly}
              onChange={(e) => onPatchDraft((prev) => ({ ...prev, documentDate: e.target.value }))}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm disabled:bg-surface-muted"
            />
          </div>
          <div>
            <label className="block text-xs font-bold uppercase tracking-wide text-muted mb-1">
              Buchungsdatum *
            </label>
            <input
              type="date"
              value={draft.postingDate ?? ''}
              disabled={readOnly}
              onChange={(e) => onPatchDraft((prev) => ({ ...prev, postingDate: e.target.value }))}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm disabled:bg-surface-muted"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-bold uppercase tracking-wide text-muted mb-1">
            Buchungstext *
          </label>
          <input
            type="text"
            value={draft.bookingText}
            disabled={readOnly}
            onChange={(e) => onPatchDraft((prev) => ({ ...prev, bookingText: e.target.value }))}
            className="w-full border border-border rounded-lg px-3 py-2 text-sm disabled:bg-surface-muted"
          />
        </div>

        <div>
          <label className="block text-xs font-bold uppercase tracking-wide text-muted mb-1">
            Referenz / Belegnummer
          </label>
          <input
            type="text"
            value={draft.externalReference ?? ''}
            disabled={readOnly}
            onChange={(e) => onPatchDraft((prev) => ({ ...prev, externalReference: e.target.value }))}
            className="w-full border border-border rounded-lg px-3 py-2 text-sm disabled:bg-surface-muted"
          />
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-xl border border-border p-3">
            <div className="text-xs font-bold uppercase tracking-wide text-muted">Mandant/Framework</div>
            <div className="font-bold text-foreground mt-1">{draft.chartFramework} (Default)</div>
          </div>
          <div className="rounded-xl border border-border p-3">
            <div className="text-xs font-bold uppercase tracking-wide text-muted">Belegstatus</div>
            <div className={`font-bold mt-1 ${transaction.hasReceipt ? 'text-success' : 'text-warning'}`}>
              {transaction.hasReceipt ? 'Beleg vorhanden' : 'Beleg fehlt'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
