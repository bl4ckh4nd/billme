import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AccountingPostingPreview,
  IncomingInvoiceEntity,
  OpenItemEntity,
  OpenItemPaymentEntity,
  VendorEntity,
} from '@billme/accounting-shared';
import type { OposBankTransaction, ProAccountingDataAdapter } from '../services/mockBookingStore';
import { permissionContextForRole } from '../mocks/users';
import type { UserRole } from '../types';
import { Button } from '@billme/ui';

const euro = (value: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
const today = () => new Date().toISOString().slice(0, 10);
const eventId = () => `allocation-${crypto.randomUUID()}`;
const invoiceId = () => `incoming-${crypto.randomUUID()}`;

type OposViewProps = {
  dataAdapter?: ProAccountingDataAdapter;
  role?: UserRole;
};

export default function OposView({ dataAdapter, role = 'admin' }: OposViewProps) {
  const [items, setItems] = useState<OpenItemEntity[]>([]);
  const [bankTransactions, setBankTransactions] = useState<OposBankTransaction[]>([]);
  const [vendors, setVendors] = useState<VendorEntity[]>([]);
  const [invoices, setInvoices] = useState<IncomingInvoiceEntity[]>([]);
  const [selectedItemId, setSelectedItemId] = useState('');
  const [selectedBankTransactionId, setSelectedBankTransactionId] = useState('');
  const [reason, setReason] = useState('');
  const [lastPayment, setLastPayment] = useState<OpenItemPaymentEntity | null>(null);
  const [remainingItemId, setRemainingItemId] = useState('');
  const [remainingAmount, setRemainingAmount] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(today());
  const [dueDate, setDueDate] = useState(today());
  const [vendorId, setVendorId] = useState('');
  const [vendorName, setVendorName] = useState('');
  const [lineDescription, setLineDescription] = useState('');
  const [netAmount, setNetAmount] = useState('');
  const [taxRate, setTaxRate] = useState('19');
  const [invoiceReason, setInvoiceReason] = useState('');
  const [selectedInvoiceId, setSelectedInvoiceId] = useState('');
  const [preview, setPreview] = useState<AccountingPostingPreview | null>(null);
  const [softLockOverride, setSoftLockOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(Boolean(dataAdapter));
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const runInFlightRef = useRef(false);
  const allocationEventRef = useRef<string | null>(null);
  const remainingEventRef = useRef<string | null>(null);
  const canMutate = permissionContextForRole(role).canMutate;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    if (!dataAdapter?.listOpenItems || !dataAdapter.listBankTransactions || !dataAdapter.listVendors || !dataAdapter.listIncomingInvoices) {
      setLoading(false);
      throw new Error('OPOS-Datenadapter ist nicht vollständig konfiguriert.');
    }
    try {
      const [nextItems, nextBankTransactions, nextVendors, nextInvoices] = await Promise.all([
        dataAdapter.listOpenItems(),
        dataAdapter.listBankTransactions(),
        dataAdapter.listVendors(),
        dataAdapter.listIncomingInvoices(),
      ]);
      setItems(nextItems);
      setBankTransactions(nextBankTransactions);
      setVendors(nextVendors);
      setInvoices(nextInvoices);
    } finally {
      setLoading(false);
    }
  }, [dataAdapter]);

  useEffect(() => {
    setError(null);
    void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : 'OPOS-Daten konnten nicht geladen werden.'));
  }, [refresh]);

  const run = async (action: () => Promise<void>) => {
    if (runInFlightRef.current) return;
    runInFlightRef.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Aktion konnte nicht gespeichert werden.');
    } finally {
      runInFlightRef.current = false;
      setBusy(false);
    }
  };

  const selectedItem = items.find((item) => item.id === selectedItemId);
  const selectedInvoice = invoices.find((invoice) => invoice.id === selectedInvoiceId);
  const grossAmount = Number(netAmount || 0) * (1 + Number(taxRate || 0) / 100);

  const selectedBankTransaction = bankTransactions.find((transaction) => transaction.id === selectedBankTransactionId);
  const eligibleBankTransactions = selectedItem
    ? bankTransactions.filter((transaction) => transaction.status === 'pending' && !transaction.linkedInvoiceId && transaction.type === (selectedItem.partyType === 'debtor' ? 'income' : 'expense'))
    : [];

  const selectOpenItem = (id: string) => {
    setSelectedItemId(id);
    setSelectedBankTransactionId('');
    allocationEventRef.current = null;
  };

  const allocate = () => {
    if (!canMutate || !selectedItem || !dataAdapter?.allocateOpenItemPayment) return;
    if (!selectedBankTransaction || !eligibleBankTransactions.some((transaction) => transaction.id === selectedBankTransaction.id) || !reason.trim()) {
      setError('Bitte eine importierte, noch nicht gebuchte Bankzahlung und eine Begründung auswählen.');
      return;
    }
    const amount = Math.abs(selectedBankTransaction.amount);
    if (!Number.isFinite(amount) || amount <= 0 || !selectedBankTransaction.bankAccountNumber) {
      setError('Die ausgewählte Bankzahlung enthält keine gültige Buchungsgrundlage.');
      return;
    }
    if (!allocationEventRef.current) allocationEventRef.current = eventId();
    const allocationEventId = allocationEventRef.current;
    void run(async () => {
      const payment = await dataAdapter.allocateOpenItemPayment!({
        sourceType: 'bank_transaction',
        sourceId: selectedBankTransaction.id,
        partyType: selectedItem.partyType,
        partyId: selectedItem.partyId,
        paymentDate: selectedBankTransaction.date,
        amount,
        bankAccountNumber: selectedBankTransaction.bankAccountNumber,
        allocations: [{ openItemId: selectedItem.id, amount: Math.min(amount, selectedItem.residualAmount) }],
        reason: reason.trim(),
        allocationEventId,
        mutation: { reason: reason.trim(), actor: { type: 'user', displayName: 'Pro Workspace' } },
      });
      setLastPayment(payment);
      allocationEventRef.current = null;
      setSelectedBankTransactionId('');
      setMessage(payment.residualAmount > 0 ? `Zahlung gespeichert. Restbetrag ${euro(payment.residualAmount)}.` : 'Zahlung vollständig zugeordnet.');
      await refresh();
    });
  };

  const allocateRemaining = () => {
    if (!canMutate || !lastPayment || !remainingItemId || !dataAdapter?.allocateRemainingOpenItemPayment || !reason.trim()) {
      setError('Ziel, Betrag und Begründung sind Pflichtfelder.');
      return;
    }
    const amount = Number(remainingAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('Bitte einen gültigen Restbetrag eingeben.');
      return;
    }
    if (!remainingEventRef.current) remainingEventRef.current = eventId();
    const allocationEventId = remainingEventRef.current;
    void run(async () => {
      const payment = await dataAdapter.allocateRemainingOpenItemPayment!(lastPayment.id, [{ openItemId: remainingItemId, amount }], allocationEventId, reason.trim());
      setLastPayment(payment);
      remainingEventRef.current = null;
      setMessage(payment.residualAmount > 0 ? `Restzahlung gespeichert. Verbleibend ${euro(payment.residualAmount)}.` : 'Zahlung vollständig zugeordnet.');
      await refresh();
    });
  };

  const saveInvoice = () => {
    if (!canMutate || !dataAdapter?.upsertIncomingInvoice || !dataAdapter?.upsertVendor || !invoiceReason.trim() || !invoiceNumber.trim() || !lineDescription.trim()) {
      setError('Rechnungsnummer, Position und Begründung sind Pflichtfelder.');
      return;
    }
    const net = Number(netAmount);
    const rate = Number(taxRate);
    if (!Number.isFinite(net) || net <= 0 || !Number.isFinite(rate) || rate < 0) {
      setError('Netto und Steuersatz müssen gültige Werte sein.');
      return;
    }
    void run(async () => {
      let selectedVendorId = vendorId;
      if (!selectedVendorId) {
        if (!vendorName.trim()) throw new Error('Bitte einen Kreditor auswählen oder anlegen.');
        const vendor = await dataAdapter.upsertVendor!({ id: `vendor-${Date.now()}`, name: vendorName.trim() }, invoiceReason.trim());
        selectedVendorId = vendor.id;
      }
      const tax = Math.round(net * rate) / 100;
      const gross = Math.round((net + tax) * 100) / 100;
      const id = invoiceId();
      const saved = await dataAdapter.upsertIncomingInvoice!({
        id,
        tenantId: 'default',
        vendorId: selectedVendorId,
        number: invoiceNumber.trim(),
        invoiceDate,
        dueDate,
        netAmount: net,
        taxAmount: tax,
        grossAmount: gross,
        taxRate: rate,
        status: 'draft',
        accountingStatus: 'unposted',
        lines: [{ id: `${id}-line-1`, incomingInvoiceId: id, position: 0, description: lineDescription.trim(), quantity: 1, unitPrice: net, netAmount: net, taxRate: rate, taxAmount: tax, grossAmount: gross }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, invoiceReason.trim());
      setSelectedInvoiceId(saved.id);
      setMessage('Eingangsrechnung als Entwurf gespeichert.');
      await refresh();
    });
  };

  const finalizeInvoice = () => {
    if (!canMutate || !selectedInvoice || selectedInvoice.status !== 'draft' || !dataAdapter?.upsertIncomingInvoice || !invoiceReason.trim()) {
      setError('Bitte zuerst einen Entwurf auswählen und eine Begründung angeben.');
      return;
    }
    void run(async () => {
      const saved = await dataAdapter.upsertIncomingInvoice!({ ...selectedInvoice, status: 'open' }, invoiceReason.trim());
      setSelectedInvoiceId(saved.id);
      setPreview(null);
      setMessage('Eingangsrechnung zur Buchung freigegeben.');
      await refresh();
    });
  };

  const previewInvoice = () => {
    if (!selectedInvoice || !dataAdapter?.previewIncomingInvoiceAccounting) return;
    void run(async () => setPreview(await dataAdapter.previewIncomingInvoiceAccounting!(selectedInvoice.id)));
  };

  const postInvoice = () => {
    if (!canMutate || !selectedInvoice || !dataAdapter?.postIncomingInvoiceAccounting || !invoiceReason.trim() || (softLockOverride && !overrideReason.trim())) {
      setError(softLockOverride ? 'Bitte eine Override-Begründung angeben.' : 'Bitte zuerst einen Entwurf auswählen und eine Begründung angeben.');
      return;
    }
    void run(async () => {
      const result = await dataAdapter.postIncomingInvoiceAccounting!(selectedInvoice.id, { reason: invoiceReason.trim(), softLockOverride, overrideReason: softLockOverride ? overrideReason.trim() : undefined });
      setPreview(result);
      if (result.status === 'ready') setMessage('Eingangsrechnung gebucht.');
      await refresh();
    });
  };

  return (
    <div className="h-full overflow-auto p-5" data-testid="opos-workspace">
      <div className="mb-5">
        <h2 className="text-xl font-black text-foreground">OPOS</h2>
        <p className="text-sm text-muted">Offene Posten, Zahlungszuordnung und Eingangsrechnungen.</p>
      </div>
      {busy ? <div className="mb-3 text-sm text-muted" aria-live="polite" aria-busy="true">Speichere Änderung…</div> : null}
      {loading ? <div className="mb-3 text-sm text-muted" role="status" aria-live="polite" aria-busy="true">OPOS-Daten werden geladen…</div> : null}
      {error ? <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-error-border bg-error-bg px-3 py-2 text-sm text-error" role="alert" aria-live="assertive"><span>{error}</span><Button type="button" size="sm" variant="secondary" onClick={() => void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : 'OPOS-Daten konnten nicht geladen werden.'))}>Erneut versuchen</Button></div> : null}
      {message ? <div className="mb-3 rounded-lg border border-success-border bg-success-bg px-3 py-2 text-sm text-success" role="status" aria-live="polite">{message}</div> : null}
      {!canMutate ? <div className="mb-3 rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-muted" role="status">Diese Rolle kann OPOS-Daten nur lesen.</div> : null}
      <div className="grid gap-5 xl:grid-cols-2">
        <section className="rounded-xl border border-border p-4" aria-labelledby="open-items-heading">
          <h3 id="open-items-heading" className="mb-3 text-base font-bold">Offene Posten</h3>
          {!loading && !error && items.length === 0 ? <p className="text-sm text-muted">Keine offenen Posten vorhanden.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr className="border-b border-border text-xs text-muted"><th className="p-2">Beleg</th><th className="p-2">Art</th><th className="p-2 text-right">Restbetrag</th><th className="p-2">Status</th></tr></thead>
                <tbody>{items.map((item) => <tr key={item.id} className={`border-b border-border-subtle ${selectedItemId === item.id ? 'bg-surface-muted' : ''}`}><td className="p-2"><button type="button" className="font-semibold underline-offset-2 hover:underline" onClick={() => selectOpenItem(item.id)}>{item.documentNumber}</button></td><td className="p-2">{item.partyType === 'debtor' ? 'Debitor' : 'Kreditor'}</td><td className="p-2 text-right">{euro(item.residualAmount)}</td><td className="p-2">{item.status}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-sm sm:col-span-2">Importierte Bankzahlung<select aria-label="Bankzahlung" className="mt-1 w-full rounded-lg border border-border px-3 py-2" value={selectedBankTransactionId} onChange={(e) => { setSelectedBankTransactionId(e.target.value); allocationEventRef.current = null; }} disabled={!canMutate || !selectedItem}><option value="">Noch nicht gebuchte Zahlung auswählen</option>{eligibleBankTransactions.map((transaction) => <option key={transaction.id} value={transaction.id}>{transaction.date} · {transaction.counterparty || 'Unbekannt'} · {transaction.purpose || 'Ohne Verwendungszweck'} · {euro(Math.abs(transaction.amount))}</option>)}</select></label>
            {selectedBankTransaction ? <p className="text-sm text-muted sm:col-span-2">Bankkonto {selectedBankTransaction.bankAccountNumber} · {selectedBankTransaction.date} · {euro(Math.abs(selectedBankTransaction.amount))}</p> : null}
            <label className="text-sm sm:col-span-2">Begründung<input disabled={!canMutate} className="mt-1 w-full rounded-lg border border-border px-3 py-2" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="z. B. Kontoauszug geprüft" /></label>
          </div>
          <button type="button" className="mt-3 rounded-lg bg-foreground px-4 py-2 text-sm font-semibold text-background disabled:opacity-50" disabled={!canMutate || busy || !selectedItem || !selectedBankTransaction} onClick={allocate}>Zahlung zuordnen</button>
          {lastPayment && lastPayment.residualAmount > 0 ? <div className="mt-4 rounded-lg border border-warning-border bg-warning-bg p-3"><p className="text-sm font-semibold">Restzahlung: {euro(lastPayment.residualAmount)}</p><div className="mt-2 grid gap-2 sm:grid-cols-2"><select disabled={!canMutate} className="rounded-lg border border-border px-3 py-2 text-sm" value={remainingItemId} onChange={(e) => setRemainingItemId(e.target.value)}><option value="">Weiteren offenen Posten wählen</option>{items.filter((item) => item.id !== selectedItemId && item.partyType === lastPayment.partyType).map((item) => <option key={item.id} value={item.id}>{item.documentNumber} ({euro(item.residualAmount)})</option>)}</select><input disabled={!canMutate} type="number" min="0.01" step="0.01" className="rounded-lg border border-border px-3 py-2 text-sm" value={remainingAmount} onChange={(e) => setRemainingAmount(e.target.value)} placeholder={String(lastPayment.residualAmount)} /></div><button type="button" className="mt-2 rounded-lg border border-muted px-3 py-2 text-sm font-semibold disabled:opacity-50" disabled={!canMutate || busy} onClick={allocateRemaining}>Restbetrag zuordnen</button></div> : null}
        </section>

        <section className="rounded-xl border border-border p-4" aria-labelledby="incoming-heading">
          <h3 id="incoming-heading" className="mb-3 text-base font-bold">Eingangsrechnungen</h3>
          <fieldset disabled={!canMutate} className="contents">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">Rechnungsnummer<input className="mt-1 w-full rounded-lg border border-border px-3 py-2" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} /></label>
            <label className="text-sm">Kreditor<select className="mt-1 w-full rounded-lg border border-border px-3 py-2" value={vendorId} onChange={(e) => setVendorId(e.target.value)}><option value="">Neuen Kreditor anlegen</option>{vendors.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}</select></label>
            {!vendorId ? <label className="text-sm">Kreditorname<input className="mt-1 w-full rounded-lg border border-border px-3 py-2" value={vendorName} onChange={(e) => setVendorName(e.target.value)} /></label> : null}
            <label className="text-sm">Rechnungsdatum<input type="date" className="mt-1 w-full rounded-lg border border-border px-3 py-2" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} /></label>
            <label className="text-sm">Fällig am<input type="date" className="mt-1 w-full rounded-lg border border-border px-3 py-2" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></label>
            <label className="text-sm">Position<input className="mt-1 w-full rounded-lg border border-border px-3 py-2" value={lineDescription} onChange={(e) => setLineDescription(e.target.value)} /></label>
            <label className="text-sm">Netto<input type="number" min="0.01" step="0.01" className="mt-1 w-full rounded-lg border border-border px-3 py-2" value={netAmount} onChange={(e) => setNetAmount(e.target.value)} /></label>
            <label className="text-sm">Steuersatz<input type="number" min="0" step="1" className="mt-1 w-full rounded-lg border border-border px-3 py-2" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} /></label>
            <label className="text-sm sm:col-span-2">Begründung<input className="mt-1 w-full rounded-lg border border-border px-3 py-2" value={invoiceReason} onChange={(e) => setInvoiceReason(e.target.value)} placeholder="z. B. Eingangsbeleg geprüft" /></label>
          </div>
          </fieldset>
          <p className="mt-2 text-sm text-muted">Brutto: {euro(Number.isFinite(grossAmount) ? grossAmount : 0)}</p>
          <div className="mt-3 flex flex-wrap gap-2"><button type="button" className="rounded-lg bg-foreground px-4 py-2 text-sm font-semibold text-background disabled:opacity-50" disabled={!canMutate || busy} onClick={saveInvoice}>Entwurf speichern</button><select className="rounded-lg border border-border px-3 py-2 text-sm" value={selectedInvoiceId} onChange={(e) => { setSelectedInvoiceId(e.target.value); setPreview(null); }}><option value="">Gespeicherten Beleg wählen</option>{invoices.map((invoice) => <option key={invoice.id} value={invoice.id}>{invoice.number} · {invoice.status} · {invoice.accountingStatus}</option>)}</select><button type="button" className="rounded-lg border border-muted px-3 py-2 text-sm font-semibold disabled:opacity-50" disabled={busy || !selectedInvoice} onClick={previewInvoice}>Vorschau</button><button type="button" className="rounded-lg border border-muted px-3 py-2 text-sm font-semibold disabled:opacity-50" disabled={!canMutate || busy || !selectedInvoice || selectedInvoice.status !== 'draft'} onClick={finalizeInvoice}>Für Buchung freigeben</button><button type="button" className="rounded-lg border border-muted px-3 py-2 text-sm font-semibold disabled:opacity-50" disabled={!canMutate || busy || !selectedInvoice || selectedInvoice.status === 'draft'} onClick={postInvoice}>Buchen</button></div>
          <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={softLockOverride} disabled={!canMutate} onChange={(e) => setSoftLockOverride(e.target.checked)} /> Soft-Lock übersteuern</label>
          {softLockOverride ? <label className="mt-2 block text-sm">Override-Begründung<input disabled={!canMutate} className="mt-1 w-full rounded-lg border border-border px-3 py-2" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} /></label> : null}
          {preview ? <div className="mt-3 rounded-lg bg-surface-muted p-3 text-sm" role="status" aria-live="polite"><strong>Vorschau: {preview.status === 'ready' ? 'bereit' : 'nicht bereit'}</strong>{preview.issues.map((issue) => <p key={issue.code} className="mt-1 text-error">{issue.message}</p>)}</div> : null}
        </section>
      </div>
    </div>
  );
}
