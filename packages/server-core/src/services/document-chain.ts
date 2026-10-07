import type { AuditActor } from '../ports/index.js';
import type { Invoice, InvoiceDocumentKind, Offer, TenantScope } from '../domain/foundations.js';
import type { MaybePromise } from '../ports/index.js';
import type { BillingLineItem } from '../domain/billing-lines.js';
import { getBillingLineAmount } from '../domain/billing-lines.js';
import type { InvoiceOfferDomainDependencies } from './invoice-offer.js';
import { calculateInvoiceTaxSnapshot } from './taxMode.js';

type ChainDependencies = Pick<InvoiceOfferDomainDependencies, 'invoiceRepo' | 'offerRepo' | 'auditLog'>;
type AsyncChainDependencies = {
  invoiceRepo: {
    list(scope: TenantScope): MaybePromise<Invoice[]>;
    getById(scope: TenantScope, id: string): MaybePromise<Invoice | null>;
    save(scope: TenantScope, invoice: Invoice): MaybePromise<Invoice>;
  };
  offerRepo: {
    getById(scope: TenantScope, id: string): MaybePromise<Offer | null>;
  };
  auditLog: {
    append(scope: TenantScope, entry: Parameters<InvoiceOfferDomainDependencies['auditLog']['append']>[1]): MaybePromise<unknown>;
  };
};

export type SettlementInvoiceKind = 'advance_invoice' | 'partial_invoice' | 'final_invoice';
export type CorrectionDocumentKind = 'credit_note' | 'cancellation_invoice';

export interface DocumentChainCreateParams {
  id: string;
  number: string;
  date: string;
  dueDate?: string;
  servicePeriod?: string;
  actor?: AuditActor;
  reason: string;
}

export interface CreateOrderConfirmationParams extends DocumentChainCreateParams {
  offerId: string;
}

export interface CreateDeliveryNoteParams extends DocumentChainCreateParams {
  orderId: string;
  /** Optional subset of the order lines; defaults to the immutable order snapshot. */
  items?: BillingLineItem[];
}

export interface CreateSettlementInvoiceParams extends DocumentChainCreateParams {
  orderId: string;
  kind: SettlementInvoiceKind;
  amount: number;
  items?: BillingLineItem[];
}

export interface CreateCorrectionParams extends DocumentChainCreateParams {
  invoiceId: string;
  kind: CorrectionDocumentKind;
  /** Gross amount to reverse. A credit note may be partial; cancellation is full-only. */
  amount?: number;
  items?: BillingLineItem[];
}

export interface CreateRevisionParams extends DocumentChainCreateParams {
  invoiceId: string;
}

export class DocumentChainError extends Error {
  constructor(message: string, readonly code: 'DOCUMENT_CHAIN_INVALID' | 'DOCUMENT_CHAIN_NOT_FOUND' | 'DOCUMENT_CHAIN_CONFLICT' = 'DOCUMENT_CHAIN_INVALID') {
    super(message);
    this.name = 'DocumentChainError';
  }
}

const defaultActor: AuditActor = { type: 'system', displayName: 'local' };
const cents = (value: number): number => Math.round(value * 100);
const euros = (value: number): number => cents(value) / 100;
const positiveAmount = (value: number, field: string): number => {
  if (!Number.isFinite(value) || euros(value) <= 0) throw new DocumentChainError(`${field} muss größer als 0 sein.`);
  return euros(value);
};
const requireReason = (reason: string): string => {
  const normalized = reason.trim();
  if (!normalized) throw new DocumentChainError('Bitte einen Grund angeben.');
  return normalized;
};

const isBillable = (line: BillingLineItem): boolean => line.kind === 'item' || line.kind === 'time' || line.kind === undefined;

/**
 * Keep a partial document's immutable line snapshot consistent with the
 * requested gross amount. Structural and optional lines remain untouched;
 * billable quantities reproduce the prorated net cents at the original price.
 */
const scaleLineItems = (
  items: BillingLineItem[],
  sourceAmount: number,
  targetAmount: number,
): BillingLineItem[] => {
  if (!items.length || cents(sourceAmount) <= 0 || cents(sourceAmount) === cents(targetAmount)) return items;
  const factor = targetAmount / sourceAmount;
  return items.map((line) => {
    if (!isBillable(line)) return line;
    const total = euros(getBillingLineAmount(line) * factor);
    const effectivePrice = line.price * (1 - (line.discountPercent ?? 0) / 100);
    return {
      ...line,
      quantity: effectivePrice ? total / effectivePrice : line.quantity * factor,
      total,
    };
  });
};

const acceptedOffer = (offer: Offer): boolean => offer.status === 'accepted' || offer.share?.decision === 'accepted';

// ---- document kinds -------------------------------------------------------------------

/** Documents that bill the customer: they are receivables, take payments and count as revenue. */
export const RECEIVABLE_DOCUMENT_KINDS: readonly InvoiceDocumentKind[] = ['invoice', 'advance_invoice', 'partial_invoice', 'final_invoice'];
export const isReceivableDocumentKind = (kind?: InvoiceDocumentKind | string | null): boolean =>
  (RECEIVABLE_DOCUMENT_KINDS as readonly string[]).includes(kind ?? 'invoice');
export const isCorrectionDocumentKind = (kind?: InvoiceDocumentKind | string | null): boolean =>
  kind === 'credit_note' || kind === 'cancellation_invoice';

/** The smallest shape the chain arithmetic needs, so the renderer can use it on its own types. */
export interface ChainDocumentLike {
  id: string;
  amount: number;
  status?: string;
  documentKind?: InvoiceDocumentKind | string;
  sourceDocumentId?: string;
  rootDocumentId?: string;
  payments?: ReadonlyArray<unknown>;
}

/** Revenue and receivable effect of a document: billing documents count, corrections subtract, AB and delivery notes are zero. */
export const signedDocumentAmount = (document: Pick<ChainDocumentLike, 'amount' | 'documentKind'>): number =>
  isReceivableDocumentKind(document.documentKind) ? document.amount : isCorrectionDocumentKind(document.documentKind) ? -document.amount : 0;

const issuedCancellationSources = (documents: ReadonlyArray<ChainDocumentLike>): Set<string | undefined> =>
  new Set(documents.filter((document) => document.documentKind === 'cancellation_invoice' && document.status !== 'draft').map((document) => document.sourceDocumentId));

/** Settlement invoices below an order that still count: issued and not reversed by a Storno. */
const billedSettlements = <T extends ChainDocumentLike>(documents: ReadonlyArray<T>, orderId: string): T[] => {
  const cancelled = issuedCancellationSources(documents);
  return documents.filter((document) => document.rootDocumentId === orderId
    && document.id !== orderId
    && isReceivableDocumentKind(document.documentKind)
    && document.status !== 'draft'
    && !cancelled.has(document.id));
};

/** Order total, what is already billed below it and what remains to bill. */
export const orderSettlement = (documents: ReadonlyArray<ChainDocumentLike>, order: ChainDocumentLike) => {
  const billed = billedSettlements(documents, order.id).reduce((sum, document) => sum + cents(document.amount), 0);
  const total = cents(order.amount);
  return { total: total / 100, billed: billed / 100, remaining: Math.max(0, total - billed) / 100, finalIssued: billedSettlements(documents, order.id).some((document) => document.documentKind === 'final_invoice') };
};

/** How much of an invoice can still be credited; zero once it is cancelled. */
export const correctableAmount = (source: ChainDocumentLike, documents: ReadonlyArray<ChainDocumentLike>): number => {
  const corrections = documents.filter((candidate) => candidate.sourceDocumentId === source.id && isCorrectionDocumentKind(candidate.documentKind) && candidate.status !== 'draft');
  if (source.status === 'cancelled' || corrections.some((candidate) => candidate.documentKind === 'cancellation_invoice')) return 0;
  const corrected = corrections.reduce((sum, candidate) => sum + cents(candidate.amount), 0);
  return Math.max(0, cents(source.amount) - corrected) / 100;
};

/** Why an offer cannot become an order confirmation, or null when it can. */
export const orderConfirmationBlocker = (offer: Offer | ChainDocumentLike & { share?: Offer['share'] }, documents: ReadonlyArray<ChainDocumentLike>): string | null => {
  if (!acceptedOffer(offer as Offer)) return 'Das Angebot muss angenommen sein, bevor eine Auftragsbestätigung erstellt wird.';
  if (documents.some((document) => document.documentKind === 'order_confirmation' && document.sourceDocumentId === offer.id)) {
    return 'Für dieses Angebot besteht bereits eine Auftragsbestätigung.';
  }
  if (documents.some((document) => isReceivableDocumentKind(document.documentKind) && document.sourceDocumentId === offer.id)) {
    return 'Dieses Angebot wurde bereits direkt in eine Rechnung umgewandelt; eine Auftragsbestätigung würde es doppelt abrechnen.';
  }
  return null;
};

/** Why an invoice cannot be corrected, or null when it can. */
export const correctionBlocker = (source: ChainDocumentLike, documents: ReadonlyArray<ChainDocumentLike>, kind: CorrectionDocumentKind): string | null => {
  if (source.status === 'draft') return 'Nur gestellte Rechnungen können korrigiert werden.';
  if (source.documentKind === 'order_confirmation' || source.documentKind === 'delivery_note') return 'Auftragsbestätigungen und Lieferscheine können nicht korrigiert werden.';
  if (isCorrectionDocumentKind(source.documentKind)) return 'Gutschriften und Stornorechnungen werden nicht erneut korrigiert.';
  const corrections = documents.filter((candidate) => candidate.sourceDocumentId === source.id && isCorrectionDocumentKind(candidate.documentKind) && candidate.status !== 'draft');
  if (kind === 'cancellation_invoice' && corrections.length > 0) {
    return 'Zu dieser Rechnung gibt es schon eine Gutschrift oder Stornorechnung; eine Stornorechnung ist nicht mehr möglich.';
  }
  if (corrections.some((candidate) => candidate.documentKind === 'cancellation_invoice') || source.status === 'cancelled') {
    return 'Die Rechnung ist bereits storniert; eine Gutschrift ist nicht mehr möglich.';
  }
  if (correctableAmount(source, documents) <= 0) return 'Die Rechnung ist bereits vollständig gutgeschrieben.';
  return null;
};

/** Why an invoice cannot get a revision, or null when it can (same rules as issuing it). */
export const revisionBlocker = (source: ChainDocumentLike, documents: ReadonlyArray<ChainDocumentLike>): string | null => {
  if (source.status === 'draft') return 'Nur gestellte Rechnungen können überarbeitet werden.';
  if (!isReceivableDocumentKind(source.documentKind)) return 'Nur Rechnungen können überarbeitet werden; Auftragsbestätigungen, Lieferscheine, Gutschriften und Stornos nicht.';
  if (source.documentKind === 'final_invoice') return 'Eine Schlussrechnung wird über Gutschrift oder Storno korrigiert, nicht über eine Revision.';
  if (source.status === 'cancelled') return 'Die Rechnung ist storniert und kann nicht überarbeitet werden.';
  if (source.status === 'paid' || (source.payments?.length ?? 0) > 0) return 'Bezahlte Rechnungen werden über Gutschrift oder Storno korrigiert, nicht über eine Revision.';
  if (documents.some((candidate) => candidate.sourceDocumentId === source.id && isCorrectionDocumentKind(candidate.documentKind) && candidate.status !== 'draft')) {
    return 'Zu dieser Rechnung gibt es bereits eine Gutschrift oder Stornorechnung.';
  }
  return null;
};

const auditCreate = (scope: TenantScope, dependencies: ChainDependencies, document: Invoice, reason: string, actor?: AuditActor) => {
  dependencies.auditLog.append(scope, {
    occurredAt: new Date().toISOString(),
    action: 'invoice.chain.create',
    reason,
    actor: actor ?? defaultActor,
    subject: { entityType: 'invoice', entityId: document.id, tenantId: scope.tenantId },
    change: { before: null, after: document },
  });
};

const copyParty = (
  source: Invoice | Offer,
  params: DocumentChainCreateParams,
  items: BillingLineItem[],
  amount: number,
  taxSnapshot = amount === 0 ? undefined : calculateInvoiceTaxSnapshot(
    { items, taxMode: source.taxMode, taxMeta: source.taxMeta },
    { legal: { defaultVatRate: source.taxSnapshot?.vatRateApplied } },
  ),
): Invoice => {
  if (taxSnapshot && cents(taxSnapshot.grossAmount) !== cents(amount)) {
    throw new DocumentChainError('Der gewünschte Bruttobetrag lässt sich mit diesen Positionen und Steuersätzen nicht centgenau abrechnen. Bitte die Positionen anpassen.');
  }
  return {
    kind: 'invoice',
    documentKind: 'invoice',
    revisionNumber: 0,
    tenantId: source.tenantId,
    id: params.id,
    clientId: source.clientId,
    clientNumber: source.clientNumber,
    projectId: source.projectId,
    number: params.number,
    client: source.client,
    clientEmail: source.clientEmail,
    clientAddress: source.clientAddress,
    billingAddress: source.billingAddress,
    shippingAddress: source.shippingAddress,
    taxMode: source.taxMode,
    taxMeta: source.taxMeta,
    taxSnapshot,
    date: params.date,
    dueDate: params.dueDate ?? params.date,
    // §14 Abs. 4 Nr. 6 UStG: a follow-up document keeps the source's Leistungszeitpunkt unless one is given.
    servicePeriod: params.servicePeriod ?? ('servicePeriod' in source ? source.servicePeriod : undefined),
    amount,
    status: 'draft',
    dunningLevel: 0,
    items,
    payments: [],
    history: [],
  };
};

/** A revision keeps the chosen template and texts; it is issued anew, so no snapshot. */
const revisionLayout = (source: Invoice): Invoice['layout'] => {
  if (!source.layout) return undefined;
  const { snapshot: _snapshot, ...layout } = source.layout;
  return Object.keys(layout).length > 0 ? layout : undefined;
};

const saveNew = (scope: TenantScope, dependencies: ChainDependencies, document: Invoice, reason: string, actor?: AuditActor): Invoice => {
  const saved = dependencies.invoiceRepo.save(scope, document);
  auditCreate(scope, dependencies, saved, reason, actor);
  return saved;
};

const formatEuro = (value: number): string =>
  `${new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} €`;
const formatDay = (isoDate: string): string => {
  const [year, month, day] = isoDate.slice(0, 10).split('-');
  return year && month && day ? `${day}.${month}.${year}` : isoDate;
};
const textLine = (description: string): BillingLineItem => ({ kind: 'text', description, quantity: 0, price: 0, total: 0 }) as BillingLineItem;

const SETTLEMENT_TITLES: Record<SettlementInvoiceKind, string> = {
  advance_invoice: 'Abschlagsrechnung',
  partial_invoice: 'Teilrechnung',
  final_invoice: 'Schlussrechnung',
};

/**
 * §14 Abs. 5 UStG: the final invoice states the whole order and deducts every
 * earlier settlement invoice with its tax. Lines: the full order, then one
 * deduction per earlier invoice and tax rate. The tax is the order's tax minus
 * the tax already invoiced, per rate, so the gross equals the remaining amount
 * to the cent instead of being re-rounded from the net.
 */
const finalInvoiceBody = (order: Invoice, earlier: Invoice[]): { items: BillingLineItem[]; taxSnapshot: Invoice['taxSnapshot'] } => {
  const orderSnapshot = order.taxSnapshot;
  if (!orderSnapshot) throw new DocumentChainError('Die Auftragsbestätigung hat keine Steuerberechnung; eine Schlussrechnung ist nicht möglich.');
  const byRate = new Map<number, { net: number; vat: number }>();
  for (const entry of orderSnapshot.vatBreakdown ?? [{ rate: orderSnapshot.vatRateApplied, netAmount: orderSnapshot.netAmount, vatAmount: orderSnapshot.vatAmount }]) {
    byRate.set(entry.rate, { net: cents(entry.netAmount), vat: cents(entry.vatAmount) });
  }
  const deductions: BillingLineItem[] = [];
  const chronological = [...earlier].sort((left, right) => `${left.date} ${left.number}`.localeCompare(`${right.date} ${right.number}`, 'de', { numeric: true }));
  for (const document of chronological) {
    const breakdown = document.taxSnapshot?.vatBreakdown ?? [];
    for (const entry of breakdown) {
      const current = byRate.get(entry.rate) ?? { net: 0, vat: 0 };
      byRate.set(entry.rate, { net: current.net - cents(entry.netAmount), vat: current.vat - cents(entry.vatAmount) });
      deductions.push({
        kind: 'item',
        description: `Abzüglich ${SETTLEMENT_TITLES[document.documentKind as SettlementInvoiceKind] ?? 'Rechnung'} ${document.number} vom ${formatDay(document.date)} (netto ${formatEuro(entry.netAmount)} zzgl. ${entry.rate} % USt ${formatEuro(entry.vatAmount)})`,
        quantity: 1,
        price: -entry.netAmount,
        total: -entry.netAmount,
        taxRate: entry.rate,
      } as BillingLineItem);
    }
  }
  const vatBreakdown = [...byRate.entries()].map(([rate, value]) => ({ rate, netAmount: value.net / 100, vatAmount: value.vat / 100 }));
  const netAmount = vatBreakdown.reduce((sum, entry) => sum + cents(entry.netAmount), 0) / 100;
  const vatAmount = vatBreakdown.reduce((sum, entry) => sum + cents(entry.vatAmount), 0) / 100;
  const items: BillingLineItem[] = [
    textLine(`Schlussrechnung zur Auftragsbestätigung ${order.number} vom ${formatDay(order.date)}: Gesamtauftrag netto ${formatEuro(orderSnapshot.netAmount)} zzgl. USt ${formatEuro(orderSnapshot.vatAmount)} = ${formatEuro(order.amount)}.`),
    ...order.items,
    ...(deductions.length ? [textLine('Bereits abgerechnet:'), ...deductions] : []),
  ];
  return { items, taxSnapshot: { ...orderSnapshot, vatBreakdown, netAmount, vatAmount, grossAmount: (cents(netAmount) + cents(vatAmount)) / 100 } };
};

// ---- pure builders shared by the sync (demo) and async (server) paths --------------------

const buildOrderConfirmation = (offer: Offer, documents: Invoice[], params: CreateOrderConfirmationParams): Invoice => {
  const blocker = orderConfirmationBlocker(offer, documents);
  if (blocker) throw new DocumentChainError(blocker, acceptedOffer(offer) ? 'DOCUMENT_CHAIN_CONFLICT' : 'DOCUMENT_CHAIN_INVALID');
  const document = copyParty(offer, params, offer.items, euros(offer.amount));
  return { ...document, documentKind: 'order_confirmation', sourceDocumentId: offer.id, rootDocumentId: params.id };
};

const requireOrder = (order: Invoice | null): Invoice => {
  if (!order || order.documentKind !== 'order_confirmation') throw new DocumentChainError('Auftragsbestätigung nicht gefunden.', 'DOCUMENT_CHAIN_NOT_FOUND');
  return order;
};

const buildDeliveryNote = (order: Invoice, params: CreateDeliveryNoteParams): Invoice => {
  const document = copyParty(order, params, params.items ?? order.items, 0);
  return { ...document, documentKind: 'delivery_note', sourceDocumentId: order.id, rootDocumentId: order.rootDocumentId ?? order.id };
};

const buildSettlement = (order: Invoice, documents: Invoice[], params: CreateSettlementInvoiceParams): Invoice => {
  const { remaining, total, finalIssued } = orderSettlement(documents, order);
  if (finalIssued) throw new DocumentChainError('Für diesen Auftrag gibt es bereits eine Schlussrechnung.');
  const amount = positiveAmount(params.amount, 'Der Rechnungsbetrag');
  if (cents(amount) > cents(remaining)) throw new DocumentChainError(`Der Betrag ist höher als der offene Auftragsbetrag (${remaining.toFixed(2)} €).`);
  if (params.kind === 'final_invoice' && cents(amount) !== cents(remaining)) {
    throw new DocumentChainError(`Die Schlussrechnung muss den offenen Auftragsbetrag (${remaining.toFixed(2)} €) abrechnen.`);
  }
  let document: Invoice;
  if (params.items) {
    document = copyParty(order, params, params.items, amount);
  } else if (params.kind === 'final_invoice') {
    const body = finalInvoiceBody(order, billedSettlements(documents, order.id));
    document = copyParty(order, params, body.items, amount, body.taxSnapshot);
  } else {
    const percent = total > 0 ? Math.round((amount / total) * 1000) / 10 : 0;
    const items = [
      textLine(`${SETTLEMENT_TITLES[params.kind]} zur Auftragsbestätigung ${order.number} vom ${formatDay(order.date)}: ${formatEuro(amount)} von ${formatEuro(total)} (${String(percent).replace('.', ',')} %).`),
      ...scaleLineItems(order.items, order.amount, amount),
    ];
    document = copyParty(order, params, items, amount);
  }
  return { ...document, documentKind: params.kind, sourceDocumentId: order.id, rootDocumentId: order.rootDocumentId ?? order.id };
};

const CORRECTION_TITLES: Record<CorrectionDocumentKind, string> = { credit_note: 'Gutschrift', cancellation_invoice: 'Stornorechnung' };

/**
 * Lines for correcting a document whose own lines cannot be prorated (a final
 * invoice with deductions): one line per tax rate, the gross split by the
 * source's gross per rate, each net chosen so net + rounded tax hits the cent.
 */
const breakdownLines = (source: Invoice, amount: number): BillingLineItem[] => {
  const breakdown = (source.taxSnapshot?.vatBreakdown ?? []).filter((entry) => cents(entry.netAmount) !== 0);
  if (!breakdown.length) throw new DocumentChainError('Die Rechnung hat keine Steueraufteilung; bitte die Positionen der Korrektur angeben.');
  const sourceGross = breakdown.reduce((sum, entry) => sum + cents(entry.netAmount) + cents(entry.vatAmount), 0);
  let left = cents(amount);
  return breakdown.map((entry, index) => {
    const gross = index === breakdown.length - 1
      ? left
      : Math.round(cents(amount) * (cents(entry.netAmount) + cents(entry.vatAmount)) / sourceGross);
    left -= gross;
    const estimate = Math.round(gross / (1 + entry.rate / 100));
    const net = [0, -1, 1, -2, 2].map((delta) => estimate + delta).find((candidate) => candidate + Math.round(candidate * entry.rate / 100) === gross);
    if (net === undefined) throw new DocumentChainError('Der gewünschte Bruttobetrag lässt sich mit diesen Steuersätzen nicht centgenau abrechnen. Bitte einen anderen Betrag wählen.');
    return { kind: 'item', description: `Anteilig ${entry.rate} % USt`, quantity: 1, price: net / 100, total: net / 100, taxRate: entry.rate } as BillingLineItem;
  });
};

const buildCorrection = (source: Invoice, documents: Invoice[], params: CreateCorrectionParams): Invoice => {
  const blocker = correctionBlocker(source, documents, params.kind);
  if (blocker) throw new DocumentChainError(blocker);
  const amount = positiveAmount(params.amount ?? source.amount, 'Der Korrekturbetrag');
  if (cents(amount) > cents(source.amount)) throw new DocumentChainError('Der Korrekturbetrag ist höher als der Rechnungsbetrag.');
  if (params.kind === 'cancellation_invoice' && cents(amount) !== cents(source.amount)) {
    throw new DocumentChainError('Eine Stornorechnung muss die ursprüngliche Rechnung vollständig aufheben.');
  }
  if (cents(amount) > cents(correctableAmount(source, documents))) {
    throw new DocumentChainError(`Alle Korrekturen zusammen wären höher als der Rechnungsbetrag (${source.amount.toFixed(2)} €).`);
  }
  const items = params.items ?? [
    textLine(`${CORRECTION_TITLES[params.kind]} zur Rechnung ${source.number} vom ${formatDay(source.date)}${params.kind === 'credit_note' && cents(amount) !== cents(source.amount) ? ` über ${formatEuro(amount)} von ${formatEuro(source.amount)}` : ''}.`),
    // A final invoice with deduction lines cannot be prorated line by line; correct it per tax rate.
    ...(source.items.some((line) => isBillable(line) && line.price < 0) ? breakdownLines(source, amount) : scaleLineItems(source.items, source.amount, amount)),
  ];
  const document = copyParty(source, params, items, amount);
  return { ...document, documentKind: params.kind, sourceDocumentId: source.id, rootDocumentId: source.rootDocumentId ?? source.id };
};

const buildRevision = (source: Invoice, documents: Invoice[], params: CreateRevisionParams): Invoice => {
  const blocker = revisionBlocker(source, documents);
  if (blocker) throw new DocumentChainError(blocker);
  const revisions = documents.filter((candidate) => candidate.revisionOfId === source.id);
  const document = copyParty(source, params, source.items, source.amount);
  return {
    ...document,
    layout: revisionLayout(source),
    documentKind: source.documentKind ?? 'invoice',
    sourceDocumentId: source.id,
    rootDocumentId: source.rootDocumentId ?? source.id,
    revisionOfId: source.id,
    revisionNumber: revisions.reduce((max, candidate) => Math.max(max, candidate.revisionNumber ?? 0), 0) + 1,
  };
};

const requireFound = <T>(value: T | null, message: string): T => {
  if (!value) throw new DocumentChainError(message, 'DOCUMENT_CHAIN_NOT_FOUND');
  return value;
};

// ---- sync API (demo mock engine) ----------------------------------------------------------

/** Returns the order total and the amount already billed below that order root. */
export const getOrderSettlement = (scope: TenantScope, dependencies: ChainDependencies, orderId: string) => {
  const order = requireOrder(dependencies.invoiceRepo.getById(scope, orderId));
  return { order, ...orderSettlement(dependencies.invoiceRepo.list(scope), order) };
};

export const createOrderConfirmationFromOffer = (scope: TenantScope, dependencies: ChainDependencies, params: CreateOrderConfirmationParams): Invoice => {
  const offer = requireFound(dependencies.offerRepo.getById(scope, params.offerId), 'Angebot nicht gefunden.');
  return saveNew(scope, dependencies, buildOrderConfirmation(offer, dependencies.invoiceRepo.list(scope), params), requireReason(params.reason), params.actor);
};

export const createDeliveryNoteFromOrder = (scope: TenantScope, dependencies: ChainDependencies, params: CreateDeliveryNoteParams): Invoice => {
  const order = requireOrder(dependencies.invoiceRepo.getById(scope, params.orderId));
  return saveNew(scope, dependencies, buildDeliveryNote(order, params), requireReason(params.reason), params.actor);
};

export const createSettlementInvoice = (scope: TenantScope, dependencies: ChainDependencies, params: CreateSettlementInvoiceParams): Invoice => {
  const order = requireOrder(dependencies.invoiceRepo.getById(scope, params.orderId));
  return saveNew(scope, dependencies, buildSettlement(order, dependencies.invoiceRepo.list(scope), params), requireReason(params.reason), params.actor);
};

export const createCorrectionDocument = (scope: TenantScope, dependencies: ChainDependencies, params: CreateCorrectionParams): Invoice => {
  const source = requireFound(dependencies.invoiceRepo.getById(scope, params.invoiceId), 'Rechnung nicht gefunden.');
  return saveNew(scope, dependencies, buildCorrection(source, dependencies.invoiceRepo.list(scope), params), requireReason(params.reason), params.actor);
};

export const createInvoiceRevision = (scope: TenantScope, dependencies: ChainDependencies, params: CreateRevisionParams): Invoice => {
  const source = requireFound(dependencies.invoiceRepo.getById(scope, params.invoiceId), 'Rechnung nicht gefunden.');
  return saveNew(scope, dependencies, buildRevision(source, dependencies.invoiceRepo.list(scope), params), requireReason(params.reason), params.actor);
};

export const listDocumentChain = (scope: TenantScope, dependencies: ChainDependencies, rootDocumentId: string): Invoice[] => {
  return dependencies.invoiceRepo.list(scope).filter((document) => document.id === rootDocumentId || document.rootDocumentId === rootDocumentId);
};

export const listInvoiceRevisions = (scope: TenantScope, dependencies: ChainDependencies, invoiceId: string): Invoice[] => {
  return dependencies.invoiceRepo.list(scope).filter((document) => document.revisionOfId === invoiceId);
};

// ---- async API (hosted Postgres repositories) ---------------------------------------------

const asyncSaveNew = async (scope: TenantScope, dependencies: AsyncChainDependencies, document: Invoice, reason: string, actor?: AuditActor): Promise<Invoice> => {
  const saved = await dependencies.invoiceRepo.save(scope, document);
  await dependencies.auditLog.append(scope, {
    occurredAt: new Date().toISOString(),
    action: 'invoice.chain.create',
    reason,
    actor: actor ?? defaultActor,
    subject: { entityType: 'invoice', entityId: saved.id, tenantId: scope.tenantId },
    change: { before: null, after: saved },
  });
  return saved;
};

export const createOrderConfirmationFromOfferAsync = async (scope: TenantScope, dependencies: AsyncChainDependencies, params: CreateOrderConfirmationParams): Promise<Invoice> => {
  const offer = requireFound(await dependencies.offerRepo.getById(scope, params.offerId), 'Angebot nicht gefunden.');
  return asyncSaveNew(scope, dependencies, buildOrderConfirmation(offer, await dependencies.invoiceRepo.list(scope), params), requireReason(params.reason), params.actor);
};

export const createDeliveryNoteFromOrderAsync = async (scope: TenantScope, dependencies: AsyncChainDependencies, params: CreateDeliveryNoteParams): Promise<Invoice> => {
  const order = requireOrder(await dependencies.invoiceRepo.getById(scope, params.orderId));
  return asyncSaveNew(scope, dependencies, buildDeliveryNote(order, params), requireReason(params.reason), params.actor);
};

export const createSettlementInvoiceAsync = async (scope: TenantScope, dependencies: AsyncChainDependencies, params: CreateSettlementInvoiceParams): Promise<Invoice> => {
  const order = requireOrder(await dependencies.invoiceRepo.getById(scope, params.orderId));
  return asyncSaveNew(scope, dependencies, buildSettlement(order, await dependencies.invoiceRepo.list(scope), params), requireReason(params.reason), params.actor);
};

export const createCorrectionDocumentAsync = async (scope: TenantScope, dependencies: AsyncChainDependencies, params: CreateCorrectionParams): Promise<Invoice> => {
  const source = requireFound(await dependencies.invoiceRepo.getById(scope, params.invoiceId), 'Rechnung nicht gefunden.');
  return asyncSaveNew(scope, dependencies, buildCorrection(source, await dependencies.invoiceRepo.list(scope), params), requireReason(params.reason), params.actor);
};

export const createInvoiceRevisionAsync = async (scope: TenantScope, dependencies: AsyncChainDependencies, params: CreateRevisionParams): Promise<Invoice> => {
  const source = requireFound(await dependencies.invoiceRepo.getById(scope, params.invoiceId), 'Rechnung nicht gefunden.');
  return asyncSaveNew(scope, dependencies, buildRevision(source, await dependencies.invoiceRepo.list(scope), params), requireReason(params.reason), params.actor);
};

export const listDocumentChainAsync = async (scope: TenantScope, dependencies: AsyncChainDependencies, rootDocumentId: string): Promise<Invoice[]> => (await dependencies.invoiceRepo.list(scope)).filter((document) => document.id === rootDocumentId || document.rootDocumentId === rootDocumentId);
export const listInvoiceRevisionsAsync = async (scope: TenantScope, dependencies: AsyncChainDependencies, invoiceId: string): Promise<Invoice[]> => (await dependencies.invoiceRepo.list(scope)).filter((document) => document.revisionOfId === invoiceId);
export const createCreditNoteAsync = (scope: TenantScope, dependencies: AsyncChainDependencies, params: Omit<CreateCorrectionParams, 'kind'>) => createCorrectionDocumentAsync(scope, dependencies, { ...params, kind: 'credit_note' });
export const createCancellationInvoiceAsync = (scope: TenantScope, dependencies: AsyncChainDependencies, params: Omit<CreateCorrectionParams, 'kind'>) => createCorrectionDocumentAsync(scope, dependencies, { ...params, kind: 'cancellation_invoice' });

// Intention-revealing aliases for adapters and callers.
export const createCreditNote = (scope: TenantScope, dependencies: ChainDependencies, params: Omit<CreateCorrectionParams, 'kind'>) => createCorrectionDocument(scope, dependencies, { ...params, kind: 'credit_note' });
export const createCancellationInvoice = (scope: TenantScope, dependencies: ChainDependencies, params: Omit<CreateCorrectionParams, 'kind'>) => createCorrectionDocument(scope, dependencies, { ...params, kind: 'cancellation_invoice' });
export const createAdvanceInvoice = (scope: TenantScope, dependencies: ChainDependencies, params: Omit<CreateSettlementInvoiceParams, 'kind'>) => createSettlementInvoice(scope, dependencies, { ...params, kind: 'advance_invoice' });
export const createPartialInvoice = (scope: TenantScope, dependencies: ChainDependencies, params: Omit<CreateSettlementInvoiceParams, 'kind'>) => createSettlementInvoice(scope, dependencies, { ...params, kind: 'partial_invoice' });
export const createFinalInvoice = (scope: TenantScope, dependencies: ChainDependencies, params: Omit<CreateSettlementInvoiceParams, 'kind'>) => createSettlementInvoice(scope, dependencies, { ...params, kind: 'final_invoice' });
