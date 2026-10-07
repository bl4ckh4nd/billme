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

const copyParty = (source: Invoice | Offer, params: DocumentChainCreateParams, items: BillingLineItem[], amount: number): Invoice => {
  const taxSnapshot = amount === 0 ? undefined : calculateInvoiceTaxSnapshot(
    { items, taxMode: source.taxMode, taxMeta: source.taxMeta },
    { legal: { defaultVatRate: source.taxSnapshot?.vatRateApplied } },
  );
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
    servicePeriod: params.servicePeriod,
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

const billedOrderAmount = (documents: Invoice[], orderId: string): number => {
  const cancelledIds = new Set(documents.filter((document) => document.documentKind === 'cancellation_invoice').map((document) => document.sourceDocumentId));
  const billedKinds: InvoiceDocumentKind[] = ['invoice', 'advance_invoice', 'partial_invoice', 'final_invoice'];
  return documents.filter((document) => document.rootDocumentId === orderId
    && billedKinds.includes(document.documentKind ?? 'invoice')
    && !cancelledIds.has(document.id))
    .reduce((sum, document) => sum + document.amount, 0);
};

/** Returns the order total and the amount already billed below that order root. */
export const getOrderSettlement = (scope: TenantScope, dependencies: ChainDependencies, orderId: string) => {
  const order = dependencies.invoiceRepo.getById(scope, orderId);
  if (!order || order.documentKind !== 'order_confirmation') throw new DocumentChainError('Auftragsbestätigung nicht gefunden.', 'DOCUMENT_CHAIN_NOT_FOUND');
  const billed = billedOrderAmount(dependencies.invoiceRepo.list(scope), order.id);
  const total = euros(order.amount);
  return { order, total, billed: euros(billed), remaining: Math.max(0, cents(total) - cents(billed)) / 100 };
};

export const createOrderConfirmationFromOffer = (
  scope: TenantScope,
  dependencies: ChainDependencies,
  params: CreateOrderConfirmationParams,
): Invoice => {
  const offer = dependencies.offerRepo.getById(scope, params.offerId);
  if (!offer) throw new DocumentChainError('Angebot nicht gefunden.', 'DOCUMENT_CHAIN_NOT_FOUND');
  if (!acceptedOffer(offer)) throw new DocumentChainError('Das Angebot muss angenommen sein, bevor eine Auftragsbestätigung erstellt wird.');
  if (dependencies.invoiceRepo.list(scope).some((document) => document.documentKind === 'order_confirmation' && document.sourceDocumentId === offer.id)) {
    throw new DocumentChainError('Für dieses Angebot besteht bereits eine Auftragsbestätigung.', 'DOCUMENT_CHAIN_CONFLICT');
  }
  const reason = requireReason(params.reason);
  const document = copyParty(offer, params, offer.items, euros(offer.amount));
  const result: Invoice = { ...document, documentKind: 'order_confirmation', sourceDocumentId: offer.id, rootDocumentId: params.id };
  return saveNew(scope, dependencies, result, reason, params.actor);
};

export const createDeliveryNoteFromOrder = (
  scope: TenantScope,
  dependencies: ChainDependencies,
  params: CreateDeliveryNoteParams,
): Invoice => {
  const order = dependencies.invoiceRepo.getById(scope, params.orderId);
  if (!order || order.documentKind !== 'order_confirmation') throw new DocumentChainError('Auftragsbestätigung nicht gefunden.', 'DOCUMENT_CHAIN_NOT_FOUND');
  const reason = requireReason(params.reason);
  const document = copyParty(order, params, params.items ?? order.items, 0);
  return saveNew(scope, dependencies, {
    ...document,
    documentKind: 'delivery_note',
    sourceDocumentId: order.id,
    rootDocumentId: order.rootDocumentId ?? order.id,
  }, reason, params.actor);
};

export const createSettlementInvoice = (
  scope: TenantScope,
  dependencies: ChainDependencies,
  params: CreateSettlementInvoiceParams,
): Invoice => {
  const { order, remaining } = getOrderSettlement(scope, dependencies, params.orderId);
  const amount = positiveAmount(params.amount, 'Der Rechnungsbetrag');
  if (cents(amount) > cents(remaining)) throw new DocumentChainError(`Der Betrag ist höher als der offene Auftragsbetrag (${remaining.toFixed(2)} €).`);
  if (params.kind === 'final_invoice' && cents(amount) !== cents(remaining)) {
    throw new DocumentChainError(`Die Schlussrechnung muss den offenen Auftragsbetrag (${remaining.toFixed(2)} €) abrechnen.`);
  }
  const reason = requireReason(params.reason);
  const document = copyParty(order, params, params.items ?? scaleLineItems(order.items, order.amount, amount), amount);
  return saveNew(scope, dependencies, {
    ...document,
    documentKind: params.kind,
    sourceDocumentId: order.id,
    rootDocumentId: order.rootDocumentId ?? order.id,
  }, reason, params.actor);
};

export const createCorrectionDocument = (
  scope: TenantScope,
  dependencies: ChainDependencies,
  params: CreateCorrectionParams,
): Invoice => {
  const source = dependencies.invoiceRepo.getById(scope, params.invoiceId);
  if (!source) throw new DocumentChainError('Rechnung nicht gefunden.', 'DOCUMENT_CHAIN_NOT_FOUND');
  if (source.status === 'draft') throw new DocumentChainError('Nur gestellte Rechnungen können korrigiert werden.');
  if (['order_confirmation', 'delivery_note'].includes(source.documentKind ?? 'invoice')) throw new DocumentChainError('Auftragsbestätigungen und Lieferscheine können nicht korrigiert werden.');
  const amount = positiveAmount(params.amount ?? source.amount, 'Der Korrekturbetrag');
  if (cents(amount) > cents(source.amount)) throw new DocumentChainError('Der Korrekturbetrag ist höher als der Rechnungsbetrag.');
  if (params.kind === 'cancellation_invoice' && cents(amount) !== cents(source.amount)) {
    throw new DocumentChainError('Eine Stornorechnung muss die ursprüngliche Rechnung vollständig aufheben.');
  }
  const existingCorrections = dependencies.invoiceRepo
    .list(scope)
    .filter((candidate) => candidate.sourceDocumentId === source.id && ['credit_note', 'cancellation_invoice'].includes(candidate.documentKind ?? ''));
  if (existingCorrections.length > 0 && params.kind === 'cancellation_invoice') {
    throw new DocumentChainError('Zu dieser Rechnung gibt es schon eine Gutschrift oder Stornorechnung; eine Stornorechnung ist nicht mehr möglich.');
  }
  if (existingCorrections.some((candidate) => candidate.documentKind === 'cancellation_invoice')) {
    throw new DocumentChainError('Die Rechnung ist bereits storniert; eine Gutschrift ist nicht mehr möglich.');
  }
  const correctedAmount = existingCorrections.reduce((sum, candidate) => sum + cents(candidate.amount), 0);
  if (correctedAmount + cents(amount) > cents(source.amount)) {
    throw new DocumentChainError(`Alle Korrekturen zusammen wären höher als der Rechnungsbetrag (${source.amount.toFixed(2)} €).`);
  }
  const reason = requireReason(params.reason);
  const items = params.items ?? scaleLineItems(source.items, source.amount, amount);
  const document = copyParty(source, params, items, amount);
  return saveNew(scope, dependencies, {
    ...document,
    documentKind: params.kind,
    sourceDocumentId: source.id,
    rootDocumentId: source.rootDocumentId ?? source.id,
  }, reason, params.actor);
};

export const createInvoiceRevision = (
  scope: TenantScope,
  dependencies: ChainDependencies,
  params: CreateRevisionParams,
): Invoice => {
  const source = dependencies.invoiceRepo.getById(scope, params.invoiceId);
  if (!source) throw new DocumentChainError('Rechnung nicht gefunden.', 'DOCUMENT_CHAIN_NOT_FOUND');
  if (source.status === 'draft') throw new DocumentChainError('Nur gestellte Rechnungen können überarbeitet werden.');
  const reason = requireReason(params.reason);
  const revisions = dependencies.invoiceRepo.list(scope).filter((candidate) => candidate.revisionOfId === source.id);
  const document = copyParty(source, params, source.items, source.amount);
  return saveNew(scope, dependencies, {
    ...document,
    layout: revisionLayout(source),
    documentKind: source.documentKind ?? 'invoice',
    sourceDocumentId: source.id,
    rootDocumentId: source.rootDocumentId ?? source.id,
    revisionOfId: source.id,
    revisionNumber: revisions.reduce((max, candidate) => Math.max(max, candidate.revisionNumber ?? 0), 0) + 1,
  }, reason, params.actor);
};

export const listDocumentChain = (scope: TenantScope, dependencies: ChainDependencies, rootDocumentId: string): Invoice[] => {
  return dependencies.invoiceRepo.list(scope).filter((document) => document.id === rootDocumentId || document.rootDocumentId === rootDocumentId);
};

export const listInvoiceRevisions = (scope: TenantScope, dependencies: ChainDependencies, invoiceId: string): Invoice[] => {
  return dependencies.invoiceRepo.list(scope).filter((document) => document.revisionOfId === invoiceId);
};

// Async counterparts keep the same rules usable by the hosted Postgres
// repositories, whose ports intentionally return MaybePromise values.
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

const asyncOrderSettlement = async (scope: TenantScope, dependencies: AsyncChainDependencies, orderId: string) => {
  const order = await dependencies.invoiceRepo.getById(scope, orderId);
  if (!order || order.documentKind !== 'order_confirmation') throw new DocumentChainError('Auftragsbestätigung nicht gefunden.', 'DOCUMENT_CHAIN_NOT_FOUND');
  const billed = billedOrderAmount(await dependencies.invoiceRepo.list(scope), order.id);
  const total = euros(order.amount);
  return { order, total, billed: euros(billed), remaining: Math.max(0, cents(total) - cents(billed)) / 100 };
};

export const createOrderConfirmationFromOfferAsync = async (scope: TenantScope, dependencies: AsyncChainDependencies, params: CreateOrderConfirmationParams): Promise<Invoice> => {
  const offer = await dependencies.offerRepo.getById(scope, params.offerId);
  if (!offer) throw new DocumentChainError('Angebot nicht gefunden.', 'DOCUMENT_CHAIN_NOT_FOUND');
  if (!acceptedOffer(offer)) throw new DocumentChainError('Das Angebot muss angenommen sein, bevor eine Auftragsbestätigung erstellt wird.');
  if ((await dependencies.invoiceRepo.list(scope)).some((document) => document.documentKind === 'order_confirmation' && document.sourceDocumentId === offer.id)) {
    throw new DocumentChainError('Für dieses Angebot besteht bereits eine Auftragsbestätigung.', 'DOCUMENT_CHAIN_CONFLICT');
  }
  const document = copyParty(offer, params, offer.items, euros(offer.amount));
  return asyncSaveNew(scope, dependencies, { ...document, documentKind: 'order_confirmation', sourceDocumentId: offer.id, rootDocumentId: params.id }, requireReason(params.reason), params.actor);
};

export const createDeliveryNoteFromOrderAsync = async (scope: TenantScope, dependencies: AsyncChainDependencies, params: CreateDeliveryNoteParams): Promise<Invoice> => {
  const order = await dependencies.invoiceRepo.getById(scope, params.orderId);
  if (!order || order.documentKind !== 'order_confirmation') throw new DocumentChainError('Auftragsbestätigung nicht gefunden.', 'DOCUMENT_CHAIN_NOT_FOUND');
  const document = copyParty(order, params, params.items ?? order.items, 0);
  return asyncSaveNew(scope, dependencies, { ...document, documentKind: 'delivery_note', sourceDocumentId: order.id, rootDocumentId: order.rootDocumentId ?? order.id }, requireReason(params.reason), params.actor);
};

export const createSettlementInvoiceAsync = async (scope: TenantScope, dependencies: AsyncChainDependencies, params: CreateSettlementInvoiceParams): Promise<Invoice> => {
  const { order, remaining } = await asyncOrderSettlement(scope, dependencies, params.orderId);
  const amount = positiveAmount(params.amount, 'Der Rechnungsbetrag');
  if (cents(amount) > cents(remaining)) throw new DocumentChainError(`Der Betrag ist höher als der offene Auftragsbetrag (${remaining.toFixed(2)} €).`);
  if (params.kind === 'final_invoice' && cents(amount) !== cents(remaining)) throw new DocumentChainError(`Die Schlussrechnung muss den offenen Auftragsbetrag (${remaining.toFixed(2)} €) abrechnen.`);
  const document = copyParty(order, params, params.items ?? scaleLineItems(order.items, order.amount, amount), amount);
  return asyncSaveNew(scope, dependencies, { ...document, documentKind: params.kind, sourceDocumentId: order.id, rootDocumentId: order.rootDocumentId ?? order.id }, requireReason(params.reason), params.actor);
};

export const createCorrectionDocumentAsync = async (scope: TenantScope, dependencies: AsyncChainDependencies, params: CreateCorrectionParams): Promise<Invoice> => {
  const source = await dependencies.invoiceRepo.getById(scope, params.invoiceId);
  if (!source) throw new DocumentChainError('Rechnung nicht gefunden.', 'DOCUMENT_CHAIN_NOT_FOUND');
  if (source.status === 'draft') throw new DocumentChainError('Nur gestellte Rechnungen können korrigiert werden.');
  if (['order_confirmation', 'delivery_note'].includes(source.documentKind ?? 'invoice')) throw new DocumentChainError('Auftragsbestätigungen und Lieferscheine können nicht korrigiert werden.');
  const amount = positiveAmount(params.amount ?? source.amount, 'Der Korrekturbetrag');
  if (cents(amount) > cents(source.amount)) throw new DocumentChainError('Der Korrekturbetrag ist höher als der Rechnungsbetrag.');
  if (params.kind === 'cancellation_invoice' && cents(amount) !== cents(source.amount)) throw new DocumentChainError('Eine Stornorechnung muss die ursprüngliche Rechnung vollständig aufheben.');
  const existingCorrections = (await dependencies.invoiceRepo.list(scope))
    .filter((candidate) => candidate.sourceDocumentId === source.id && ['credit_note', 'cancellation_invoice'].includes(candidate.documentKind ?? ''));
  if (existingCorrections.length > 0 && params.kind === 'cancellation_invoice') throw new DocumentChainError('Zu dieser Rechnung gibt es schon eine Gutschrift oder Stornorechnung; eine Stornorechnung ist nicht mehr möglich.');
  if (existingCorrections.some((candidate) => candidate.documentKind === 'cancellation_invoice')) throw new DocumentChainError('Die Rechnung ist bereits storniert; eine Gutschrift ist nicht mehr möglich.');
  const correctedAmount = existingCorrections.reduce((sum, candidate) => sum + cents(candidate.amount), 0);
  if (correctedAmount + cents(amount) > cents(source.amount)) throw new DocumentChainError(`Alle Korrekturen zusammen wären höher als der Rechnungsbetrag (${source.amount.toFixed(2)} €).`);
  const items = params.items ?? scaleLineItems(source.items, source.amount, amount);
  const document = copyParty(source, params, items, amount);
  return asyncSaveNew(scope, dependencies, { ...document, documentKind: params.kind, sourceDocumentId: source.id, rootDocumentId: source.rootDocumentId ?? source.id }, requireReason(params.reason), params.actor);
};

export const createInvoiceRevisionAsync = async (scope: TenantScope, dependencies: AsyncChainDependencies, params: CreateRevisionParams): Promise<Invoice> => {
  const source = await dependencies.invoiceRepo.getById(scope, params.invoiceId);
  if (!source) throw new DocumentChainError('Rechnung nicht gefunden.', 'DOCUMENT_CHAIN_NOT_FOUND');
  if (source.status === 'draft') throw new DocumentChainError('Nur gestellte Rechnungen können überarbeitet werden.');
  const revisions = (await dependencies.invoiceRepo.list(scope)).filter((candidate) => candidate.revisionOfId === source.id);
  const document = copyParty(source, params, source.items, source.amount);
  return asyncSaveNew(scope, dependencies, { ...document, layout: revisionLayout(source), documentKind: source.documentKind ?? 'invoice', sourceDocumentId: source.id, rootDocumentId: source.rootDocumentId ?? source.id, revisionOfId: source.id, revisionNumber: revisions.reduce((max, candidate) => Math.max(max, candidate.revisionNumber ?? 0), 0) + 1 }, requireReason(params.reason), params.actor);
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
