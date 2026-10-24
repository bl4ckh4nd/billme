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
import type { OposBankTransaction, ProAccountingDataAdapter } from '../services/accountingDataAdapter';
import { permissionContextForRole } from '../domain/permissions';
import { localToday } from '../domain/reportDates';
import type { UserRole } from '../types';
import {
  Badge, Button, Card, CardHeader, Checkbox, EmptyState, Input, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, ValidationSummary, cn,
  type BadgeTone,
} from '@billme/ui';

const euro = (value: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
const today = () => localToday();
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
const openItemStatusTones: Record<OpenItemEntity['status'], BadgeTone> = {
  open: 'info',
  partially_paid: 'success',
  paid: 'accent',
  overpaid: 'warning',
  unresolved: 'warning',
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
const incomingInvoiceDocumentReviewTones: Record<keyof typeof incomingInvoiceDocumentReviewLabels, BadgeTone> = {
  pending: 'neutral',
  accepted: 'success',
  rejected: 'error',
};
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

const bannerClass = 'rounded-control border px-3 py-2.5 text-control';

const formatDate = (iso: string): string => iso.slice(0, 10).split('-').reverse().join('.');

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

/** Purchases where the buyer owes the VAT (§ 13b, innergemeinschaftlicher Erwerb): the supplier bills net. */
const SELF_ASSESSED_TAX_CASES = [
  { key: 'DE_RC_13B_DOMESTIC', label: '§ 13b Inland (z. B. Bauleistung)', vatIdRequired: false },
  { key: 'EU_B2B_SERVICE_RC', label: 'Sonstige Leistung aus einem EU-Land (§ 13b)', vatIdRequired: true },
  { key: 'NON_EU_SERVICE_RC', label: 'Leistung aus einem Drittland (§ 13b)', vatIdRequired: false },
  { key: 'EU_IGE_GOODS_RC', label: 'Innergemeinschaftlicher Erwerb (Ware aus einem EU-Land)', vatIdRequired: true },
] as const;
const taxFieldIds = { country: 'opos-invoice-tax-country', vatId: 'opos-invoice-tax-vat-id', reference: 'opos-invoice-tax-reference' } as const;

const calculateIncomingInvoiceLine = (line: IncomingInvoiceDraftLine, selfAssessed = false): CalculatedIncomingInvoiceLine | null => {
  const quantity = Number(line.quantity);
  const unitPrice = Number(line.unitPrice);
  const taxRate = Number(line.taxRate);
  if (!line.description.trim() || !line.quantity.trim() || !line.unitPrice.trim() || !line.taxRate.trim()
    || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice <= 0
    || !Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) return null;
  const netAmount = roundCents(quantity * unitPrice);
  // A self-assessed purchase shows no VAT on the invoice; the rate is what the buyer owes itself.
  const taxAmount = selfAssessed ? 0 : roundCents(netAmount * taxRate / 100);
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
  /** Invoice to select on open (from Belege or Bankabgleich). */
  initialInvoiceId?: string;
};

export default function OposView({ dataAdapter, role = 'admin', initialInvoiceId }: OposViewProps) {
  const [items, setItems] = useState<OpenItemEntity[]>([]);
  const [bankTransactions, setBankTransactions] = useState<OposBankTransaction[]>([]);
  const [vendors, setVendors] = useState<VendorEntity[]>([]);
  const [invoices, setInvoices] = useState<IncomingInvoiceEntity[]>([]);
  const [documents, setDocuments] = useState<IncomingInvoiceDocumentEntity[]>([]);
  const [selectedItemId, setSelectedItemId] = useState('');
  const initialItemSelectedRef = useRef(false);
  const [selectedBankTransactionId, setSelectedBankTransactionId] = useState('');
  const [reason, setReason] = useState('');
  const [lastPayment, setLastPayment] = useState<OpenItemPaymentEntity | null>(null);
  const [payments, setPayments] = useState<OpenItemPaymentEntity[]>([]);
  const [correction, setCorrection] = useState<{ payment: OpenItemPaymentEntity; mode: 'reverse' | 'reallocate' } | null>(null);
  const [correctionReason, setCorrectionReason] = useState('');
  const [correctionTargetId, setCorrectionTargetId] = useState('');
  const [remainingItemId, setRemainingItemId] = useState('');
  const [remainingAmount, setRemainingAmount] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(today());
  const [dueDate, setDueDate] = useState(today());
  const [vendorId, setVendorId] = useState('');
  const [vendorName, setVendorName] = useState('');
  const [invoiceLines, setInvoiceLines] = useState<IncomingInvoiceDraftLine[]>(() => [createIncomingInvoiceDraftLine()]);
  const [taxCaseKey, setTaxCaseKey] = useState('');
  const [taxCountry, setTaxCountry] = useState('');
  const [taxVatId, setTaxVatId] = useState('');
  const [taxReference, setTaxReference] = useState('');
  const [invoiceReason, setInvoiceReason] = useState('');
  const [selectedInvoiceId, setSelectedInvoiceId] = useState(initialInvoiceId ?? '');
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
      if (dataAdapter.listOpenItemPayments) setPayments(await dataAdapter.listOpenItemPayments());
    } finally {
      setLoading(false);
    }
  }, [dataAdapter]);

  useEffect(() => {
    setFeedback(null);
    void refresh().catch((cause) => setFeedback({ kind: 'error', retry: true, text: formatOposError(cause, 'OPOS-Daten konnten nicht geladen werden.') }));
  }, [refresh]);

  useEffect(() => {
    if (!initialInvoiceId || initialItemSelectedRef.current) return;
    const item = items.find((candidate) => candidate.sourceId === initialInvoiceId);
    if (!item) return;
    initialItemSelectedRef.current = true;
    setSelectedItemId(item.id);
  }, [initialInvoiceId, items]);

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
  const selfAssessedCase = SELF_ASSESSED_TAX_CASES.find((entry) => entry.key === taxCaseKey);
  const calculatedInvoiceLines = invoiceLines.map((line) => calculateIncomingInvoiceLine(line, Boolean(selfAssessedCase)));
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
    ? bankTransactions.filter((transaction) => transaction.status === 'pending' && !transaction.linkedInvoiceId && (
      // Money in the normal direction settles what is open; the other direction is a refund
      // (Rückzahlung, Rücklastschrift) of a credit or of what was paid.
      transaction.type === (selectedItem.partyType === 'debtor' ? 'income' : 'expense')
        ? selectedItem.residualAmount > 0
        : selectedItem.residualAmount < 0 || selectedItem.allocatedAmount > 0))
    : [];
  const refundRoom = (item: OpenItemEntity) => item.residualAmount < 0 ? -item.residualAmount : item.allocatedAmount;

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
    if (selfAssessedCase) {
      if (!/^[A-Za-z]{2}$/.test(taxCountry.trim())) errors[taxFieldIds.country] = 'Land des Lieferanten mit zwei Buchstaben angeben, z. B. AT.';
      if (selfAssessedCase.vatIdRequired && !/^[A-Za-z]{2}[A-Za-z0-9]{2,14}$/.test(taxVatId.trim())) errors[taxFieldIds.vatId] = 'USt-IdNr. des Lieferanten mit Länderpräfix angeben.';
      if (!taxReference.trim()) errors[taxFieldIds.reference] = 'Nachweis angeben, z. B. den Hinweis auf der Rechnung.';
    }
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
        allocations: [{ openItemId: selectedItem.id, amount: Math.min(amount, selectedBankTransaction.type === (selectedItem.partyType === 'debtor' ? 'income' : 'expense') ? selectedItem.residualAmount : refundRoom(selectedItem)) }],
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

  const correctionTargets = correction ? items.filter((item) => item.partyType === correction.payment.partyType && item.residualAmount > 0 && !item.id.startsWith('payment-credit:')) : [];
  const submitCorrection = () => {
    if (!correction || !canMutate) return;
    const trimmed = correctionReason.trim();
    const target = correctionTargets.find((item) => item.id === correctionTargetId);
    if (!trimmed || (correction.mode === 'reallocate' && !target)) {
      setFeedback({ kind: 'error', text: correction.mode === 'reallocate' ? 'Neuer offener Posten und Begründung sind Pflichtfelder.' : 'Begründung ist erforderlich.' });
      return;
    }
    void run(async () => {
      if (correction.mode === 'reverse') await dataAdapter!.reverseOpenItemPayment!(correction.payment.id, trimmed);
      else await dataAdapter!.reallocateOpenItemPayment!(correction.payment.id, { reason: trimmed, partyId: target!.partyId, allocations: [{ openItemId: target!.id, amount: Math.min(correction.payment.amount, target!.residualAmount) }], allocationEventId: eventId() });
      setFeedback({ kind: 'success', text: correction.mode === 'reverse' ? 'Zahlung storniert. Gegenbuchung im Journal, Posten wieder offen.' : 'Zahlung umgebucht. Storno und neue Zuordnung stehen im Journal.' });
      setCorrection(null);
      setCorrectionReason('');
      setCorrectionTargetId('');
      setLastPayment(null);
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
        ...(selfAssessedCase ? {
          taxCaseKey: selfAssessedCase.key,
          taxMeta: { vendorCountryCode: taxCountry.trim().toUpperCase(), ...(taxVatId.trim() ? { vendorVatId: taxVatId.trim().toUpperCase() } : {}), evidenceType: 'rechnung', evidenceReference: taxReference.trim() },
        } : {}),
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

  const openItemsCard = (title: string, rows: OpenItemEntity[]) => (
    <Card padding="none" className="min-w-0 overflow-hidden">
      <CardHeader
        as="h3"
        className="border-b border-border px-3.5 py-3"
        title={title}
        actions={<span className="text-label tabular-nums text-foreground">{euro(rows.reduce((sum, item) => sum + item.residualAmount, 0))}</span>}
      />
      {!loading && feedback?.kind !== 'error' && rows.length === 0 ? <EmptyState title="Keine offenen Posten vorhanden." /> : (
        <Table aria-label={title} bare>
          <TableHeader><TableRow><TableHead>Beleg</TableHead><TableHead>Fällig</TableHead><TableHead numeric>Restbetrag</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
          <TableBody>{rows.map((item) => {
            const itemId = `opos-open-item-${item.id}`;
            const itemError = paymentErrors[itemId];
            return (
              <TableRow key={item.id} selected={selectedItemId === item.id}>
                <TableCell>
                  <Button
                    id={itemId}
                    variant="ghost"
                    size="sm"
                    static
                    aria-pressed={selectedItemId === item.id}
                    aria-required="true"
                    aria-invalid={itemError ? 'true' : undefined}
                    aria-describedby={itemError ? `${itemId}-error` : undefined}
                    className={cn('-my-1 -ml-2.25', itemError && 'border-error text-error-text')}
                    onClick={() => selectOpenItem(item.id)}
                  >
                    {item.documentNumber}
                  </Button>
                </TableCell>
                <TableCell muted className="tabular-nums">{formatDate(item.dueDate)}</TableCell>
                <TableCell numeric>{euro(item.residualAmount)}</TableCell>
                <TableCell>{item.residualAmount < 0 ? <Badge tone="warning">Guthaben</Badge> : <Badge tone={openItemStatusTones[item.status]}>{openItemStatusLabels[item.status]}</Badge>}</TableCell>
              </TableRow>
            );
          })}</TableBody>
        </Table>
      )}
    </Card>
  );

  return (
    <div className="min-w-0 space-y-3.5" data-testid="opos-workspace">
      <div className="sr-only">
        <h2>OPOS</h2>
        <p>Offene Posten, Zahlungszuordnung und Eingangsrechnungen.</p>
      </div>
      {busy ? <div className="text-caption text-muted" aria-live="polite" aria-busy="true">Speichere Änderung…</div> : null}
      {loading ? <div className="text-control text-muted" role="status" aria-live="polite" aria-busy="true">OPOS-Daten werden geladen…</div> : null}
      {/* ponytail: validation errors keep the retry action; split load and validation feedback when retry semantics diverge. */}
      {feedback ? feedback.kind === 'error' ? <div data-testid="opos-feedback" className={`flex flex-wrap items-center gap-3 border-error-border bg-error-bg text-error-text ${bannerClass}`} role="alert" aria-live="assertive"><span>{feedback.text}</span>{feedback.retry ? <Button type="button" size="sm" variant="secondary" onClick={() => { setFeedback(null); void refresh().catch((cause) => setFeedback({ kind: 'error', retry: true, text: formatOposError(cause, 'OPOS-Daten konnten nicht geladen werden.') })); }}>Erneut versuchen</Button> : null}</div> : <div data-testid="opos-feedback" className={`border-success-border bg-success-bg text-success-text ${bannerClass}`} role="status" aria-live="polite">{feedback.text}</div> : null}
      {!canMutate ? <div className={`border-border bg-surface-muted text-muted ${bannerClass}`} role="status">Diese Rolle kann OPOS-Daten nur lesen.</div> : null}

      <section className="grid min-w-0 gap-3.5 lg:grid-cols-2" aria-labelledby="open-items-heading">
        <h3 id="open-items-heading" className="sr-only">Offene Posten</h3>
        {openItemsCard('Forderungen', items.filter((item) => item.partyType === 'debtor'))}
        {openItemsCard('Verbindlichkeiten', items.filter((item) => item.partyType === 'creditor'))}
      </section>

      <div className="grid min-w-0 items-start gap-3.5 xl:grid-cols-2">
        <Card padding="none" className="min-w-0">
          <CardHeader
            as="h3"
            className="border-b border-border px-3.5 py-3"
            title="Zahlung zuordnen"
            subtitle={selectedItem ? `${selectedItem.documentNumber} · ${euro(selectedItem.residualAmount)}` : undefined}
          />
          <div className="flex flex-col gap-3 p-3.5">
            {openItemError ? <p id={openItemErrorId} className="text-caption text-error-text">{openItemError}</p> : null}
            {paymentValidationIssues.length > 0 ? <ValidationSummary className="mb-0" errors={paymentValidationIssues} onJump={focusValidationField} /> : null}
            <Select
              id={paymentFieldIds.bankTransaction}
              label="Importierte Bankzahlung"
              aria-label="Bankzahlung"
              required={canMutate}
              fullWidth
              error={paymentErrors[paymentFieldIds.bankTransaction]}
              value={selectedBankTransactionId}
              onChange={(e) => { setSelectedBankTransactionId(e.target.value); clearPaymentError(paymentFieldIds.bankTransaction); allocationEventRef.current = null; }}
              disabled={!canMutate || !selectedItem}
            >
              <option value="">Noch nicht gebuchte Zahlung auswählen</option>
              {eligibleBankTransactions.map((transaction) => <option key={transaction.id} value={transaction.id}>{transaction.date} · {transaction.counterparty || 'Unbekannt'} · {transaction.purpose || 'Ohne Verwendungszweck'} · {euro(Math.abs(transaction.amount))}</option>)}
            </Select>
            {selectedBankTransaction ? <p className="text-control text-muted">Bankkonto {selectedBankTransaction.bankAccountNumber} · {selectedBankTransaction.date} · {euro(Math.abs(selectedBankTransaction.amount))}</p> : null}
            <Input
              id={paymentFieldIds.reason}
              label="Begründung"
              aria-label="Begründung"
              required={canMutate}
              fullWidth
              error={paymentErrors[paymentFieldIds.reason]}
              disabled={!canMutate}
              value={reason}
              onChange={(e) => { setReason(e.target.value); clearPaymentError(paymentFieldIds.reason); }}
              placeholder="z. B. Kontoauszug geprüft"
            />
            <div>
              <Button aria-describedby={paymentFirstError ? 'opos-payment-action-error' : undefined} disabled={!canMutate || busy} onClick={allocate}>Zahlung zuordnen</Button>
              {paymentFirstError ? <p id="opos-payment-action-error" className="mt-2 text-caption text-error-text" role="status" aria-live="assertive">{paymentFirstError}</p> : null}
            </div>
            {lastPayment && lastPayment.residualAmount > 0 ? (
              <div className="rounded-control border border-warning-border bg-warning-bg p-3">
                <p className="text-label text-warning-text">Restzahlung: {euro(lastPayment.residualAmount)}</p>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  <Select
                    id={paymentFieldIds.remainingItem}
                    label="Ziel"
                    required={canMutate}
                    fullWidth
                    error={paymentErrors[paymentFieldIds.remainingItem]}
                    disabled={!canMutate}
                    value={remainingItemId}
                    onChange={(e) => { setRemainingItemId(e.target.value); clearPaymentError(paymentFieldIds.remainingItem); }}
                  >
                    <option value="">Weiteren offenen Posten wählen</option>
                    {items.filter((item) => item.id !== selectedItemId && item.partyType === lastPayment.partyType).map((item) => <option key={item.id} value={item.id}>{item.documentNumber} ({euro(item.residualAmount)})</option>)}
                  </Select>
                  <Input
                    id={paymentFieldIds.remainingAmount}
                    label="Betrag"
                    required={canMutate}
                    fullWidth
                    error={paymentErrors[paymentFieldIds.remainingAmount]}
                    disabled={!canMutate}
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={remainingAmount}
                    onChange={(e) => { setRemainingAmount(e.target.value); clearPaymentError(paymentFieldIds.remainingAmount); }}
                    placeholder={String(lastPayment.residualAmount)}
                  />
                </div>
                <Button variant="secondary" className="mt-3" aria-describedby={remainingFirstError ? 'opos-payment-remaining-action-error' : undefined} disabled={!canMutate || busy} onClick={allocateRemaining}>Restbetrag zuordnen</Button>
                {remainingFirstError ? <p id="opos-payment-remaining-action-error" className="mt-2 text-caption text-error-text" role="status" aria-live="assertive">{remainingFirstError}</p> : null}
              </div>
            ) : null}
          </div>
        </Card>

        {dataAdapter?.listOpenItemPayments ? (
          <Card padding="none" className="min-w-0 overflow-hidden">
            <CardHeader as="h3" className="border-b border-border px-3.5 py-3" title="Gebuchte Zahlungen" subtitle="Storno mit Gegenbuchung oder Umbuchung auf einen anderen Posten" />
            {payments.length === 0 ? <EmptyState title="Noch keine Zahlungen gebucht." /> : (
              <Table aria-label="Gebuchte Zahlungen" bare>
                <TableHeader><TableRow><TableHead>Datum</TableHead><TableHead>Quelle</TableHead><TableHead numeric>Betrag</TableHead><TableHead>Status</TableHead><TableHead>Aktion</TableHead></TableRow></TableHeader>
                <TableBody>{payments.slice(0, 50).map((payment) => (
                  <TableRow key={payment.id} selected={correction?.payment.id === payment.id}>
                    <TableCell className="whitespace-nowrap tabular-nums">{payment.paymentDate}</TableCell>
                    <TableCell>{payment.sourceType === 'bank_transaction' ? 'Bank' : payment.sourceType === 'invoice_payment' ? 'Rechnung' : 'Manuell'}</TableCell>
                    <TableCell numeric>{euro(payment.refund ? -payment.amount : payment.amount)}</TableCell>
                    <TableCell>{payment.status === 'reversed' ? <Badge tone="neutral">Storniert</Badge> : payment.refund ? <Badge tone="warning">Erstattung</Badge> : <Badge tone="success">Gebucht</Badge>}</TableCell>
                    <TableCell>
                      {payment.status !== 'reversed' && canMutate ? (
                        <div className="flex gap-1">
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setCorrection({ payment, mode: 'reverse' }); setCorrectionTargetId(''); }}>Stornieren</Button>
                          {payment.sourceType !== 'invoice_payment' && !payment.refund ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setCorrection({ payment, mode: 'reallocate' }); setCorrectionTargetId(''); }}>Umbuchen</Button> : null}
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
            )}
            {correction ? (
              <div className="flex flex-col gap-3 border-t border-border p-3.5" data-testid="opos-payment-correction">
                <p className="text-control text-muted">
                  {correction.mode === 'reverse'
                    ? `Storno der Zahlung vom ${correction.payment.paymentDate} über ${euro(correction.payment.amount)}: Gegenbuchung zum Zahlungsdatum, Zuordnung zurückgenommen, Beleg und Bankzeile wieder offen.`
                    : `Umbuchung der Zahlung vom ${correction.payment.paymentDate} über ${euro(correction.payment.amount)}: Storno und neue Zuordnung mit derselben Begründung.`}
                </p>
                {correction.mode === 'reallocate' ? (
                  <Select id="opos-correction-target" label="Neuer offener Posten" required fullWidth value={correctionTargetId} onChange={(e) => setCorrectionTargetId(e.target.value)}>
                    <option value="">Posten wählen</option>
                    {correctionTargets.map((item) => <option key={item.id} value={item.id}>{item.documentNumber} ({euro(item.residualAmount)})</option>)}
                  </Select>
                ) : null}
                <Input id="opos-correction-reason" label="Begründung" required fullWidth value={correctionReason} onChange={(e) => setCorrectionReason(e.target.value)} placeholder="z. B. falscher Kunde zugeordnet" />
                <div className="flex gap-2">
                  <Button variant={correction.mode === 'reverse' ? 'danger' : 'primary'} disabled={busy} onClick={submitCorrection}>{correction.mode === 'reverse' ? 'Zahlung stornieren' : 'Umbuchen'}</Button>
                  <Button variant="secondary" disabled={busy} onClick={() => setCorrection(null)}>Abbrechen</Button>
                </div>
              </div>
            ) : null}
          </Card>
        ) : null}

        <section className="min-w-0 space-y-3.5" aria-labelledby="incoming-heading">
          <Card padding="none">
            <CardHeader as="h3" className="border-b border-border px-3.5 py-3" title={<span id="incoming-heading">Eingangsrechnungen</span>} />
            <div className="flex flex-col gap-3 p-3.5">
              {invoiceValidationIssues.length > 0 ? <ValidationSummary className="mb-0" errors={invoiceValidationIssues} onJump={focusValidationField} /> : null}
              <fieldset disabled={!canMutate} className="contents">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    id={invoiceFieldIds.number}
                    label="Rechnungsnummer"
                    aria-label="Rechnungsnummer"
                    required={canMutate}
                    fullWidth
                    error={invoiceErrors[invoiceFieldIds.number]}
                    value={invoiceNumber}
                    onChange={(e) => { setInvoiceNumber(e.target.value); clearInvoiceError(invoiceFieldIds.number); }}
                  />
                  <Select id={invoiceFieldIds.vendor} label="Kreditor" aria-label="Kreditor" fullWidth value={vendorId} onChange={(e) => { setVendorId(e.target.value); clearInvoiceError(invoiceFieldIds.vendorName); }}>
                    <option value="">Neuen Kreditor anlegen</option>
                    {vendors.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}
                  </Select>
                  {!vendorId ? (
                    <Input
                      id={invoiceFieldIds.vendorName}
                      label="Kreditorname"
                      aria-label="Kreditorname"
                      required={canMutate}
                      fullWidth
                      error={invoiceErrors[invoiceFieldIds.vendorName]}
                      value={vendorName}
                      onChange={(e) => { setVendorName(e.target.value); clearInvoiceError(invoiceFieldIds.vendorName); }}
                    />
                  ) : null}
                  <Input label="Rechnungsdatum" type="date" fullWidth value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
                  <Input label="Fällig am" type="date" fullWidth value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                  <Select
                    label="Steuerfall"
                    aria-label="Steuerfall"
                    fullWidth
                    value={taxCaseKey}
                    onChange={(e) => {
                      setTaxCaseKey(e.target.value);
                      // Prefill the supplier's VAT ID and country from the creditor.
                      const vatId = vendors.find((vendor) => vendor.id === vendorId)?.vatId ?? '';
                      if (e.target.value && !taxVatId && vatId) setTaxVatId(vatId);
                      if (e.target.value && !taxCountry) setTaxCountry(vatId ? vatId.slice(0, 2).toUpperCase() : e.target.value === 'DE_RC_13B_DOMESTIC' ? 'DE' : '');
                    }}
                  >
                    <option value="">Inland oder steuerfrei (nach Steuersatz)</option>
                    {SELF_ASSESSED_TAX_CASES.map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}
                  </Select>
                </div>
                {selfAssessedCase ? (
                  <div className="grid gap-3 sm:grid-cols-3">
                    <p className="text-caption text-muted sm:col-span-3">Der Lieferant rechnet netto ab. Tragen Sie bei den Positionen den Steuersatz ein, den Sie selbst schulden. Billme bucht Umsatzsteuer und Vorsteuer in gleicher Höhe.</p>
                    <Input id={taxFieldIds.country} label="Land des Lieferanten" fullWidth required={canMutate} maxLength={2} error={invoiceErrors[taxFieldIds.country]} value={taxCountry} onChange={(e) => { setTaxCountry(e.target.value); clearInvoiceError(taxFieldIds.country); }} placeholder="z. B. AT" />
                    <Input id={taxFieldIds.vatId} label={selfAssessedCase.vatIdRequired ? 'USt-IdNr. des Lieferanten' : 'USt-IdNr. des Lieferanten (optional)'} fullWidth required={canMutate && selfAssessedCase.vatIdRequired} error={invoiceErrors[taxFieldIds.vatId]} value={taxVatId} onChange={(e) => { setTaxVatId(e.target.value); clearInvoiceError(taxFieldIds.vatId); }} placeholder="z. B. ATU12345678" />
                    <Input id={taxFieldIds.reference} label="Nachweis" fullWidth required={canMutate} error={invoiceErrors[taxFieldIds.reference]} value={taxReference} onChange={(e) => { setTaxReference(e.target.value); clearInvoiceError(taxFieldIds.reference); }} placeholder="z. B. Hinweis „Steuerschuldnerschaft des Leistungsempfängers“" />
                  </div>
                ) : null}
                <div className="border-t border-border pt-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h4 className="text-section text-foreground">Positionen</h4>
                      <p className="text-caption text-muted">Jede Position wird separat auf Cent gerundet und kann einen eigenen Steuersatz und ein eigenes Konto haben.</p>
                    </div>
                    <Button variant="secondary" size="sm" onClick={addInvoiceLine}>Position hinzufügen</Button>
                  </div>
                  <div className="divide-y divide-border">
                    {invoiceLines.map((line, index) => {
                      const calculated = calculatedInvoiceLines[index];
                      const fieldId = (field: 'description' | 'quantity' | 'unitPrice' | 'taxRate') => invoiceLineFieldId(line.id, field);
                      return (
                        <div key={line.id} className="py-3">
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <span className="text-label text-foreground">Position {index + 1}</span>
                            <Button variant="ghost" size="sm" disabled={invoiceLines.length === 1} onClick={() => removeInvoiceLine(line.id)}>Entfernen</Button>
                          </div>
                          <div className="grid gap-3 sm:grid-cols-6">
                            <div className="sm:col-span-6">
                              <Input
                                id={fieldId('description')}
                                label="Beschreibung"
                                aria-label="Position"
                                required={canMutate}
                                fullWidth
                                error={invoiceErrors[fieldId('description')]}
                                value={line.description}
                                onChange={(e) => { updateInvoiceLine(line.id, 'description', e.target.value); clearInvoiceError(fieldId('description')); }}
                              />
                            </div>
                            <div className="sm:col-span-2">
                              <Input
                                id={fieldId('quantity')}
                                label="Menge"
                                aria-label="Menge"
                                required={canMutate}
                                fullWidth
                                error={invoiceErrors[fieldId('quantity')]}
                                type="number"
                                min="0.001"
                                step="0.001"
                                value={line.quantity}
                                onChange={(e) => { updateInvoiceLine(line.id, 'quantity', e.target.value); clearInvoiceError(fieldId('quantity')); }}
                              />
                            </div>
                            <div className="sm:col-span-2">
                              <Input
                                id={fieldId('unitPrice')}
                                label="Einzelpreis netto"
                                aria-label="Einzelpreis"
                                required={canMutate}
                                fullWidth
                                error={invoiceErrors[fieldId('unitPrice')]}
                                type="number"
                                min="0.01"
                                step="0.01"
                                value={line.unitPrice}
                                onChange={(e) => { updateInvoiceLine(line.id, 'unitPrice', e.target.value); clearInvoiceError(fieldId('unitPrice')); }}
                              />
                            </div>
                            <div className="sm:col-span-2">
                              <Input
                                id={fieldId('taxRate')}
                                label="Steuersatz (%)"
                                aria-label="Steuersatz"
                                required={canMutate}
                                fullWidth
                                error={invoiceErrors[fieldId('taxRate')]}
                                type="number"
                                min="0"
                                max="100"
                                step="0.01"
                                value={line.taxRate}
                                onChange={(e) => { updateInvoiceLine(line.id, 'taxRate', e.target.value); clearInvoiceError(fieldId('taxRate')); }}
                              />
                            </div>
                            <div className="sm:col-span-3">
                              <Input label="Aufwandskonto" aria-label="Konto" inputMode="numeric" fullWidth value={line.accountNumber} onChange={(e) => updateInvoiceLine(line.id, 'accountNumber', e.target.value)} placeholder="z. B. 4900" />
                            </div>
                            <div className="sm:col-span-3">
                              <Input label="Anlagekonto (optional)" aria-label="Anlagekonto" inputMode="numeric" fullWidth value={line.assetAccountNumber} onChange={(e) => updateInvoiceLine(line.id, 'assetAccountNumber', e.target.value)} placeholder="z. B. 0480" />
                            </div>
                          </div>
                          <p className="mt-2 text-right text-caption tabular-nums text-muted">Netto {euro(calculated?.netAmount ?? 0)} · Steuer {euro(calculated?.taxAmount ?? 0)} · Brutto {euro(calculated?.grossAmount ?? 0)}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <Input
                  id={invoiceFieldIds.reason}
                  label="Begründung"
                  aria-label="Begründung"
                  required={canMutate}
                  fullWidth
                  error={invoiceErrors[invoiceFieldIds.reason]}
                  value={invoiceReason}
                  onChange={(e) => { setInvoiceReason(e.target.value); clearInvoiceError(invoiceFieldIds.reason); }}
                  placeholder="z. B. Eingangsbeleg geprüft"
                />
              </fieldset>
              <div className="text-control" aria-label="Rechnungssummen">
                <p className="font-semibold tabular-nums text-foreground">Summen: Netto {euro(invoiceTotals.netAmount)} · Steuer {euro(invoiceTotals.taxAmount)} · Brutto {euro(invoiceTotals.grossAmount)}</p>
                {invoiceTaxBreakdown.size > 0 ? <p className="mt-1 text-caption text-muted">Steueraufteilung: {Array.from(invoiceTaxBreakdown.entries()).sort(([left], [right]) => left - right).map(([rate, totals]) => `${rate}% ${euro(totals.taxAmount)}`).join(' · ')}</p> : null}
              </div>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-border px-3.5 py-3">
              <Button aria-describedby={invoiceFirstError ? 'opos-invoice-action-error' : undefined} disabled={!canMutate || busy} onClick={saveInvoice}>Entwurf speichern</Button>
              <div className="min-w-0 flex-1 basis-48">
                <Select aria-label="Gespeicherten Beleg wählen" fullWidth value={selectedInvoiceId} onChange={(e) => { setSelectedInvoiceId(e.target.value); setPreview(null); }}>
                  <option value="">Gespeicherten Beleg wählen</option>
                  {invoices.map((invoice) => <option key={invoice.id} value={invoice.id}>{invoice.number} · {incomingInvoiceStatusLabels[invoice.status]} · {incomingInvoiceAccountingStatusLabels[invoice.accountingStatus]}</option>)}
                </Select>
              </div>
              <Button variant="secondary" disabled={busy || !selectedInvoice} onClick={previewInvoice}>Vorschau</Button>
              <Button variant="secondary" disabled={!canMutate || busy || !selectedInvoice || selectedInvoice.status !== 'draft'} onClick={finalizeInvoice}>Für Buchung freigeben</Button>
              <Button variant="secondary" disabled={!canMutate || busy || !selectedInvoice || selectedInvoice.status === 'draft'} onClick={postInvoice}>Buchen</Button>
            </div>
            <div className="flex flex-col gap-3 border-t border-border p-3.5">
              {invoiceFirstError ? <p id="opos-invoice-action-error" className="text-caption text-error-text" role="status" aria-live="assertive">{invoiceFirstError}</p> : null}
              {selectedInvoice ? <div className={`border-border bg-surface-muted text-foreground ${bannerClass}`} data-testid="incoming-invoice-summary"><strong className="font-semibold">{selectedInvoice.lines.length} {selectedInvoice.lines.length === 1 ? 'Position' : 'Positionen'} gespeichert</strong><p className="mt-1 text-caption text-muted">Steueraufteilung: {Array.from(selectedInvoiceTaxBreakdown.entries()).sort(([left], [right]) => left - right).map(([rate, totals]) => `${rate}% ${euro(totals.taxAmount)}`).join(' · ') || 'Keine Positionsdaten'} · Brutto {euro(selectedInvoice.grossAmount)}</p></div> : null}
              <Checkbox label="Soft-Lock übersteuern" checked={softLockOverride} disabled={!canMutate} onChange={(e) => setSoftLockOverride(e.target.checked)} />
              {softLockOverride ? <Input label="Override-Begründung" fullWidth disabled={!canMutate} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} /> : null}
              {preview ? <div className={`border-border bg-surface-muted text-foreground ${bannerClass}`} role="status" aria-live="polite"><strong className="font-semibold">Vorschau: {preview.status === 'ready' ? 'bereit' : 'nicht bereit'}</strong>{preview.issues.map((issue) => <p key={issue.code} className="mt-1 text-error-text">{issue.message}</p>)}</div> : null}
            </div>
          </Card>

          <div data-testid="incoming-documents">
            <Card padding="none" className="overflow-hidden">
              <CardHeader as="h3" className="px-3.5 py-3" title="Originalbelege" subtitle="Unveränderliche Originaldatei; Reviewstatus und Journalbezug bleiben am Beleg sichtbar." />
              {selectedInvoice && dataAdapter?.uploadIncomingInvoiceDocument ? (
                <div className="flex flex-wrap items-end gap-2 border-t border-border p-3.5">
                  <label className="min-w-0 flex-1 text-caption font-medium text-foreground-secondary">Datei archivieren<input ref={selectedFileInputRef} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" disabled={!canMutate || busy} className="mt-1 block w-full text-control font-normal text-foreground file:mr-3 file:h-8.5 file:rounded-control file:border file:border-border-strong file:bg-surface file:px-3 file:text-label file:font-medium file:text-foreground" onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)} /></label>
                  <Button variant="secondary" disabled={!canMutate || busy || !selectedFile} onClick={uploadDocument}>Original archivieren</Button>
                </div>
              ) : <p className="border-t border-border p-3.5 text-control text-muted">Zum Archivieren zuerst einen gespeicherten Beleg auswählen.</p>}
              {selectedInvoice && documents.length > 0 ? (
                <Table aria-label="Originalbelege" bare containerClassName="border-t border-border" className="table-fixed">
                  <colgroup><col className="w-1/6" /><col className="w-1/6" /><col className="w-1/3" /><col className="w-1/6" /><col className="w-1/6" /></colgroup>
                  <TableHeader><TableRow><TableHead>Datei</TableHead><TableHead>Größe</TableHead><TableHead>Review</TableHead><TableHead>Journal</TableHead><TableHead><span className="sr-only">Aktion</span></TableHead></TableRow></TableHeader>
                  <TableBody>{documents.map((document) => (
                    <TableRow key={document.id}>
                      <TableCell className="break-words font-medium">{document.originalFilename}</TableCell>
                      <TableCell muted className="break-words tabular-nums">{document.byteLength.toLocaleString('de-DE')} Bytes</TableCell>
                      <TableCell className="break-words">
                        <Badge tone={incomingInvoiceDocumentReviewTones[document.reviewStatus]}>{incomingInvoiceDocumentReviewLabels[document.reviewStatus]}</Badge>
                        {dataAdapter?.reviewIncomingInvoiceDocument ? (
                          <div className="-ml-2.25 mt-1 flex flex-wrap gap-1">
                            <Button variant="ghost" size="sm" disabled={!canMutate || busy} onClick={() => reviewDocument(document, 'accepted')}>Als geprüft markieren</Button>
                            <Button variant="ghost" size="sm" disabled={!canMutate || busy} onClick={() => reviewDocument(document, 'rejected')}>Ablehnen</Button>
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell muted className="break-words">{document.journalEntryId ? `Journal ${document.journalEntryId}` : 'Noch nicht gebucht'}</TableCell>
                      <TableCell className="text-right"><Button variant="ghost" size="sm" className="-my-1" disabled={busy || !dataAdapter?.downloadIncomingInvoiceDocument} onClick={() => downloadDocument(document)}>Herunterladen</Button></TableCell>
                    </TableRow>
                  ))}</TableBody>
                </Table>
              ) : selectedInvoice ? <p className="border-t border-border p-3.5 text-control text-muted">Noch kein Originalbeleg archiviert.</p> : null}
            </Card>
          </div>
        </section>
      </div>
    </div>
  );
}
