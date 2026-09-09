import {
  billingLineItemSchema,
  createSingleTenantScope,
  type BillingAddress,
  type Invoice,
  type Offer,
  type ServerProduct,
  type TenantScope,
} from '@billme/server-core';
import { AddressSchema } from './validation-schemas';
import type { LegacyInvoiceDocument, LegacyInvoiceItem } from './billingDomainCompat';

const normalizeLine = (value: LegacyInvoiceItem) => billingLineItemSchema.parse(value);

const normalizeAddress = (value: unknown): BillingAddress | undefined => {
  if (value === undefined || value === null) return undefined;
  const parsed = AddressSchema.safeParse(value);
  return parsed.success ? parsed.data as BillingAddress : undefined;
};

const toLegacyLine = (item: Invoice['items'][number]): LegacyInvoiceItem => {
  const common = {
    description: item.description,
    quantity: item.quantity,
    price: item.price,
    total: item.total,
    articleId: item.articleId,
    category: item.category,
    unit: item.unit,
    discountPercent: item.discountPercent,
    taxRate: item.taxRate,
    kind: item.kind,
    note: item.note,
  };
  switch (item.kind) {
    case 'optional': return { ...common, optionNote: item.optionNote };
    case 'time': return { ...common, date: item.date, durationMinutes: item.durationMinutes };
    case 'group': return { ...common, groupId: item.groupId };
    case 'summary': return {
      ...common,
      summaryScope: item.summaryScope,
      summaryMetric: item.summaryMetric,
      summaryUnit: item.summaryUnit,
    };
    default: return common;
  }
};

export const createBillingScope = (product: ServerProduct): TenantScope =>
  createSingleTenantScope('default', product);

export const toDomainInvoice = (scope: TenantScope, invoice: LegacyInvoiceDocument): Invoice => ({
  kind: 'invoice',
  tenantId: scope.tenantId,
  id: invoice.id,
  clientId: invoice.clientId,
  clientNumber: invoice.clientNumber,
  projectId: invoice.projectId,
  number: invoice.number,
  documentKind: invoice.documentKind ?? 'invoice',
  sourceDocumentId: invoice.sourceDocumentId,
  rootDocumentId: invoice.rootDocumentId,
  revisionOfId: invoice.revisionOfId,
  revisionNumber: invoice.revisionNumber ?? 0,
  client: invoice.client,
  clientEmail: invoice.clientEmail,
  clientAddress: invoice.clientAddress,
  billingAddress: normalizeAddress(invoice.billingAddressJson),
  shippingAddress: normalizeAddress(invoice.shippingAddressJson),
  taxMode: invoice.taxMode ?? 'standard_vat',
  taxMeta: invoice.taxMeta,
  taxSnapshot: invoice.taxSnapshot,
  date: invoice.date,
  dueDate: invoice.dueDate,
  servicePeriod: invoice.servicePeriod,
  amount: invoice.amount,
  status: invoice.status as Invoice['status'],
  dunningLevel: invoice.dunningLevel,
  items: (invoice.items ?? []).map(normalizeLine),
  payments: (invoice.payments ?? []).map((payment) => ({ ...payment })),
  history: invoice.history ?? [],
});

export const toDomainOffer = (scope: TenantScope, offer: LegacyInvoiceDocument): Offer => {
  const hasShare = Boolean(
    offer.shareToken || offer.sharePublishedAt || offer.shareDecision || offer.shareDecisionTextVersion
    || offer.acceptedAt || offer.acceptedBy || offer.acceptedEmail || offer.acceptedUserAgent,
  );
  return {
    kind: 'offer',
    tenantId: scope.tenantId,
    id: offer.id,
    clientId: offer.clientId,
    clientNumber: offer.clientNumber,
    projectId: offer.projectId,
    number: offer.number,
    client: offer.client,
    clientEmail: offer.clientEmail,
    clientAddress: offer.clientAddress,
    billingAddress: normalizeAddress(offer.billingAddressJson),
    shippingAddress: normalizeAddress(offer.shippingAddressJson),
    taxMode: offer.taxMode ?? 'standard_vat',
    taxMeta: offer.taxMeta,
    taxSnapshot: offer.taxSnapshot,
    date: offer.date,
    validUntil: offer.dueDate,
    amount: offer.amount,
    status: offer.status as Offer['status'],
    share: hasShare ? {
      token: offer.shareToken ?? undefined,
      publishedAt: offer.sharePublishedAt ?? undefined,
      decision: offer.shareDecision ?? undefined,
      decisionTextVersion: offer.shareDecisionTextVersion ?? undefined,
      acceptedAt: offer.acceptedAt ?? undefined,
      acceptedBy: offer.acceptedBy ?? undefined,
      acceptedEmail: offer.acceptedEmail ?? undefined,
      acceptedUserAgent: offer.acceptedUserAgent ?? undefined,
    } : undefined,
    items: (offer.items ?? []).map(normalizeLine),
    history: offer.history ?? [],
  };
};

export const toLegacyInvoice = (invoice: Invoice): LegacyInvoiceDocument => ({
  id: invoice.id,
  clientId: invoice.clientId,
  clientNumber: invoice.clientNumber,
  projectId: invoice.projectId,
  number: invoice.number,
  documentKind: invoice.documentKind ?? 'invoice',
  sourceDocumentId: invoice.sourceDocumentId,
  rootDocumentId: invoice.rootDocumentId,
  revisionOfId: invoice.revisionOfId,
  revisionNumber: invoice.revisionNumber ?? 0,
  client: invoice.client,
  clientEmail: invoice.clientEmail,
  clientAddress: invoice.clientAddress,
  billingAddressJson: invoice.billingAddress,
  shippingAddressJson: invoice.shippingAddress,
  taxMode: invoice.taxMode,
  taxMeta: invoice.taxMeta,
  taxSnapshot: invoice.taxSnapshot,
  date: invoice.date,
  dueDate: invoice.dueDate,
  servicePeriod: invoice.servicePeriod,
  amount: invoice.amount,
  status: invoice.status,
  dunningLevel: invoice.dunningLevel,
  items: invoice.items.map(toLegacyLine),
  payments: invoice.payments.map((payment) => ({ ...payment })),
  history: invoice.history ?? [],
});

export const toLegacyOffer = (offer: Offer): LegacyInvoiceDocument => ({
  id: offer.id,
  clientId: offer.clientId,
  clientNumber: offer.clientNumber,
  projectId: offer.projectId,
  number: offer.number,
  client: offer.client,
  clientEmail: offer.clientEmail,
  clientAddress: offer.clientAddress,
  billingAddressJson: offer.billingAddress,
  shippingAddressJson: offer.shippingAddress,
  taxMode: offer.taxMode,
  taxMeta: offer.taxMeta,
  taxSnapshot: offer.taxSnapshot,
  shareToken: offer.share?.token ?? null,
  sharePublishedAt: offer.share?.publishedAt ?? null,
  shareDecision: offer.share?.decision ?? null,
  shareDecisionTextVersion: offer.share?.decisionTextVersion ?? null,
  acceptedAt: offer.share?.acceptedAt ?? null,
  acceptedBy: offer.share?.acceptedBy ?? null,
  acceptedEmail: offer.share?.acceptedEmail ?? null,
  acceptedUserAgent: offer.share?.acceptedUserAgent ?? null,
  date: offer.date,
  dueDate: offer.validUntil,
  amount: offer.amount,
  status: offer.status,
  items: offer.items.map(toLegacyLine),
  payments: [],
  history: offer.history ?? [],
});
