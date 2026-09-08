import { useCallback, useEffect, useRef, useState } from 'react';
import { INCOMING_INVOICE_DOCUMENT_MAX_BYTES } from '@billme/accounting-shared';
import type {
  AccountingPostingPreview,
  IncomingInvoiceDocumentEntity,
  IncomingInvoiceEntity,
  OpenItemEntity,
  OpenItemPaymentEntity,
  VendorEntity,
} from '@billme/accounting-shared';
import type { OposBankTransaction, ProAccountingDataAdapter } from '../services/mockBookingStore';
import { permissionContextForRole } from '../mocks/users';
import type { UserRole } from '../types';
import { Button, ValidationSummary } from '@billme/ui';

const euro = (value: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
const today = () => new Date().toISOString().slice(0, 10);
const eventId = () => `allocation-${crypto.randomUUID()}`;
const invoiceId = () => `incoming-${crypto.randomUUID()}`;
const supportedDocumentMimeTypes = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const openItemStatusLabels: Record<OpenItemEntity['status'], string> = {
  open: 'Offen',
  partially_paid: 'Teilweise bezahlt',
  paid: 'Bezahlt',
  overpaid: 'Überzahlt',
  unresolved: 'Ungeklärt',
};
const incomingInvoiceStatusLabels: Record<IncomingInvoiceEntity['status'], string> = {
  draft: 'Entwurf',
  open: 'Offen',
  paid: 'Bezahlt',
  cancelled: 'Storniert',
  unresolved: 'Ungeklärt',
};
const incomingInvoiceAccountingStatusLabels: Record<IncomingInvoiceEntity['accountingStatus'], string> = {
  unposted: 'Nicht gebucht',
  posted: 'Gebucht',
  unresolved: 'Ungeklärt',
  reversed: 'Storniert',
};
const incomingInvoiceDocumentReviewLabels = {
  pending: 'Ausstehend',
  accepted: 'Geprüft',
  rejected: 'Abgelehnt',
} as const;
const incomingInvoiceDocumentErrorLabels: Record<string, string> = {
  INCOMING_INVOICE_DOCUMENT_DUPLICATE: 'Diese Datei ist im Mandanten bereits als Originalbeleg archiviert.',
  INCOMING_INVOICE_DOCUMENT_CONTENT_MISMATCH: 'Der Dateiinhalt passt nicht zum angegebenen Dateityp.',
  INCOMING_INVOICE_DOCUMENT_HASH_MISMATCH: 'Der Originalbeleg ist beschädigt und kann nicht geladen werden.',
  INCOMING_INVOICE_DOCUMENT_CONTENT_UNAVAILABLE: 'Der Inhalt des Originalbelegs ist nicht verfügbar.',
  INCOMING_INVOICE_DOCUMENT_INVALID_BASE64: 'Die Datei konnte nicht gelesen werden.',
  INCOMING_INVOICE_DOCUMENT_FILENAME_INVALID: 'Der Dateiname ist ungültig.',
  INCOMING_INVOICE_DOCUMENT_MIME_UNSUPPORTED: 'Dieser Dateityp wird nicht unterstützt.',
  INCOMING_INVOICE_DOCUMENT_SIZE_INVALID: 'Die Originaldatei muss zwischen 1 Byte und 10 MiB groß sein.',
  INCOMING_INVOICE_DOCUMENT_NOT_FOUND: 'Der Originalbeleg wurde nicht gefunden.',
};
const formatOposError = (cause: unknown, fallback: string): string => {
  const message = cause instanceof Error ? cause.message : '';
  const code = message.split(':', 1)[0]?.trim();
  return (code && incomingInvoiceDocumentErrorLabels[code]) || message || fallback;
};
const roundCents = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

type IncomingInvoiceDraftLine = {
  id: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  accountNumber: string;
  assetAccountNumber: string;
};

type CalculatedIncomingInvoiceLine = Omit<IncomingInvoiceDraftLine, 'quantity' | 'unitPrice' | 'taxRate'> & {
  quantity: number;
  unitPrice: number;
  netAmount: number;
  taxRate: number;
  taxAmount: number;
  grossAmount: number;
};

type FieldErrors = Record<string, string>;

const paymentFieldIds = {
  openItem: 'opos-payment-open-item',
  bankTransaction: 'opos-payment-bank-transaction',
  reason: 'opos-payment-reason',
  remainingItem: 'opos-payment-remaining-item',
  remainingAmount: 'opos-payment-remaining-amount',
} as const;

const invoiceFieldIds = {
  number: 'opos-invoice-number',
  vendor: 'opos-invoice-vendor',
  vendorName: 'opos-invoice-vendor-name',
  reason: 'opos-invoice-reason',
} as const;

const invoiceLineFieldId = (lineId: string, field: 'description' | 'quantity' | 'unitPrice' | 'taxRate') => `opos-invoice-line-${lineId}-${field}`;

const errorClassName = (hasError: boolean): string => hasError ? 'border-error focus:border-error focus:ring-error' : 'border-border';

const firstError = (errors: FieldErrors): string | null => Object.values(errors)[0] ?? null;

const toValidationErrors = (errors: FieldErrors) => Object.entries(errors).map(([id, message]) => ({ id, message }));

const createIncomingInvoiceDraftLine = (): IncomingInvoiceDraftLine => ({
  id: `incoming-draft-line-${crypto.randomUUID()}`,
  description: '',
  quantity: '1',
  unitPrice: '',
  taxRate: '19',
  accountNumber: '',
  assetAccountNumber: '',
});

const calculateIncomingInvoiceLine = (line: IncomingInvoiceDraftLine): CalculatedIncomingInvoiceLine | null => {
  const quantity = Number(line.quantity);
  const unitPrice = Number(line.unitPrice);
  const taxRate = Number(line.taxRate);
  if (!line.description.trim() || !line.quantity.trim() || !line.unitPrice.trim() || !line.taxRate.trim()
    || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice <= 0
    || !Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) return null;
  const netAmount = roundCents(quantity * unitPrice);
  const taxAmount = roundCents(netAmount * taxRate / 100);
  return {
    ...line,
    quantity,
    unitPrice,
    netAmount,
    taxRate,
    taxAmount,
    grossAmount: roundCents(netAmount + taxAmount),
  };
};

const lineValidationMessage = (line: IncomingInvoiceDraftLine, index: number): string | null => {
  if (!line.description.trim()) return `Position ${index + 1}: Beschreibung ist erforderlich.`;
  const quantity = Number(line.quantity);
  if (!line.quantity.trim() || !Number.isFinite(quantity) || quantity <= 0) return `Position ${index + 1}: Menge muss größer als 0 sein.`;
  const unitPrice = Number(line.unitPrice);
  if (!line.unitPrice.trim() || !Number.isFinite(unitPrice) || unitPrice <= 0) return `Position ${index + 1}: Einzelpreis muss größer als 0 sein.`;
  const taxRate = Number(line.taxRate);
  if (!line.taxRate.trim() || !Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) return `Position ${index + 1}: Steuersatz muss zwischen 0 und 100 liegen.`;
  return null;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  return btoa(binary);
};
const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

type OposViewProps = {
  dataAdapter?: ProAccountingDataAdapter;
  role?: UserRole;
};

export default function OposView({ dataAdapter, role = 'admin' }: OposViewProps) {
  const [items, setItems] = useState<OpenItemEntity[]>([]);
  const [bankTransactions, setBankTransactions] = useState<OposBankTransaction[]>([]);
  const [vendors, setVendors] = useState<VendorEntity[]>([]);
  const [invoices, setInvoices] = useState<IncomingInvoiceEntity[]>([]);
  const [documents, setDocuments] = useState<IncomingInvoiceDocumentEntity[]>([]);
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
  const [invoiceLines, setInvoiceLines] = useState<IncomingInvoiceDraftLine[]>(() => [createIncomingInvoiceDraftLine()]);
  const [invoiceReason, setInvoiceReason] = useState('');
  const [selectedInvoiceId, setSelectedInvoiceId] = useState('');
  const [preview, setPreview] = useState<AccountingPostingPreview | null>(null);
  const [softLockOverride, setSoftLockOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const selectedFileInputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(Boolean(dataAdapter));
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string; retry?: boolean } | null>(null);
  const [paymentErrors, setPaymentErrors] = useState<FieldErrors>({});
  const [invoiceErrors, setInvoiceErrors] = useState<FieldErrors>({});
  const runInFlightRef = useRef(false);
  const allocationEventRef = useRef<string | null>(null);
  const remainingEventRef = useRef<string | null>(null);
  const canMutate = permissionContextForRole(role).canMutate;
  const selectedInvoice = invoices.find((invoice) => invoice.id === selectedInvoiceId);

  const focusValidationField = (fieldId: string) => {
    const field = document.getElementById(fieldId);
    if (!(field instanceof HTMLElement)) return;
    field.scrollIntoView?.({ block: 'center' });
    field.focus({ preventScroll: true });
  };

  const clearPaymentError = (field: string) => {
    setPaymentErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  const clearInvoiceError = (field: string) => {
    setInvoiceErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  const refresh = useCallback(async () => {
    setLoading(true);
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
    setFeedback(null);
    void refresh().catch((cause) => setFeedback({ kind: 'error', retry: true, text: formatOposError(cause, 'OPOS-Daten konnten nicht geladen werden.') }));
  }, [refresh]);

  useEffect(() => {
    if (!selectedInvoiceId || !dataAdapter?.listIncomingInvoiceDocuments) {
      setDocuments([]);
      return;
    }
    let active = true;
    void dataAdapter.listIncomingInvoiceDocuments(selectedInvoiceId)
      .then((nextDocuments) => { if (active) setDocuments(nextDocuments); })
      .catch((cause) => { if (active) setFeedback({ kind: 'error', retry: true, text: formatOposError(cause, 'Eingangsbelege konnten nicht geladen werden.') }); });
    return () => { active = false; };
  }, [dataAdapter, selectedInvoiceId, selectedInvoice?.accountingStatus]);

  const run = async (action: () => Promise<void>) => {
    if (runInFlightRef.current) return;
    runInFlightRef.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      await action();
    } catch (cause) {
      setFeedback({ kind: 'error', text: formatOposError(cause, 'Aktion konnte nicht gespeichert werden.') });
    } finally {
      runInFlightRef.current = false;
      setBusy(false);
    }
  };

  const selectedItem = items.find((item) => item.id === selectedItemId);
  const calculatedInvoiceLines = invoiceLines.map(calculateIncomingInvoiceLine);
  const invoiceTotals = calculatedInvoiceLines.reduce((totals, line) => line ? {
    netAmount: roundCents(totals.netAmount + line.netAmount),
    taxAmount: roundCents(totals.taxAmount + line.taxAmount),
    grossAmount: roundCents(totals.grossAmount + line.grossAmount),
  } : totals, { netAmount: 0, taxAmount: 0, grossAmount: 0 });
  const invoiceTaxBreakdown = calculatedInvoiceLines.reduce((breakdown, line) => {
    if (!line) return breakdown;
    const current = breakdown.get(line.taxRate) ?? { netAmount: 0, taxAmount: 0, grossAmount: 0 };
    breakdown.set(line.taxRate, {
      netAmount: roundCents(current.netAmount + line.netAmount),
      taxAmount: roundCents(current.taxAmount + line.taxAmount),
      grossAmount: roundCents(current.grossAmount + line.grossAmount),
    });
    return breakdown;
  }, new Map<number, { netAmount: number; taxAmount: number; grossAmount: number }>());

  const selectedBankTransaction = bankTransactions.find((transaction) => transaction.id === selectedBankTransactionId);
  const eligibleBankTransactions = selectedItem
    ? bankTransactions.filter((transaction) => transaction.status === 'pending' && !transaction.linkedInvoiceId && transaction.type === (selectedItem.partyType === 'debtor' ? 'income' : 'expense'))
    : [];

  const paymentOpenItemTargetId = selectedItemId
    ? `opos-open-item-${selectedItemId}`
    : items[0]
      ? `opos-open-item-${items[0].id}`
      : paymentFieldIds.bankTransaction;
  const openItemError = paymentErrors[paymentOpenItemTargetId];
  const openItemErrorId = `${paymentOpenItemTargetId}-error`;

  const validatePayment = (): FieldErrors => {
    const errors: FieldErrors = {};
    if (!selectedItem) errors[paymentOpenItemTargetId] = 'Bitte einen offenen Posten auswählen.';
    if (!selectedBankTransaction || !eligibleBankTransactions.some((transaction) => transaction.id === selectedBankTransaction.id)) {
      errors[paymentFieldIds.bankTransaction] = 'Bitte eine importierte, noch nicht gebuchte Bankzahlung auswählen.';
    }
    if (!reason.trim()) errors[paymentFieldIds.reason] = 'Begründung ist erforderlich.';
    return errors;
  };

  const validateInvoice = (): FieldErrors => {
    const errors: FieldErrors = {};
    if (!invoiceNumber.trim()) errors[invoiceFieldIds.number] = 'Rechnungsnummer ist erforderlich.';
    if (!vendorId && !vendorName.trim()) errors[invoiceFieldIds.vendorName] = 'Kreditorname ist erforderlich, wenn kein Kreditor ausgewählt ist.';
    if (!invoiceReason.trim()) errors[invoiceFieldIds.reason] = 'Begründung ist erforderlich.';
    for (const line of invoiceLines) {
      if (!line.description.trim()) {
        errors[invoiceLineFieldId(line.id, 'description')] = 'Beschreibung ist erforderlich.';
      } else {
        const quantity = Number(line.quantity);
        if (!line.quantity.trim() || !Number.isFinite(quantity) || quantity <= 0) errors[invoiceLineFieldId(line.id, 'quantity')] = 'Menge muss größer als 0 sein.';
        const unitPrice = Number(line.unitPrice);
        if (!line.unitPrice.trim() || !Number.isFinite(unitPrice) || unitPrice <= 0) errors[invoiceLineFieldId(line.id, 'unitPrice')] = 'Einzelpreis muss größer als 0 sein.';
        const taxRate = Number(line.taxRate);
        if (!line.taxRate.trim() || !Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) errors[invoiceLineFieldId(line.id, 'taxRate')] = 'Steuersatz muss zwischen 0 und 100 liegen.';
      }
    }
    return errors;
  };

  const selectOpenItem = (id: string) => {
    setSelectedItemId(id);
    setSelectedBankTransactionId('');
    setPaymentErrors({});
    allocationEventRef.current = null;
  };

  const allocate = () => {
    if (!canMutate || !dataAdapter?.allocateOpenItemPayment) return;
    const validationErrors = validatePayment();
    if (Object.keys(validationErrors).length > 0) {
      setPaymentErrors(validationErrors);
      setFeedback({ kind: 'error', text: 'Bitte eine importierte, noch nicht gebuchte Bankzahlung und eine Begründung auswählen.' });
      focusValidationField(Object.keys(validationErrors)[0]!);
      return;
    }
    if (!selectedItem || !selectedBankTransaction) return;
    const amount = Math.abs(selectedBankTransaction.amount);
    if (!Number.isFinite(amount) || amount <= 0 || !selectedBankTransaction.bankAccountNumber) {
      const validationErrors = { [paymentFieldIds.bankTransaction]: 'Die ausgewählte Bankzahlung enthält keine gültige Buchungsgrundlage.' };
      setPaymentErrors(validationErrors);
      setFeedback({ kind: 'error', text: 'Die ausgewählte Bankzahlung enthält keine gültige Buchungsgrundlage.' });
      focusValidationField(paymentFieldIds.bankTransaction);
      return;
    }
    setPaymentErrors({});
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
      setFeedback({ kind: 'success', text: payment.residualAmount > 0 ? `Zahlung gespeichert. Restbetrag ${euro(payment.residualAmount)}.` : 'Zahlung vollständig zugeordnet.' });
      await refresh();
    });
  };

  const allocateRemaining = () => {
    if (!canMutate || !lastPayment || !dataAdapter?.allocateRemainingOpenItemPayment) {
      setFeedback({ kind: 'error', text: 'Ziel, Betrag und Begründung sind Pflichtfelder.' });
      return;
    }
    const amount = Number(remainingAmount);
    const validationErrors: FieldErrors = {};
    if (!remainingItemId) validationErrors[paymentFieldIds.remainingItem] = 'Bitte einen offenen Posten als Ziel auswählen.';
    if (!Number.isFinite(amount) || amount <= 0) validationErrors[paymentFieldIds.remainingAmount] = 'Bitte einen gültigen Restbetrag eingeben.';
    if (!reason.trim()) validationErrors[paymentFieldIds.reason] = 'Begründung ist erforderlich.';
    if (Object.keys(validationErrors).length > 0) {
      setPaymentErrors(validationErrors);
      setFeedback({ kind: 'error', text: Object.values(validationErrors)[0]! });
      focusValidationField(Object.keys(validationErrors)[0]!);
      return;
    }
    setPaymentErrors({});
    if (!remainingEventRef.current) remainingEventRef.current = eventId();
    const allocationEventId = remainingEventRef.current;
    void run(async () => {
      const payment = await dataAdapter.allocateRemainingOpenItemPayment!(lastPayment.id, [{ openItemId: remainingItemId, amount }], allocationEventId, reason.trim());
      setLastPayment(payment);
      remainingEventRef.current = null;
      setFeedback({ kind: 'success', text: payment.residualAmount > 0 ? `Restzahlung gespeichert. Verbleibend ${euro(payment.residualAmount)}.` : 'Zahlung vollständig zugeordnet.' });
      await refresh();
    });
  };

  const saveInvoice = () => {
    if (!canMutate || !dataAdapter?.upsertIncomingInvoice) {
      return;
    }
    const validationErrors = validateInvoice();
    if (Object.keys(validationErrors).length > 0) {
      setInvoiceErrors(validationErrors);
      const firstInvalidFieldId = Object.keys(validationErrors)[0]!;
      const firstLineError = invoiceLines.map(lineValidationMessage).find((message): message is string => Boolean(message));
      const feedbackText = !invoiceNumber.trim() || !invoiceReason.trim()
        ? 'Rechnungsnummer, mindestens eine Position und Begründung sind Pflichtfelder.'
        : firstLineError
          ? firstLineError
          : !vendorId && !vendorName.trim()
            ? 'Bitte einen Kreditor auswählen oder anlegen.'
            : 'Mindestens eine gültige Position ist erforderlich. Leere oder fehlerhafte Positionen müssen entfernt oder ausgefüllt werden.';
      setFeedback({ kind: 'error', text: feedbackText });
      focusValidationField(firstInvalidFieldId);
      return;
    }
    if (!vendorId && !dataAdapter.upsertVendor) {
      setFeedback({ kind: 'error', text: 'Bitte einen vorhandenen Kreditor auswählen oder einen Kreditor-Adapter konfigurieren.' });
      return;
    }
    const lineError = invoiceLines.map(lineValidationMessage).find((message): message is string => Boolean(message));
    if (lineError) {
      const firstInvalidFieldId = Object.keys(validateInvoice())[0];
      const validationError = firstInvalidFieldId ? { [firstInvalidFieldId]: lineError } : {};
      setInvoiceErrors(validationError);
      setFeedback({ kind: 'error', text: lineError });
      if (firstInvalidFieldId) focusValidationField(firstInvalidFieldId);
      return;
    }
    setInvoiceErrors({});
    const lines = calculatedInvoiceLines.filter((line): line is CalculatedIncomingInvoiceLine => Boolean(line));
    if (lines.length === 0 || lines.length !== invoiceLines.length) {
      setFeedback({ kind: 'error', text: 'Mindestens eine gültige Position ist erforderlich. Leere oder fehlerhafte Positionen müssen entfernt oder ausgefüllt werden.' });
      return;
    }
    void run(async () => {
      let selectedVendorId = vendorId;
      if (!selectedVendorId) {
        if (!vendorName.trim()) throw new Error('Bitte einen Kreditor auswählen oder anlegen.');
        const vendor = await dataAdapter.upsertVendor!({ id: `vendor-${Date.now()}`, name: vendorName.trim() }, invoiceReason.trim());
        selectedVendorId = vendor.id;
      }
      const id = invoiceId();
      const saved = await dataAdapter.upsertIncomingInvoice!({
        id,
        tenantId: 'default',
        vendorId: selectedVendorId,
        number: invoiceNumber.trim(),
        invoiceDate,
        dueDate,
        netAmount: invoiceTotals.netAmount,
        taxAmount: invoiceTotals.taxAmount,
        grossAmount: invoiceTotals.grossAmount,
        taxRate: lines[0]?.taxRate ?? 0,
        status: 'draft',
        accountingStatus: 'unposted',
        lines: lines.map((line, index) => ({
          id: `${id}-line-${index + 1}`,
          incomingInvoiceId: id,
          position: index,
          description: line.description.trim(),
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          netAmount: line.netAmount,
          taxRate: line.taxRate,
          taxAmount: line.taxAmount,
          grossAmount: line.grossAmount,
          ...(line.accountNumber.trim() ? { accountNumber: line.accountNumber.trim() } : {}),
          ...(line.assetAccountNumber.trim() ? { assetAccountNumber: line.assetAccountNumber.trim() } : {}),
        })),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, invoiceReason.trim());
      setSelectedInvoiceId(saved.id);
      setFeedback({ kind: 'success', text: 'Eingangsrechnung als Entwurf gespeichert.' });
      await refresh();
    });
  };

  const updateInvoiceLine = (lineId: string, field: keyof Omit<IncomingInvoiceDraftLine, 'id'>, value: string) => {
    setInvoiceLines((current) => current.map((line) => line.id === lineId ? { ...line, [field]: value } : line));
  };

  const addInvoiceLine = () => setInvoiceLines((current) => [...current, createIncomingInvoiceDraftLine()]);

  const removeInvoiceLine = (lineId: string) => {
    setInvoiceLines((current) => current.length > 1 ? current.filter((line) => line.id !== lineId) : current);
  };

  const finalizeInvoice = () => {
    if (!canMutate || !selectedInvoice || selectedInvoice.status !== 'draft' || !dataAdapter?.upsertIncomingInvoice || !invoiceReason.trim()) {
      setFeedback({ kind: 'error', text: 'Bitte zuerst einen Entwurf auswählen und eine Begründung angeben.' });
      return;
    }
    void run(async () => {
      const saved = await dataAdapter.upsertIncomingInvoice!({ ...selectedInvoice, status: 'open' }, invoiceReason.trim());
      setSelectedInvoiceId(saved.id);
      setPreview(null);
      setFeedback({ kind: 'success', text: 'Eingangsrechnung zur Buchung freigegeben.' });
      await refresh();
    });
  };

  const previewInvoice = () => {
    if (!selectedInvoice || !dataAdapter?.previewIncomingInvoiceAccounting) return;
    void run(async () => setPreview(await dataAdapter.previewIncomingInvoiceAccounting!(selectedInvoice.id)));
  };

  const postInvoice = () => {
    if (!canMutate || !selectedInvoice || !dataAdapter?.postIncomingInvoiceAccounting || !invoiceReason.trim() || (softLockOverride && !overrideReason.trim())) {
      setFeedback({ kind: 'error', text: softLockOverride ? 'Bitte eine Override-Begründung angeben.' : 'Bitte zuerst einen Entwurf auswählen und eine Begründung angeben.' });
      return;
    }
    void run(async () => {
      const result = await dataAdapter.postIncomingInvoiceAccounting!(selectedInvoice.id, { reason: invoiceReason.trim(), softLockOverride, overrideReason: softLockOverride ? overrideReason.trim() : undefined });
      setPreview(result);
      if (result.status === 'ready') setFeedback({ kind: 'success', text: 'Eingangsrechnung gebucht.' });
      await refresh();
    });
  };

  const clearSelectedFile = () => {
    setSelectedFile(null);
    if (selectedFileInputRef.current) selectedFileInputRef.current.value = '';
  };

  const uploadDocument = () => {
    if (!canMutate || !selectedInvoice || !selectedFile || !dataAdapter?.uploadIncomingInvoiceDocument || !invoiceReason.trim()) {
      setFeedback({ kind: 'error', text: 'Bitte einen gespeicherten Eingangsbeleg, eine Datei und eine Begründung auswählen.' });
      return;
    }
    if (!supportedDocumentMimeTypes.has(selectedFile.type)) {
      clearSelectedFile();
      setFeedback({ kind: 'error', text: 'Nur PDF-, JPEG-, PNG- und WebP-Dateien werden archiviert.' });
      return;
    }
    if (selectedFile.size <= 0 || selectedFile.size > INCOMING_INVOICE_DOCUMENT_MAX_BYTES) {
      clearSelectedFile();
      setFeedback({ kind: 'error', text: 'Originalbelege dürfen höchstens 10 MiB groß sein.' });
      return;
    }
    void run(async () => {
      try {
        const content = new Uint8Array(await selectedFile.arrayBuffer());
        const uploaded = await dataAdapter.uploadIncomingInvoiceDocument!({
          invoiceId: selectedInvoice.id,
          originalFilename: selectedFile.name,
          mimeType: selectedFile.type as 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp',
          data: bytesToBase64(content),
          reason: invoiceReason.trim(),
        });
        setDocuments((current) => [...current, uploaded]);
        setFeedback({ kind: 'success', text: 'Originalbeleg archiviert. Die VLM-Analyse bleibt ein Vorschlag und erzeugt keine Buchung.' });
        await refresh();
      } finally {
        clearSelectedFile();
      }
    });
  };

  const reviewDocument = (document: IncomingInvoiceDocumentEntity, reviewStatus: 'accepted' | 'rejected') => {
    if (!canMutate || !dataAdapter?.reviewIncomingInvoiceDocument || !invoiceReason.trim()) {
      setFeedback({ kind: 'error', text: 'Für die Reviewentscheidung ist eine Begründung erforderlich.' });
      return;
    }
    void run(async () => {
      const reviewed = await dataAdapter.reviewIncomingInvoiceDocument!({ documentId: document.id, reviewStatus, reason: invoiceReason.trim() });
      setDocuments((current) => current.map((entry) => entry.id === reviewed.id ? reviewed : entry));
      setFeedback({ kind: 'success', text: reviewStatus === 'accepted' ? 'Originalbeleg als geprüft markiert.' : 'Originalbeleg zur Prüfung abgelehnt.' });
    });
  };

  const downloadDocument = (document: IncomingInvoiceDocumentEntity) => {
    if (!dataAdapter?.downloadIncomingInvoiceDocument) return;
    void run(async () => {
      const result = await dataAdapter.downloadIncomingInvoiceDocument!(document.id);
      const blob = new Blob([base64ToBytes(result.data)], { type: result.document.mimeType });
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      anchor.href = url;
      anchor.download = result.document.originalFilename;
      anchor.click();
      URL.revokeObjectURL(url);
    });
  };

  const selectedInvoiceTaxBreakdown = selectedInvoice?.lines.reduce((breakdown, line) => {
    const current = breakdown.get(line.taxRate) ?? { netAmount: 0, taxAmount: 0, grossAmount: 0 };
    breakdown.set(line.taxRate, {
      netAmount: roundCents(current.netAmount + line.netAmount),
      taxAmount: roundCents(current.taxAmount + line.taxAmount),
      grossAmount: roundCents(current.grossAmount + line.grossAmount),
    });
    return breakdown;
  }, new Map<number, { netAmount: number; taxAmount: number; grossAmount: number }>()) ?? new Map<number, { netAmount: number; taxAmount: number; grossAmount: number }>();
  const paymentValidationIssues = toValidationErrors(paymentErrors);
  const invoiceValidationIssues = toValidationErrors(invoiceErrors);
  const paymentFirstError = firstError(paymentErrors);
  const remainingFirstError = [paymentFieldIds.remainingItem, paymentFieldIds.remainingAmount, paymentFieldIds.reason]
    .map((field) => paymentErrors[field])
    .find(Boolean) ?? null;
  const invoiceFirstError = firstError(invoiceErrors);

  return (
    <div className="h-full min-w-0 overflow-auto p-5" data-testid="opos-workspace">
      <div className="mb-5">
        <h2 className="text-xl font-black text-foreground">OPOS</h2>
        <p className="text-sm text-muted">Offene Posten, Zahlungszuordnung und Eingangsrechnungen.</p>
      </div>
      {busy ? <div className="mb-3 text-sm text-muted" aria-live="polite" aria-busy="true">Speichere Änderung…</div> : null}
      {loading ? <div className="mb-3 text-sm text-muted" role="status" aria-live="polite" aria-busy="true">OPOS-Daten werden geladen…</div> : null}
      {/* ponytail: validation errors keep the retry action; split load and validation feedback when retry semantics diverge. */}
      {feedback ? feedback.kind === 'error' ? <div data-testid="opos-feedback" className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-error-border bg-error-bg px-3 py-2 text-sm text-error" role="alert" aria-live="assertive"><span>{feedback.text}</span>{feedback.retry ? <Button type="button" size="sm" variant="secondary" onClick={() => { setFeedback(null); void refresh().catch((cause) => setFeedback({ kind: 'error', retry: true, text: formatOposError(cause, 'OPOS-Daten konnten nicht geladen werden.') })); }}>Erneut versuchen</Button> : null}</div> : <div data-testid="opos-feedback" className="mb-3 rounded-lg border border-success-border bg-success-bg px-3 py-2 text-sm text-success" role="status" aria-live="polite">{feedback.text}</div> : null}
      {!canMutate ? <div className="mb-3 rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-muted" role="status">Diese Rolle kann OPOS-Daten nur lesen.</div> : null}
      <div className="grid min-w-0 gap-5 xl:grid-cols-2">
        <section className="min-w-0 rounded-xl border border-border p-4" aria-labelledby="open-items-heading">
          <h3 id="open-items-heading" className="mb-3 text-base font-bold">Offene Posten</h3>
          {!loading && feedback?.kind !== 'error' && items.length === 0 ? <p className="text-sm text-muted">Keine offenen Posten vorhanden.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr className="border-b border-border text-xs text-muted"><th className="p-2">Beleg</th><th className="p-2">Art</th><th className="p-2 text-right">Restbetrag</th><th className="p-2">Status</th></tr></thead>
                <tbody>{items.map((item) => { const itemId = `opos-open-item-${item.id}`; const itemError = paymentErrors[itemId]; return <tr key={item.id} className={`border-b border-border-subtle ${selectedItemId === item.id ? 'bg-surface-muted' : ''}`}><td className="p-2"><button id={itemId} type="button" aria-pressed={selectedItemId === item.id} aria-required="true" aria-invalid={itemError ? 'true' : undefined} aria-describedby={itemError ? `${itemId}-error` : undefined} className={`rounded font-semibold underline-offset-2 hover:underline ${itemError ? 'border border-error text-error' : ''}`} onClick={() => selectOpenItem(item.id)}>{item.documentNumber}</button></td><td className="p-2">{item.partyType === 'debtor' ? 'Debitor' : 'Kreditor'}</td><td className="p-2 text-right">{euro(item.residualAmount)}</td><td className="p-2">{openItemStatusLabels[item.status]}</td></tr>; })}</tbody>
              </table>
            </div>
          )}
          {openItemError ? <p id={openItemErrorId} className="mt-1 text-xs text-error">{openItemError}</p> : null}
          {paymentValidationIssues.length > 0 ? <ValidationSummary errors={paymentValidationIssues} onJump={focusValidationField} /> : null}
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-sm sm:col-span-2">Importierte Bankzahlung <span className="text-error" aria-hidden="true">*</span><select id={paymentFieldIds.bankTransaction} aria-label="Bankzahlung" required={canMutate} aria-required={canMutate} aria-invalid={Boolean(paymentErrors[paymentFieldIds.bankTransaction])} aria-describedby={paymentErrors[paymentFieldIds.bankTransaction] ? `${paymentFieldIds.bankTransaction}-error` : undefined} className={`mt-1 w-full rounded-lg border px-3 py-2 ${errorClassName(Boolean(paymentErrors[paymentFieldIds.bankTransaction]))}`} value={selectedBankTransactionId} onChange={(e) => { setSelectedBankTransactionId(e.target.value); clearPaymentError(paymentFieldIds.bankTransaction); allocationEventRef.current = null; }} disabled={!canMutate || !selectedItem}><option value="">Noch nicht gebuchte Zahlung auswählen</option>{eligibleBankTransactions.map((transaction) => <option key={transaction.id} value={transaction.id}>{transaction.date} · {transaction.counterparty || 'Unbekannt'} · {transaction.purpose || 'Ohne Verwendungszweck'} · {euro(Math.abs(transaction.amount))}</option>)}</select>{paymentErrors[paymentFieldIds.bankTransaction] ? <span id={`${paymentFieldIds.bankTransaction}-error`} className="mt-1 block text-xs text-error">{paymentErrors[paymentFieldIds.bankTransaction]}</span> : null}</label>
            {selectedBankTransaction ? <p className="text-sm text-muted sm:col-span-2">Bankkonto {selectedBankTransaction.bankAccountNumber} · {selectedBankTransaction.date} · {euro(Math.abs(selectedBankTransaction.amount))}</p> : null}
            <label className="text-sm sm:col-span-2">Begründung <span className="text-error" aria-hidden="true">*</span><input aria-label="Begründung" id={paymentFieldIds.reason} required={canMutate} aria-required={canMutate} aria-invalid={Boolean(paymentErrors[paymentFieldIds.reason])} aria-describedby={paymentErrors[paymentFieldIds.reason] ? `${paymentFieldIds.reason}-error` : undefined} disabled={!canMutate} className={`mt-1 w-full rounded-lg border px-3 py-2 ${errorClassName(Boolean(paymentErrors[paymentFieldIds.reason]))}`} value={reason} onChange={(e) => { setReason(e.target.value); clearPaymentError(paymentFieldIds.reason); }} placeholder="z. B. Kontoauszug geprüft" />{paymentErrors[paymentFieldIds.reason] ? <span id={`${paymentFieldIds.reason}-error`} className="mt-1 block text-xs text-error">{paymentErrors[paymentFieldIds.reason]}</span> : null}</label>
          </div>
          <button type="button" aria-describedby={paymentFirstError ? 'opos-payment-action-error' : undefined} className="mt-3 rounded-lg bg-foreground px-4 py-2 text-sm font-semibold text-background disabled:opacity-50" disabled={!canMutate || busy} onClick={allocate}>Zahlung zuordnen</button>
          {paymentFirstError ? <p id="opos-payment-action-error" className="mt-2 text-xs text-error" role="status" aria-live="assertive">{paymentFirstError}</p> : null}
          {lastPayment && lastPayment.residualAmount > 0 ? <div className="mt-4 rounded-lg border border-warning-border bg-warning-bg p-3"><p className="text-sm font-semibold">Restzahlung: {euro(lastPayment.residualAmount)}</p><div className="mt-2 grid gap-2 sm:grid-cols-2"><label className="text-sm">Ziel <span className="text-error" aria-hidden="true">*</span><select id={paymentFieldIds.remainingItem} required={canMutate} aria-required={canMutate} aria-invalid={paymentErrors[paymentFieldIds.remainingItem] ? 'true' : undefined} aria-describedby={paymentErrors[paymentFieldIds.remainingItem] ? `${paymentFieldIds.remainingItem}-error` : undefined} disabled={!canMutate} className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${errorClassName(Boolean(paymentErrors[paymentFieldIds.remainingItem]))}`} value={remainingItemId} onChange={(e) => { setRemainingItemId(e.target.value); clearPaymentError(paymentFieldIds.remainingItem); }}><option value="">Weiteren offenen Posten wählen</option>{items.filter((item) => item.id !== selectedItemId && item.partyType === lastPayment.partyType).map((item) => <option key={item.id} value={item.id}>{item.documentNumber} ({euro(item.residualAmount)})</option>)}</select>{paymentErrors[paymentFieldIds.remainingItem] ? <span id={`${paymentFieldIds.remainingItem}-error`} className="mt-1 block text-xs text-error">{paymentErrors[paymentFieldIds.remainingItem]}</span> : null}</label><label className="text-sm">Betrag <span className="text-error" aria-hidden="true">*</span><input id={paymentFieldIds.remainingAmount} disabled={!canMutate} required={canMutate} aria-required={canMutate} aria-invalid={paymentErrors[paymentFieldIds.remainingAmount] ? 'true' : undefined} aria-describedby={paymentErrors[paymentFieldIds.remainingAmount] ? `${paymentFieldIds.remainingAmount}-error` : undefined} type="number" min="0.01" step="0.01" className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${errorClassName(Boolean(paymentErrors[paymentFieldIds.remainingAmount]))}`} value={remainingAmount} onChange={(e) => { setRemainingAmount(e.target.value); clearPaymentError(paymentFieldIds.remainingAmount); }} placeholder={String(lastPayment.residualAmount)} />{paymentErrors[paymentFieldIds.remainingAmount] ? <span id={`${paymentFieldIds.remainingAmount}-error`} className="mt-1 block text-xs text-error">{paymentErrors[paymentFieldIds.remainingAmount]}</span> : null}</label></div><button type="button" aria-describedby={remainingFirstError ? 'opos-payment-remaining-action-error' : undefined} className="mt-2 rounded-lg border border-muted px-3 py-2 text-sm font-semibold disabled:opacity-50" disabled={!canMutate || busy} onClick={allocateRemaining}>Restbetrag zuordnen</button>{remainingFirstError ? <p id="opos-payment-remaining-action-error" className="mt-2 text-xs text-error" role="status" aria-live="assertive">{remainingFirstError}</p> : null}</div> : null}
        </section>

        <section className="min-w-0 rounded-xl border border-border p-4" aria-labelledby="incoming-heading">
          <h3 id="incoming-heading" className="mb-3 text-base font-bold">Eingangsrechnungen</h3>
          {invoiceValidationIssues.length > 0 ? <ValidationSummary errors={invoiceValidationIssues} onJump={focusValidationField} /> : null}
          <fieldset disabled={!canMutate} className="contents">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">Rechnungsnummer <span className="text-error" aria-hidden="true">*</span><input aria-label="Rechnungsnummer" id={invoiceFieldIds.number} required={canMutate} aria-required={canMutate} aria-invalid={Boolean(invoiceErrors[invoiceFieldIds.number])} aria-describedby={invoiceErrors[invoiceFieldIds.number] ? `${invoiceFieldIds.number}-error` : undefined} className={`mt-1 w-full rounded-lg border px-3 py-2 ${errorClassName(Boolean(invoiceErrors[invoiceFieldIds.number]))}`} value={invoiceNumber} onChange={(e) => { setInvoiceNumber(e.target.value); clearInvoiceError(invoiceFieldIds.number); }} />{invoiceErrors[invoiceFieldIds.number] ? <span id={`${invoiceFieldIds.number}-error`} className="mt-1 block text-xs text-error">{invoiceErrors[invoiceFieldIds.number]}</span> : null}</label>
            <label className="text-sm">Kreditor<select id={invoiceFieldIds.vendor} aria-label="Kreditor" className="mt-1 w-full rounded-lg border border-border px-3 py-2" value={vendorId} onChange={(e) => { setVendorId(e.target.value); clearInvoiceError(invoiceFieldIds.vendorName); }}><option value="">Neuen Kreditor anlegen</option>{vendors.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}</select></label>
            {!vendorId ? <label className="text-sm">Kreditorname <span className="text-error" aria-hidden="true">*</span><input aria-label="Kreditorname" id={invoiceFieldIds.vendorName} required={canMutate} aria-required={canMutate} aria-invalid={Boolean(invoiceErrors[invoiceFieldIds.vendorName])} aria-describedby={invoiceErrors[invoiceFieldIds.vendorName] ? `${invoiceFieldIds.vendorName}-error` : undefined} className={`mt-1 w-full rounded-lg border px-3 py-2 ${errorClassName(Boolean(invoiceErrors[invoiceFieldIds.vendorName]))}`} value={vendorName} onChange={(e) => { setVendorName(e.target.value); clearInvoiceError(invoiceFieldIds.vendorName); }} />{invoiceErrors[invoiceFieldIds.vendorName] ? <span id={`${invoiceFieldIds.vendorName}-error`} className="mt-1 block text-xs text-error">{invoiceErrors[invoiceFieldIds.vendorName]}</span> : null}</label> : null}
            <label className="text-sm">Rechnungsdatum<input type="date" className="mt-1 w-full rounded-lg border border-border px-3 py-2" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} /></label>
            <label className="text-sm">Fällig am<input type="date" className="mt-1 w-full rounded-lg border border-border px-3 py-2" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></label>
            <div className="sm:col-span-2 rounded-lg border border-border-subtle p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h4 className="text-sm font-bold">Positionen</h4>
                  <p className="text-xs text-muted">Jede Position wird separat auf Cent gerundet und kann einen eigenen Steuersatz und ein eigenes Konto haben.</p>
                </div>
                <button type="button" className="rounded-lg border border-muted px-3 py-2 text-sm font-semibold" onClick={addInvoiceLine}>Position hinzufügen</button>
              </div>
              <div className="space-y-3">
                {invoiceLines.map((line, index) => {
                  const calculated = calculatedInvoiceLines[index];
                  return <div key={line.id} className="rounded-lg border border-border-subtle bg-surface-muted p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold">Position {index + 1}</span>
                      <button type="button" className="text-sm underline disabled:opacity-50" disabled={invoiceLines.length === 1} onClick={() => removeInvoiceLine(line.id)}>Entfernen</button>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="text-sm sm:col-span-2">Beschreibung <span className="text-error" aria-hidden="true">*</span><input id={invoiceLineFieldId(line.id, 'description')} aria-label="Position" required={canMutate} aria-required={canMutate} aria-invalid={Boolean(invoiceErrors[invoiceLineFieldId(line.id, 'description')])} aria-describedby={invoiceErrors[invoiceLineFieldId(line.id, 'description')] ? `${invoiceLineFieldId(line.id, 'description')}-error` : undefined} className={`mt-1 w-full rounded-lg border px-3 py-2 ${errorClassName(Boolean(invoiceErrors[invoiceLineFieldId(line.id, 'description')]))}`} value={line.description} onChange={(e) => { updateInvoiceLine(line.id, 'description', e.target.value); clearInvoiceError(invoiceLineFieldId(line.id, 'description')); }} />{invoiceErrors[invoiceLineFieldId(line.id, 'description')] ? <span id={`${invoiceLineFieldId(line.id, 'description')}-error`} className="mt-1 block text-xs text-error">{invoiceErrors[invoiceLineFieldId(line.id, 'description')]}</span> : null}</label>
                      <label className="text-sm">Menge <span className="text-error" aria-hidden="true">*</span><input aria-label="Menge" id={invoiceLineFieldId(line.id, 'quantity')} required={canMutate} aria-required={canMutate} aria-invalid={Boolean(invoiceErrors[invoiceLineFieldId(line.id, 'quantity')])} aria-describedby={invoiceErrors[invoiceLineFieldId(line.id, 'quantity')] ? `${invoiceLineFieldId(line.id, 'quantity')}-error` : undefined} type="number" min="0.001" step="0.001" className={`mt-1 w-full rounded-lg border px-3 py-2 ${errorClassName(Boolean(invoiceErrors[invoiceLineFieldId(line.id, 'quantity')]))}`} value={line.quantity} onChange={(e) => { updateInvoiceLine(line.id, 'quantity', e.target.value); clearInvoiceError(invoiceLineFieldId(line.id, 'quantity')); }} />{invoiceErrors[invoiceLineFieldId(line.id, 'quantity')] ? <span id={`${invoiceLineFieldId(line.id, 'quantity')}-error`} className="mt-1 block text-xs text-error">{invoiceErrors[invoiceLineFieldId(line.id, 'quantity')]}</span> : null}</label>
                      <label className="text-sm">Einzelpreis netto <span className="text-error" aria-hidden="true">*</span><input aria-label="Einzelpreis" id={invoiceLineFieldId(line.id, 'unitPrice')} required={canMutate} aria-required={canMutate} aria-invalid={Boolean(invoiceErrors[invoiceLineFieldId(line.id, 'unitPrice')])} aria-describedby={invoiceErrors[invoiceLineFieldId(line.id, 'unitPrice')] ? `${invoiceLineFieldId(line.id, 'unitPrice')}-error` : undefined} type="number" min="0.01" step="0.01" className={`mt-1 w-full rounded-lg border px-3 py-2 ${errorClassName(Boolean(invoiceErrors[invoiceLineFieldId(line.id, 'unitPrice')]))}`} value={line.unitPrice} onChange={(e) => { updateInvoiceLine(line.id, 'unitPrice', e.target.value); clearInvoiceError(invoiceLineFieldId(line.id, 'unitPrice')); }} />{invoiceErrors[invoiceLineFieldId(line.id, 'unitPrice')] ? <span id={`${invoiceLineFieldId(line.id, 'unitPrice')}-error`} className="mt-1 block text-xs text-error">{invoiceErrors[invoiceLineFieldId(line.id, 'unitPrice')]}</span> : null}</label>
                      <label className="text-sm">Steuersatz (%) <span className="text-error" aria-hidden="true">*</span><input aria-label="Steuersatz" id={invoiceLineFieldId(line.id, 'taxRate')} required={canMutate} aria-required={canMutate} aria-invalid={Boolean(invoiceErrors[invoiceLineFieldId(line.id, 'taxRate')])} aria-describedby={invoiceErrors[invoiceLineFieldId(line.id, 'taxRate')] ? `${invoiceLineFieldId(line.id, 'taxRate')}-error` : undefined} type="number" min="0" max="100" step="0.01" className={`mt-1 w-full rounded-lg border px-3 py-2 ${errorClassName(Boolean(invoiceErrors[invoiceLineFieldId(line.id, 'taxRate')]))}`} value={line.taxRate} onChange={(e) => { updateInvoiceLine(line.id, 'taxRate', e.target.value); clearInvoiceError(invoiceLineFieldId(line.id, 'taxRate')); }} />{invoiceErrors[invoiceLineFieldId(line.id, 'taxRate')] ? <span id={`${invoiceLineFieldId(line.id, 'taxRate')}-error`} className="mt-1 block text-xs text-error">{invoiceErrors[invoiceLineFieldId(line.id, 'taxRate')]}</span> : null}</label>
                      <label className="text-sm">Aufwandskonto<input aria-label="Konto" inputMode="numeric" className="mt-1 w-full rounded-lg border border-border px-3 py-2" value={line.accountNumber} onChange={(e) => updateInvoiceLine(line.id, 'accountNumber', e.target.value)} placeholder="z. B. 4900" /></label>
                      <label className="text-sm">Anlagekonto (optional)<input aria-label="Anlagekonto" inputMode="numeric" className="mt-1 w-full rounded-lg border border-border px-3 py-2" value={line.assetAccountNumber} onChange={(e) => updateInvoiceLine(line.id, 'assetAccountNumber', e.target.value)} placeholder="z. B. 0480" /></label>
                    </div>
                    <p className="mt-2 text-right text-xs text-muted">Netto {euro(calculated?.netAmount ?? 0)} · Steuer {euro(calculated?.taxAmount ?? 0)} · Brutto {euro(calculated?.grossAmount ?? 0)}</p>
                  </div>;
                })}
              </div>
            </div>
            <label className="text-sm sm:col-span-2">Begründung <span className="text-error" aria-hidden="true">*</span><input aria-label="Begründung" id={invoiceFieldIds.reason} required={canMutate} aria-required={canMutate} aria-invalid={Boolean(invoiceErrors[invoiceFieldIds.reason])} aria-describedby={invoiceErrors[invoiceFieldIds.reason] ? `${invoiceFieldIds.reason}-error` : undefined} className={`mt-1 w-full rounded-lg border px-3 py-2 ${errorClassName(Boolean(invoiceErrors[invoiceFieldIds.reason]))}`} value={invoiceReason} onChange={(e) => { setInvoiceReason(e.target.value); clearInvoiceError(invoiceFieldIds.reason); }} placeholder="z. B. Eingangsbeleg geprüft" />{invoiceErrors[invoiceFieldIds.reason] ? <span id={`${invoiceFieldIds.reason}-error`} className="mt-1 block text-xs text-error">{invoiceErrors[invoiceFieldIds.reason]}</span> : null}</label>
          </div>
          </fieldset>
          <div className="mt-2 rounded-lg bg-surface-muted p-3 text-sm" aria-label="Rechnungssummen">
            <p className="font-semibold">Summen: Netto {euro(invoiceTotals.netAmount)} · Steuer {euro(invoiceTotals.taxAmount)} · Brutto {euro(invoiceTotals.grossAmount)}</p>
            {invoiceTaxBreakdown.size > 0 ? <p className="mt-1 text-xs text-muted">Steueraufteilung: {Array.from(invoiceTaxBreakdown.entries()).sort(([left], [right]) => left - right).map(([rate, totals]) => `${rate}% ${euro(totals.taxAmount)}`).join(' · ')}</p> : null}
          </div>
          <div className="mt-3 flex min-w-0 flex-wrap gap-2"><button type="button" aria-describedby={invoiceFirstError ? 'opos-invoice-action-error' : undefined} className="rounded-lg bg-foreground px-4 py-2 text-sm font-semibold text-background disabled:opacity-50" disabled={!canMutate || busy} onClick={saveInvoice}>Entwurf speichern</button><select aria-label="Gespeicherten Beleg wählen" className="min-w-0 max-w-full rounded-lg border border-border px-3 py-2 text-sm" value={selectedInvoiceId} onChange={(e) => { setSelectedInvoiceId(e.target.value); setPreview(null); }}><option value="">Gespeicherten Beleg wählen</option>{invoices.map((invoice) => <option key={invoice.id} value={invoice.id}>{invoice.number} · {incomingInvoiceStatusLabels[invoice.status]} · {incomingInvoiceAccountingStatusLabels[invoice.accountingStatus]}</option>)}</select><button type="button" className="rounded-lg border border-muted px-3 py-2 text-sm font-semibold disabled:opacity-50" disabled={busy || !selectedInvoice} onClick={previewInvoice}>Vorschau</button><button type="button" className="rounded-lg border border-muted px-3 py-2 text-sm font-semibold disabled:opacity-50" disabled={!canMutate || busy || !selectedInvoice || selectedInvoice.status !== 'draft'} onClick={finalizeInvoice}>Für Buchung freigeben</button><button type="button" className="rounded-lg border border-muted px-3 py-2 text-sm font-semibold disabled:opacity-50" disabled={!canMutate || busy || !selectedInvoice || selectedInvoice.status === 'draft'} onClick={postInvoice}>Buchen</button></div>
          {invoiceFirstError ? <p id="opos-invoice-action-error" className="mt-2 text-xs text-error" role="status" aria-live="assertive">{invoiceFirstError}</p> : null}
          {selectedInvoice ? <div className="mt-3 rounded-lg border border-border-subtle bg-surface-muted p-3 text-sm" data-testid="incoming-invoice-summary"><strong>{selectedInvoice.lines.length} {selectedInvoice.lines.length === 1 ? 'Position' : 'Positionen'} gespeichert</strong><p className="mt-1 text-xs text-muted">Steueraufteilung: {Array.from(selectedInvoiceTaxBreakdown.entries()).sort(([left], [right]) => left - right).map(([rate, totals]) => `${rate}% ${euro(totals.taxAmount)}`).join(' · ') || 'Keine Positionsdaten'} · Brutto {euro(selectedInvoice.grossAmount)}</p></div> : null}
          <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={softLockOverride} disabled={!canMutate} onChange={(e) => setSoftLockOverride(e.target.checked)} /> Soft-Lock übersteuern</label>
          {softLockOverride ? <label className="mt-2 block text-sm">Override-Begründung<input disabled={!canMutate} className="mt-1 w-full rounded-lg border border-border px-3 py-2" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} /></label> : null}
          {preview ? <div className="mt-3 rounded-lg bg-surface-muted p-3 text-sm" role="status" aria-live="polite"><strong>Vorschau: {preview.status === 'ready' ? 'bereit' : 'nicht bereit'}</strong>{preview.issues.map((issue) => <p key={issue.code} className="mt-1 text-error">{issue.message}</p>)}</div> : null}
          <div className="mt-4 rounded-lg border border-border-subtle p-3" data-testid="incoming-documents">
            <h4 className="text-sm font-bold">Originalbelege</h4>
            <p className="mt-1 text-xs text-muted">Unveränderliche Originaldatei; Reviewstatus und Journalbezug bleiben am Beleg sichtbar.</p>
            {selectedInvoice && dataAdapter?.uploadIncomingInvoiceDocument ? <div className="mt-3 flex flex-wrap items-end gap-2">
              <label className="min-w-0 flex-1 text-sm">Datei archivieren<input ref={selectedFileInputRef} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" disabled={!canMutate || busy} className="mt-1 block w-full text-sm" onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)} /></label>
              <button type="button" className="rounded-lg border border-muted px-3 py-2 text-sm font-semibold disabled:opacity-50" disabled={!canMutate || busy || !selectedFile} onClick={uploadDocument}>Original archivieren</button>
            </div> : <p className="mt-2 text-sm text-muted">Zum Archivieren zuerst einen gespeicherten Beleg auswählen.</p>}
            {selectedInvoice && documents.length > 0 ? <div className="mt-3 overflow-x-auto"><table className="w-full table-fixed text-left text-xs"><colgroup><col className="w-1/6" /><col className="w-1/6" /><col className="w-1/3" /><col className="w-1/6" /><col className="w-1/6" /></colgroup><thead><tr className="border-b border-border text-muted"><th className="p-2">Datei</th><th className="p-2">Größe</th><th className="p-2">Review</th><th className="p-2">Journal</th><th className="p-1" /></tr></thead><tbody>{documents.map((document) => <tr key={document.id} className="border-b border-border-subtle"><td className="break-words p-2 font-medium">{document.originalFilename}</td><td className="break-words p-2">{document.byteLength.toLocaleString('de-DE')} Bytes</td><td className="break-words p-2"><span>{incomingInvoiceDocumentReviewLabels[document.reviewStatus]}</span>{dataAdapter?.reviewIncomingInvoiceDocument ? <div className="mt-1 flex flex-wrap gap-1"><button type="button" className="underline" disabled={!canMutate || busy} onClick={() => reviewDocument(document, 'accepted')}>Als geprüft markieren</button><button type="button" className="underline" disabled={!canMutate || busy} onClick={() => reviewDocument(document, 'rejected')}>Ablehnen</button></div> : null}</td><td className="break-words p-2">{document.journalEntryId ? `Journal ${document.journalEntryId}` : 'Noch nicht gebucht'}</td><td className="whitespace-nowrap p-1 text-right"><button type="button" className="whitespace-nowrap underline" disabled={busy || !dataAdapter?.downloadIncomingInvoiceDocument} onClick={() => downloadDocument(document)}>Herunterladen</button></td></tr>)}</tbody></table></div> : selectedInvoice ? <p className="mt-3 text-sm text-muted">Noch kein Originalbeleg archiviert.</p> : null}
          </div>
        </section>
      </div>
    </div>
  );
}
