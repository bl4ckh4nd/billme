import type { AuditActor } from '../ports/index.js';
import type { Invoice, InvoiceDocumentKind, Offer, TenantScope } from '../domain/foundations.js';
import type { MaybePromise } from '../ports/index.js';
import type { BillingLineItem } from '../domain/billing-lines.js';
import type { InvoiceOfferDomainDependencies } from './invoice-offer.js';

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

const defaultActor: AuditActor = { type: 'system', displayName: 'local' };
const cents = (value: number): number => Math.round(value * 100);
const euros = (value: number): number => cents(value) / 100;
const positiveAmount = (value: number, field: string): number => {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be greater than zero`);
  return euros(value);
};
const requireReason = (reason: string): string => {
  const normalized = reason.trim();
  if (!normalized) throw new Error('Document reason is required');
  return normalized;
};

const roundQuantity = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
const isBillable = (line: BillingLineItem): boolean => line.kind === 'item' || line.kind === 'time' || line.kind === undefined;

/**
 * Keep a partial document's immutable line snapshot consistent with the
 * requested gross amount. Structural and optional lines remain untouched;
 * billable lines are prorated while retaining their original price/tax rate.
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
    return {
      ...line,
      quantity: line.quantity ? roundQuantity(line.quantity * factor) : line.quantity,
      total: euros(line.total * factor),
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

const copyParty = (source: Invoice | Offer, params: DocumentChainCreateParams, items: BillingLineItem[], amount: number): Invoice => ({
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
  taxSnapshot: items === source.items && amount === source.amount ? source.taxSnapshot : undefined,
  date: params.date,
  dueDate: params.dueDate ?? params.date,
  servicePeriod: params.servicePeriod,
  amount,
  status: 'draft',
  dunningLevel: 0,
  items,
  payments: [],
  history: [],
});

const saveNew = (scope: TenantScope, dependencies: ChainDependencies, document: Invoice, reason: string, actor?: AuditActor): Invoice => {
  const saved = dependencies.invoiceRepo.save(scope, document);
  auditCreate(scope, dependencies, saved, reason, actor);
  return saved;
};

/** Returns the order total and the amount already billed below that order root. */
export const getOrderSettlement = (scope: TenantScope, dependencies: ChainDependencies, orderId: string) => {
  const order = dependencies.invoiceRepo.getById(scope, orderId);
  if (!order || order.documentKind !== 'order_confirmation') throw new Error('Order confirmation not found');
  const billedKinds: InvoiceDocumentKind[] = ['invoice', 'advance_invoice', 'partial_invoice', 'final_invoice'];
  const billed = dependencies.invoiceRepo
    .list(scope)
    .filter((candidate) => candidate.rootDocumentId === order.id && billedKinds.includes(candidate.documentKind ?? 'invoice'))
    .reduce((sum, candidate) => sum + candidate.amount, 0);
  const total = euros(order.amount);
  return { order, total, billed: euros(billed), remaining: Math.max(0, cents(total) - cents(billed)) / 100 };
};

export const createOrderConfirmationFromOffer = (
  scope: TenantScope,
  dependencies: ChainDependencies,
  params: CreateOrderConfirmationParams,
): Invoice => {
  const offer = dependencies.offerRepo.getById(scope, params.offerId);
  if (!offer) throw new Error('Offer not found');
  if (!acceptedOffer(offer)) throw new Error('Offer must be accepted before creating an order confirmation');
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
  if (!order || order.documentKind !== 'order_confirmation') throw new Error('Order confirmation not found');
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
  const amount = positiveAmount(params.amount, 'Invoice amount');
  if (cents(amount) > cents(remaining)) throw new Error(`Settlement exceeds remaining order amount (${remaining.toFixed(2)})`);
  if (params.kind === 'final_invoice' && cents(amount) !== cents(remaining)) {
    throw new Error(`Final invoice must settle the remaining order amount (${remaining.toFixed(2)})`);
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
  if (!source) throw new Error('Invoice not found');
  if (source.status === 'draft') throw new Error('Only finalized invoices can be corrected');
  if (['order_confirmation', 'delivery_note'].includes(source.documentKind ?? 'invoice')) throw new Error('Non-billing documents cannot be corrected');
  const amount = positiveAmount(params.amount ?? source.amount, 'Correction amount');
  if (cents(amount) > cents(source.amount)) throw new Error('Correction amount exceeds original invoice amount');
  if (params.kind === 'cancellation_invoice' && cents(amount) !== cents(source.amount)) {
    throw new Error('Cancellation invoice must reverse the complete original invoice');
  }
  const existingCorrections = dependencies.invoiceRepo
    .list(scope)
    .filter((candidate) => candidate.sourceDocumentId === source.id && ['credit_note', 'cancellation_invoice'].includes(candidate.documentKind ?? ''));
  if (existingCorrections.length > 0 && params.kind === 'cancellation_invoice') {
    throw new Error('Cancellation invoice cannot follow an existing correction');
  }
  if (existingCorrections.some((candidate) => candidate.documentKind === 'cancellation_invoice')) {
    throw new Error('Credit note cannot follow a cancellation invoice');
  }
  const correctedAmount = existingCorrections.reduce((sum, candidate) => sum + cents(candidate.amount), 0);
  if (correctedAmount + cents(amount) > cents(source.amount)) {
    throw new Error(`Correction total exceeds original invoice amount (${source.amount.toFixed(2)})`);
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
  if (!source) throw new Error('Invoice not found');
  if (source.status === 'draft') throw new Error('Only finalized invoices can be revised');
  const reason = requireReason(params.reason);
  const revisions = dependencies.invoiceRepo.list(scope).filter((candidate) => candidate.revisionOfId === source.id);
  const document = copyParty(source, params, source.items, source.amount);
  return saveNew(scope, dependencies, {
    ...document,
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
  if (!order || order.documentKind !== 'order_confirmation') throw new Error('Order confirmation not found');
  const billedKinds: InvoiceDocumentKind[] = ['invoice', 'advance_invoice', 'partial_invoice', 'final_invoice'];
  const all = await dependencies.invoiceRepo.list(scope);
  const billed = all.filter((candidate) => candidate.rootDocumentId === order.id && billedKinds.includes(candidate.documentKind ?? 'invoice'))
    .reduce((sum, candidate) => sum + candidate.amount, 0);
  const total = euros(order.amount);
  return { order, total, billed: euros(billed), remaining: Math.max(0, cents(total) - cents(billed)) / 100 };
};

export const createOrderConfirmationFromOfferAsync = async (scope: TenantScope, dependencies: AsyncChainDependencies, params: CreateOrderConfirmationParams): Promise<Invoice> => {
  const offer = await dependencies.offerRepo.getById(scope, params.offerId);
  if (!offer) throw new Error('Offer not found');
  if (!acceptedOffer(offer)) throw new Error('Offer must be accepted before creating an order confirmation');
  const document = copyParty(offer, params, offer.items, euros(offer.amount));
  return asyncSaveNew(scope, dependencies, { ...document, documentKind: 'order_confirmation', sourceDocumentId: offer.id, rootDocumentId: params.id }, requireReason(params.reason), params.actor);
};

export const createDeliveryNoteFromOrderAsync = async (scope: TenantScope, dependencies: AsyncChainDependencies, params: CreateDeliveryNoteParams): Promise<Invoice> => {
  const order = await dependencies.invoiceRepo.getById(scope, params.orderId);
  if (!order || order.documentKind !== 'order_confirmation') throw new Error('Order confirmation not found');
  const document = copyParty(order, params, params.items ?? order.items, 0);
  return asyncSaveNew(scope, dependencies, { ...document, documentKind: 'delivery_note', sourceDocumentId: order.id, rootDocumentId: order.rootDocumentId ?? order.id }, requireReason(params.reason), params.actor);
};

export const createSettlementInvoiceAsync = async (scope: TenantScope, dependencies: AsyncChainDependencies, params: CreateSettlementInvoiceParams): Promise<Invoice> => {
  const { order, remaining } = await asyncOrderSettlement(scope, dependencies, params.orderId);
  const amount = positiveAmount(params.amount, 'Invoice amount');
  if (cents(amount) > cents(remaining)) throw new Error(`Settlement exceeds remaining order amount (${remaining.toFixed(2)})`);
  if (params.kind === 'final_invoice' && cents(amount) !== cents(remaining)) throw new Error(`Final invoice must settle the remaining order amount (${remaining.toFixed(2)})`);
  const document = copyParty(order, params, params.items ?? scaleLineItems(order.items, order.amount, amount), amount);
  return asyncSaveNew(scope, dependencies, { ...document, documentKind: params.kind, sourceDocumentId: order.id, rootDocumentId: order.rootDocumentId ?? order.id }, requireReason(params.reason), params.actor);
};

export const createCorrectionDocumentAsync = async (scope: TenantScope, dependencies: AsyncChainDependencies, params: CreateCorrectionParams): Promise<Invoice> => {
  const source = await dependencies.invoiceRepo.getById(scope, params.invoiceId);
  if (!source) throw new Error('Invoice not found');
  if (source.status === 'draft') throw new Error('Only finalized invoices can be corrected');
  if (['order_confirmation', 'delivery_note'].includes(source.documentKind ?? 'invoice')) throw new Error('Non-billing documents cannot be corrected');
  const amount = positiveAmount(params.amount ?? source.amount, 'Correction amount');
  if (cents(amount) > cents(source.amount)) throw new Error('Correction amount exceeds original invoice amount');
  if (params.kind === 'cancellation_invoice' && cents(amount) !== cents(source.amount)) throw new Error('Cancellation invoice must reverse the complete original invoice');
  const existingCorrections = (await dependencies.invoiceRepo.list(scope))
    .filter((candidate) => candidate.sourceDocumentId === source.id && ['credit_note', 'cancellation_invoice'].includes(candidate.documentKind ?? ''));
  if (existingCorrections.length > 0 && params.kind === 'cancellation_invoice') throw new Error('Cancellation invoice cannot follow an existing correction');
  if (existingCorrections.some((candidate) => candidate.documentKind === 'cancellation_invoice')) throw new Error('Credit note cannot follow a cancellation invoice');
  const correctedAmount = existingCorrections.reduce((sum, candidate) => sum + cents(candidate.amount), 0);
  if (correctedAmount + cents(amount) > cents(source.amount)) throw new Error(`Correction total exceeds original invoice amount (${source.amount.toFixed(2)})`);
  const items = params.items ?? scaleLineItems(source.items, source.amount, amount);
  const document = copyParty(source, params, items, amount);
  return asyncSaveNew(scope, dependencies, { ...document, documentKind: params.kind, sourceDocumentId: source.id, rootDocumentId: source.rootDocumentId ?? source.id }, requireReason(params.reason), params.actor);
};

export const createInvoiceRevisionAsync = async (scope: TenantScope, dependencies: AsyncChainDependencies, params: CreateRevisionParams): Promise<Invoice> => {
  const source = await dependencies.invoiceRepo.getById(scope, params.invoiceId);
  if (!source) throw new Error('Invoice not found');
  if (source.status === 'draft') throw new Error('Only finalized invoices can be revised');
  const revisions = (await dependencies.invoiceRepo.list(scope)).filter((candidate) => candidate.revisionOfId === source.id);
  const document = copyParty(source, params, source.items, source.amount);
  return asyncSaveNew(scope, dependencies, { ...document, documentKind: source.documentKind ?? 'invoice', sourceDocumentId: source.id, rootDocumentId: source.rootDocumentId ?? source.id, revisionOfId: source.id, revisionNumber: revisions.reduce((max, candidate) => Math.max(max, candidate.revisionNumber ?? 0), 0) + 1 }, requireReason(params.reason), params.actor);
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
