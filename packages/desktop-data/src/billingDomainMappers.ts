// Pure mapping between the desktop's legacy document shape and the server-core
// domain model. Kept free of SQLite/Drizzle imports so the browser shells
// (liteHttpApi, proHttpApi) can use it without bundling better-sqlite3;
// billingDomainCompat re-exports it next to the SQLite repositories.
import { z } from "zod";
import {
  createSingleTenantScope,
  billingLineItemSchema,
  type AuditEntry,
  type AuditEntryDraft,
  type AuditSubject,
  type BillingAddress,
  type Invoice,
  type InvoiceTaxMeta,
  type InvoiceTaxSnapshot,
  type Offer,
  type OfferDecision,
  type ServerProduct,
  type TenantScope,
} from "@billme/server-core";
import { AddressSchema } from "./addressSchema";

export interface LegacyInvoiceItem {
  description: string;
  quantity: number;
  price: number;
  total: number;
  articleId?: string;
  category?: string;
  unit?: string;
  discountPercent?: number;
  taxRate?: number;
  kind?: 'item' | 'time' | 'optional' | 'text' | 'group' | 'summary';
  note?: string;
  optionNote?: string;
  date?: string;
  durationMinutes?: number;
  groupId?: string;
  summaryScope?: 'running' | 'group';
  summaryMetric?: 'amount' | 'quantity';
  summaryUnit?: string;
}

export interface LegacyPayment {
  id: string;
  date: string;
  amount: number;
  method: string;
}

export interface LegacyInvoiceDocument {
  id: string;
  clientId?: string;
  clientNumber?: string;
  projectId?: string;
  number: string;
  numberReservationId?: string;
  documentKind?: Invoice['documentKind'];
  sourceDocumentId?: string;
  rootDocumentId?: string;
  revisionOfId?: string;
  revisionNumber?: number;
  client: string;
  clientEmail: string;
  clientAddress?: string;
  billingAddressJson?: unknown;
  shippingAddressJson?: unknown;
  taxMode?: Invoice["taxMode"];
  taxMeta?: InvoiceTaxMeta;
  taxSnapshot?: InvoiceTaxSnapshot;
  shareToken?: string | null;
  sharePublishedAt?: string | null;
  shareDecision?: OfferDecision | null;
  shareDecisionTextVersion?: string | null;
  acceptedAt?: string | null;
  acceptedBy?: string | null;
  acceptedEmail?: string | null;
  acceptedUserAgent?: string | null;
  date: string;
  dueDate: string;
  servicePeriod?: string;
  amount: number;
  status: string;
  dunningLevel?: number;
  items: LegacyInvoiceItem[];
  payments: LegacyPayment[];
  history?: Array<{ date: string; action: string }>;
}

export interface SqliteInvoiceRepository {
  list(scope: TenantScope): Invoice[];
  getById(scope: TenantScope, id: string): Invoice | null;
  save(scope: TenantScope, invoice: Invoice): Invoice;
  remove(scope: TenantScope, id: string): void;
}

export interface SqliteOfferRepository {
  list(scope: TenantScope): Offer[];
  getById(scope: TenantScope, id: string): Offer | null;
  save(scope: TenantScope, offer: Offer): Offer;
  remove(scope: TenantScope, id: string): void;
}

export interface SqliteAuditLogPort {
  append(scope: TenantScope, entry: AuditEntryDraft): AuditEntry;
  listBySubject(scope: TenantScope, subject: AuditSubject): AuditEntry[];
}

export const parseJson = <T>(value: string | null, fallback: T): T => {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export const StoredLineMetaSchema = z.object({
  kind: z.enum(['item', 'time', 'optional', 'text', 'group', 'summary']).optional(),
  note: z.string().optional(),
  optionNote: z.string().optional(),
  date: z.string().optional(),
  durationMinutes: z.number().nonnegative().optional(),
  groupId: z.string().optional(),
  summaryScope: z.enum(['running', 'group']).optional(),
  summaryMetric: z.enum(['amount', 'quantity']).optional(),
  summaryUnit: z.string().optional(),
});
export type StoredLineMeta = z.infer<typeof StoredLineMetaSchema>;

export const normalizeLine = (value: LegacyInvoiceItem) => billingLineItemSchema.parse({
  ...value,
  ...(value.kind ? { kind: value.kind } : {}),
});

const extractLineMeta = (item: Invoice['items'][number]): StoredLineMeta => {
  const common: StoredLineMeta = { kind: item.kind, note: item.note };
  switch (item.kind) {
    case 'optional': return { ...common, optionNote: item.optionNote };
    case 'time': return { ...common, date: item.date, durationMinutes: item.durationMinutes };
    case 'group': return { ...common, groupId: item.groupId };
    case 'summary': return { ...common, summaryScope: item.summaryScope, summaryMetric: item.summaryMetric, summaryUnit: item.summaryUnit };
    default: return common;
  }
};

export const toLegacyLine = (item: Invoice['items'][number]): LegacyInvoiceItem => ({
  description: item.description,
  quantity: item.quantity,
  price: item.price,
  total: item.total,
  articleId: item.articleId,
  category: item.category,
  unit: item.unit,
  discountPercent: item.discountPercent,
  taxRate: item.taxRate,
  ...extractLineMeta(item),
});

const normalizeBillingAddress = (
  value: unknown,
): BillingAddress | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }

  const parsed = AddressSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data as BillingAddress;
  }

  return undefined;
};


export const createBillingScope = (product: ServerProduct): TenantScope => {
  return createSingleTenantScope("default", product);
};

export const toDomainInvoice = (
  scope: TenantScope,
  invoice: LegacyInvoiceDocument,
): Invoice => {
  return {
    kind: "invoice",
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
    billingAddress: normalizeBillingAddress(invoice.billingAddressJson),
    shippingAddress: normalizeBillingAddress(invoice.shippingAddressJson),
    taxMode: invoice.taxMode ?? "standard_vat",
    taxMeta: invoice.taxMeta,
    taxSnapshot: invoice.taxSnapshot,
    date: invoice.date,
    dueDate: invoice.dueDate,
    servicePeriod: invoice.servicePeriod,
    amount: invoice.amount,
    status: invoice.status as Invoice["status"],
    dunningLevel: invoice.dunningLevel,
    items: (invoice.items ?? []).map((item) => normalizeLine({
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
      optionNote: item.optionNote,
      date: item.date,
      durationMinutes: item.durationMinutes,
      groupId: item.groupId,
      summaryScope: item.summaryScope,
      summaryMetric: item.summaryMetric,
      summaryUnit: item.summaryUnit,
    })),
    payments: (invoice.payments ?? []).map((payment) => ({
      id: payment.id,
      date: payment.date,
      amount: payment.amount,
      method: payment.method,
    })),
    history: invoice.history ?? [],
  };
};

export const toDomainOffer = (
  scope: TenantScope,
  offer: LegacyInvoiceDocument,
): Offer => {
  const share =
    offer.shareToken ||
    offer.sharePublishedAt ||
    offer.shareDecision ||
    offer.shareDecisionTextVersion ||
    offer.acceptedAt ||
    offer.acceptedBy ||
    offer.acceptedEmail ||
    offer.acceptedUserAgent
      ? {
          token: offer.shareToken ?? undefined,
          publishedAt: offer.sharePublishedAt ?? undefined,
          decision: offer.shareDecision ?? undefined,
          decisionTextVersion: offer.shareDecisionTextVersion ?? undefined,
          acceptedAt: offer.acceptedAt ?? undefined,
          acceptedBy: offer.acceptedBy ?? undefined,
          acceptedEmail: offer.acceptedEmail ?? undefined,
          acceptedUserAgent: offer.acceptedUserAgent ?? undefined,
        }
      : undefined;

  return {
    kind: "offer",
    tenantId: scope.tenantId,
    id: offer.id,
    clientId: offer.clientId,
    clientNumber: offer.clientNumber,
    projectId: offer.projectId,
    number: offer.number,
    client: offer.client,
    clientEmail: offer.clientEmail,
    clientAddress: offer.clientAddress,
    billingAddress: normalizeBillingAddress(offer.billingAddressJson),
    shippingAddress: normalizeBillingAddress(offer.shippingAddressJson),
    taxMode: offer.taxMode ?? "standard_vat",
    taxMeta: offer.taxMeta,
    taxSnapshot: offer.taxSnapshot,
    date: offer.date,
    validUntil: offer.dueDate,
    amount: offer.amount,
    status: offer.status as Offer["status"],
    share,
    items: (offer.items ?? []).map((item) => normalizeLine({
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
      optionNote: item.optionNote,
      date: item.date,
      durationMinutes: item.durationMinutes,
      groupId: item.groupId,
      summaryScope: item.summaryScope,
      summaryMetric: item.summaryMetric,
      summaryUnit: item.summaryUnit,
    })),
    history: offer.history ?? [],
  };
};

export const toLegacyInvoice = (invoice: Invoice): LegacyInvoiceDocument => {
  return {
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
    payments: invoice.payments.map((payment) => ({
      id: payment.id,
      date: payment.date,
      amount: payment.amount,
      method: payment.method,
    })),
    history: invoice.history ?? [],
  };
};

export const toLegacyOffer = (offer: Offer): LegacyInvoiceDocument => {
  return {
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
  };
};
