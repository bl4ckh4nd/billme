import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Checkbox, Input, Modal, Select } from '@billme/ui';
import type { LiteCashEntry, LiteReceipt } from '@billme/server-core';
import type { IpcArgs } from '@billme/desktop-contracts/contract';
import { localIsoDate } from '@billme/desktop-utils';
import { ipc } from '../../runtime-api';

const money = (value: number) => (value / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const parseCents = (value: string) => Math.round(Number(value.trim().replace(',', '.')) * 100);
const blankReceipt = (): LiteReceipt => ({ id: crypto.randomUUID(), number: '', counterparty: '', documentDate: localIsoDate(), receivedDate: localIsoDate(), serviceDate: localIsoDate(), grossAmountCents: 0, taxMode: 'domestic', deductiblePercent: 100, reviewed: false, taxBreakdown: [{ rate: 19, netAmountCents: 0, vatAmountCents: 0 }], updatedAt: '', fileCount: 0 });

export const LiteCashPanel: React.FC = () => {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => ipc.settings.get() });
  const entries = useQuery({ queryKey: ['cash', 'entries'], queryFn: () => ipc.cash.listEntries() });
  const receipts = useQuery({ queryKey: ['cash', 'receipts'], queryFn: () => ipc.cash.listReceipts() });
  const transactions = useQuery({ queryKey: ['transactions', 'manual-matching'], queryFn: () => ipc.transactions.list({}) });
  const [open, setOpen] = React.useState(false);
  const [receiptOnly, setReceiptOnly] = React.useState(false);
  const [editing, setEditing] = React.useState<LiteCashEntry>();
  const [form, setForm] = React.useState({ id: '', cashDate: '', amount: '', flowType: 'expense' as 'income' | 'expense', refund: false, counterparty: '', purpose: '', receiptId: '' });
  const [receipt, setReceipt] = React.useState<LiteReceipt>();
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState('');
  const [uploading, setUploading] = React.useState(false);
  const [bankId, setBankId] = React.useState('');
  const [matching, setMatching] = React.useState<LiteCashEntry>();
  const [manageReceiptId, setManageReceiptId] = React.useState('');
  const files = useQuery({ queryKey: ['cash', 'files', manageReceiptId], queryFn: () => ipc.cash.listFiles({ receiptId: manageReceiptId }), enabled: !!manageReceiptId });
  const refresh = async () => { await Promise.all(['cash', 'eur', 'transactions', 'lite-vat', 'dashboard-flows'].map((key) => queryClient.invalidateQueries({ queryKey: [key] }))); };
  const start = (entry?: LiteCashEntry) => {
    setEditing(entry); setReceipt(undefined); setReceiptOnly(false); setError(''); setReason('');
    setForm({ id: entry?.id ?? crypto.randomUUID(), cashDate: entry?.originalCashDate ?? localIsoDate(), amount: entry ? String(Math.abs(entry.amountCents) / 100) : '', flowType: entry?.flowType ?? 'expense', refund: entry ? (entry.flowType === 'expense' ? entry.amountCents > 0 : entry.amountCents < 0) : false, counterparty: entry?.counterparty ?? '', purpose: entry?.purpose ?? '', receiptId: entry?.receiptId ?? '' }); setOpen(true);
  };
  const persistReceipt = async () => {
    if (!receipt) return form.receiptId || undefined;
    const saved = await ipc.cash.saveReceipt({ receipt, expectedUpdatedAt: receipt.updatedAt || undefined, reason: reason.trim() });
    setReceipt(saved); setManageReceiptId(saved.id); return saved.id;
  };
  const save = useMutation({ mutationFn: async () => {
    if (!reason.trim()) throw new Error('Bitte eine Begründung eingeben.');
    if (receiptOnly) return persistReceipt();
    const amount = parseCents(form.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0 || !reason.trim()) throw new Error('Betrag größer null und eine Begründung sind erforderlich.');
    const receiptId = await persistReceipt();
    return ipc.cash.saveEntry({ entry: { id: form.id, cashDate: form.cashDate, amountCents: amount * (form.flowType === 'expense' ? -1 : 1) * (form.refund ? -1 : 1), currency: 'EUR', flowType: form.flowType, counterparty: form.counterparty, purpose: form.purpose, receiptId }, expectedUpdatedAt: editing?.updatedAt, reason: reason.trim() });
  }, onSuccess: async () => { setOpen(false); setEditing(undefined); setManageReceiptId(''); await refresh(); }, onError: (failure: Error) => setError(failure.message) });
  const action = useMutation({ mutationFn: async (work: () => Promise<unknown>) => work(), onSuccess: refresh, onError: (failure: Error) => setError(failure.message) });
  const upload = async (file: File) => {
    if (uploading || save.isPending) return;
    setUploading(true);
    setError('');
    try {
      if (!reason.trim()) throw new Error('Bitte vor dem Upload eine Begründung eingeben.');
      if (file.size > 10 * 1024 * 1024) throw new Error('Belegdateien dürfen höchstens 10 MB groß sein.');
      const receiptId = await persistReceipt() ?? manageReceiptId;
      if (!receiptId) throw new Error('Bitte zuerst einen Beleg auswählen oder erfassen.');
      const contentBase64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.onerror = reject; reader.readAsDataURL(file); });
      const mimeType = /\.xml$/i.test(file.name) ? 'application/xml' : file.type;
      if (!['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/xml'].includes(mimeType)) throw new Error('Bitte PDF, JPEG, PNG, WebP oder XML auswählen.');
      await ipc.cash.uploadFile({ receiptId, fileName: file.name, mimeType: mimeType as IpcArgs<'cash:uploadFile'>['mimeType'], contentBase64, reason }); await refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setUploading(false); }
  };
  const download = async (id: string) => {
    const file = await ipc.cash.downloadFile({ id });
    const bytes = Uint8Array.from(atob(file.contentBase64), (character) => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const link = document.createElement('a'); link.href = url; link.download = file.fileName; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const candidates = matching ? (transactions.data ?? []).filter((bank) => !bank.linkedInvoiceId && bank.status === 'booked' && Math.round(bank.amount * 100) === matching.amountCents && !(entries.data ?? []).some((entry) => entry.matchedTransactionId === bank.id)) : [];
  return <Card className="mb-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-control text-muted">Barzahlungen und Zahlungen außerhalb des Bankimports mit Beleg erfassen.</p><Button onClick={() => start()}>Manuelle Buchung</Button></div>
    {(entries.isError || receipts.isError) && <p role="alert" className="mt-3 text-control text-error-text">Manuelle Buchungen oder Belege konnten nicht geladen werden.</p>}
    {error && !open && <p role="alert" className="mt-3 text-control text-error-text">{error}</p>}
    <details className="mt-3"><summary className="cursor-pointer text-control">Manuelle Zahlungen und Belege ({entries.data?.length ?? 0})</summary>
      <div className="mt-3 flex flex-col gap-3">{(entries.data ?? []).map((entry) => <div key={entry.id} className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
        <span className="min-w-0 flex-1 text-control">{entry.cashDate} · {entry.counterparty} · {entry.purpose} · {money(entry.amountCents)}</span>
        {entry.matchedTransactionId ? <><Badge tone="success">Mit Bank abgeglichen</Badge><Button variant="secondary" size="sm" disabled={action.isPending} onClick={() => { setError(''); void action.mutateAsync(() => ipc.cash.unmatchEntry({ id: entry.id, reason: 'Manuellen Bankabgleich rückgängig gemacht' })).catch(() => undefined); }}>Abgleich aufheben</Button></> : <><Button variant="secondary" size="sm" onClick={() => start(entry)}>Bearbeiten</Button><Button variant="secondary" size="sm" onClick={() => { setMatching(entry); setBankId(''); setError(''); }}>Mit Bank abgleichen</Button><Button variant="danger" size="sm" onClick={() => { setEditing(entry); setReason(''); setError(''); }}>Rückgängig</Button></>}
        {entry.receiptId && <Button variant="secondary" size="sm" onClick={() => { setManageReceiptId(entry.receiptId!); setReceipt(undefined); setReason(''); }}>Beleg</Button>}
      </div>)}</div>
    </details>
    <Modal open={open} onClose={() => { if (!save.isPending && !uploading) { setOpen(false); setEditing(undefined); setManageReceiptId(''); } }} titleId="manual-cash-title" className="max-w-3xl">
      <div className="p-5"><h2 id="manual-cash-title" className="text-section">{receiptOnly ? 'Beleg bearbeiten' : editing ? 'Manuelle Buchung bearbeiten' : 'Manuelle Buchung'}</h2>
        {!receiptOnly && <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Select label="Art" value={form.flowType} onChange={(e) => setForm({ ...form, flowType: e.target.value as 'income' | 'expense' })}><option value="expense">Ausgabe</option><option value="income">Einnahme</option></Select>
          <Input label="Zahlungsdatum" type="date" value={form.cashDate} onChange={(e) => setForm({ ...form, cashDate: e.target.value })} />
          <Input label="Betrag in EUR" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          <Input label="Empfänger oder Kunde" value={form.counterparty} onChange={(e) => setForm({ ...form, counterparty: e.target.value })} />
          <Input label="Verwendungszweck" value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} />
          <Checkbox label="Rückzahlung" checked={form.refund} onChange={(e) => setForm({ ...form, refund: e.target.checked })} />
          <Select label="Vorhandener Beleg" value={form.receiptId} disabled={!!receipt} onChange={(e) => setForm({ ...form, receiptId: e.target.value })}><option value="">Noch kein Beleg</option>{(receipts.data ?? []).map((item) => <option key={item.id} value={item.id}>{item.counterparty} · {item.number} · {money(item.grossAmountCents)}</option>)}</Select>
          <Button variant="secondary" onClick={() => { const next = blankReceipt(); if (form.flowType === 'income' && settings.data?.legal.smallBusinessRule) { next.taxMode = 'small_business'; next.deductiblePercent = 0; next.taxBreakdown = [{ rate: 0, netAmountCents: 0, vatAmountCents: 0 }]; } setReceipt(next); }}>Neuen Beleg erfassen</Button>
        </div>}
        {receipt && <div className="mt-4 border-t border-border pt-4"><h3 className="text-control font-semibold">Beleg und Steuerdaten</h3><div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Input label="Belegnummer" value={receipt.number} onChange={(e) => setReceipt({ ...receipt, number: e.target.value })} />
          <Input label="Belegaussteller" value={receipt.counterparty} onChange={(e) => setReceipt({ ...receipt, counterparty: e.target.value })} />
          <Input label="Belegdatum" type="date" value={receipt.documentDate} onChange={(e) => setReceipt({ ...receipt, documentDate: e.target.value })} />
          <Input label="Beleg erhalten am" type="date" value={receipt.receivedDate ?? ''} onChange={(e) => setReceipt({ ...receipt, receivedDate: e.target.value || undefined })} />
          <Input label="Leistung abgeschlossen am" type="date" value={receipt.serviceDate ?? ''} onChange={(e) => setReceipt({ ...receipt, serviceDate: e.target.value || undefined })} />
          <Input label="Gesamtbetrag des Belegs in EUR" type="number" step="0.01" value={receipt.grossAmountCents / 100} onChange={(e) => setReceipt({ ...receipt, grossAmountCents: parseCents(e.target.value) })} />
          <Select label="Steuerart des Belegs" value={receipt.taxMode} onChange={(e) => setReceipt({ ...receipt, taxMode: e.target.value as LiteReceipt['taxMode'] })}><option value="domestic">Inländische Umsatzsteuer</option><option value="exempt">Ohne Umsatzsteuer</option><option value="small_business">Kleinunternehmer-Umsatz (§ 19)</option><option value="reverse_charge">Andere Leistung (§ 13b Abs. 2, ohne Grundstückskauf)</option><option value="eu_service">Dienstleistung aus der EU (§ 13b)</option><option value="intra_eu_acquisition">Innergemeinschaftlicher Erwerb</option><option value="import">Einfuhrumsatzsteuer</option></Select>
          {receipt.taxMode === 'import' && <Input label="Einfuhrumsatzsteuer entstanden am (Zollbeleg)" type="date" value={receipt.importTaxDate ?? ''} onChange={(e) => setReceipt({ ...receipt, importTaxDate: e.target.value || undefined })} />}
          {receipt.grossAmountCents < 0 && <><Select label="Originalbeleg der Korrektur" value={receipt.correctionOfReceiptId ?? ''} onChange={(e) => setReceipt({ ...receipt, correctionOfReceiptId: e.target.value || undefined })}><option value="">Original auswählen</option>{(receipts.data ?? []).filter((item) => item.id !== receipt.id && item.grossAmountCents > 0).map((item) => <option key={item.id} value={item.id}>{item.number} · {item.counterparty}</option>)}</Select><Input label="Entgelt geändert am" type="date" value={receipt.adjustmentDate ?? ''} onChange={(e) => setReceipt({ ...receipt, adjustmentDate: e.target.value || undefined })} /><Input label="Korrekturgrund" value={receipt.correctionReason ?? ''} onChange={(e) => setReceipt({ ...receipt, correctionReason: e.target.value || undefined })} /></>}
          <Input label="Vorsteuerberechtigter Anteil in Prozent" type="number" min="0" max="100" value={receipt.deductiblePercent} onChange={(e) => setReceipt({ ...receipt, deductiblePercent: Number(e.target.value) })} />
        </div>{receipt.taxBreakdown.map((line, index) => <div key={index} className="mt-3 grid gap-3 sm:grid-cols-3">
          <Select label={`Steuersatz ${index + 1}`} value={line.rate} onChange={(e) => { const rate = Number(e.target.value) as 0 | 7 | 19; setReceipt({ ...receipt, taxBreakdown: receipt.taxBreakdown.map((item, i) => i === index ? { ...item, rate, vatAmountCents: Math.round(item.netAmountCents * rate / 100) } : item) }); }}><option value="19">19 %</option><option value="7">7 %</option><option value="0">0 %</option></Select>
          <Input label={`Netto ${index + 1} in EUR`} type="number" step="0.01" value={line.netAmountCents / 100} onChange={(e) => { const netAmountCents = parseCents(e.target.value); setReceipt({ ...receipt, taxBreakdown: receipt.taxBreakdown.map((item, i) => i === index ? { ...item, netAmountCents, vatAmountCents: Math.round(netAmountCents * item.rate / 100) } : item) }); }} />
          <Input label={`Steuer ${index + 1} in EUR`} type="number" step="0.01" value={line.vatAmountCents / 100} onChange={(e) => setReceipt({ ...receipt, taxBreakdown: receipt.taxBreakdown.map((item, i) => i === index ? { ...item, vatAmountCents: parseCents(e.target.value) } : item) })} />
        </div>)}<div className="mt-3 flex flex-wrap gap-3"><Button variant="secondary" onClick={() => setReceipt({ ...receipt, taxBreakdown: [...receipt.taxBreakdown, { rate: 7, netAmountCents: 0, vatAmountCents: 0 }] })}>Weiterer Steuersatz</Button><Checkbox label="Anzahlung vor Leistung" checked={receipt.advancePayment ?? false} onChange={(e) => setReceipt({ ...receipt, advancePayment: e.target.checked })} /><Checkbox label="Regelmäßig wiederkehrend (z. B. Miete; 10-Tage-Regel)" checked={receipt.recurring ?? false} onChange={(e) => setReceipt({ ...receipt, recurring: e.target.checked || undefined })} /><Checkbox label="Steuerdaten geprüft" checked={receipt.reviewed} onChange={(e) => setReceipt({ ...receipt, reviewed: e.target.checked })} /></div>
        <p className="mt-3 text-caption text-muted">Der Gesamtbetrag gehört zum Beleg. Mehrere Teilzahlungen dürfen denselben Beleg verwenden.</p></div>}
        <Input className="mt-4" label="Begründung" value={reason} onChange={(e) => setReason(e.target.value)} />
        {(receipt || form.receiptId) && <Input className="mt-3" label="Originalbeleg hinzufügen (PDF, Bild oder XML)" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.xml" onChange={(e) => { const file = e.target.files?.[0]; if (file) void upload(file); e.target.value = ''; }} />}
        {error && <p role="alert" className="mt-3 text-control text-error-text">{error}</p>}
        <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" disabled={save.isPending || uploading} onClick={() => { setOpen(false); setEditing(undefined); setManageReceiptId(''); }}>Abbrechen</Button><Button loading={save.isPending} disabled={uploading} onClick={() => save.mutate()}>{receiptOnly ? 'Beleg speichern' : 'Buchung speichern'}</Button></div>
      </div>
    </Modal>
    <Modal open={!!matching} onClose={() => setMatching(undefined)} titleId="cash-match-title"><div className="p-5"><h2 id="cash-match-title" className="text-section">Mit Bank abgleichen</h2><p className="my-3 text-control">Es werden nur freie Bankzahlungen mit exakt demselben Betrag und derselben Richtung angeboten. Das Bankdatum ersetzt das Zahlungsdatum {matching?.cashDate} in der EÜR.</p><Select label="Bankzahlung" value={bankId} onChange={(e) => setBankId(e.target.value)}><option value="">Bitte auswählen</option>{candidates.map((bank) => <option key={bank.id} value={bank.id}>{bank.date} · {bank.counterparty} · {money(Math.round(bank.amount * 100))}</option>)}</Select><p className="mt-3 text-control">Neues Zahlungsdatum: {candidates.find((bank) => bank.id === bankId)?.date ?? '–'}</p>{!candidates.length && <p className="mt-3 text-control">Keine passende freie Bankzahlung vorhanden.</p>}<Button className="mt-4" disabled={!bankId || action.isPending} onClick={() => { if (matching) void action.mutateAsync(() => ipc.cash.matchEntry({ id: matching.id, transactionId: bankId, expectedCashDate: matching.originalCashDate, reason: `Exakter Bankabgleich bestätigt: ${matching.cashDate} → ${candidates.find((bank) => bank.id === bankId)?.date}` })).then(() => setMatching(undefined)).catch(() => undefined); }}>Datum und Abgleich bestätigen</Button>{error && <p role="alert" className="mt-3 text-error-text">{error}</p>}</div></Modal>
    <Modal open={!!editing && !open} onClose={() => setEditing(undefined)} titleId="cash-reverse-title"><div className="p-5"><h2 id="cash-reverse-title" className="text-section">Manuelle Buchung rückgängig machen</h2><Input label="Begründung" value={reason} onChange={(e) => setReason(e.target.value)} /><Button variant="danger" className="mt-4" disabled={!reason.trim() || action.isPending} onClick={() => { if (editing) void action.mutateAsync(() => ipc.cash.deleteEntry({ id: editing.id, expectedUpdatedAt: editing.updatedAt, reason })).then(() => setEditing(undefined)).catch(() => undefined); }}>Rückgängig machen</Button>{error && <p role="alert" className="mt-3 text-error-text">{error}</p>}</div></Modal>
    <Modal open={!!manageReceiptId && !open} onClose={() => setManageReceiptId('')} titleId="cash-files-title"><div className="p-5"><h2 id="cash-files-title" className="text-section">Originalbelege</h2>{(files.data ?? []).map((file) => <Button key={file.id} variant="secondary" className="mt-3" onClick={() => void download(file.id).catch((failure: Error) => setError(failure.message))}>{file.fileName} herunterladen</Button>)}<Input className="mt-4" label="Begründung" value={reason} onChange={(e) => setReason(e.target.value)} /><Input className="mt-3" label="Originalbeleg hinzufügen" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.xml" onChange={(e) => { const file = e.target.files?.[0]; if (file) void upload(file); e.target.value = ''; }} /><Button variant="secondary" className="mt-3" onClick={() => { const item = receipts.data?.find((row) => row.id === manageReceiptId); if (item) { start(); setReceiptOnly(true); setReceipt(item); } }}>Steuerdaten bearbeiten</Button>{error && <p role="alert" className="mt-3 text-error-text">{error}</p>}</div></Modal>
  </Card>;
};
