import type Database from "better-sqlite3";
import { and, asc, desc, eq } from "drizzle-orm";
import { createDrizzle, schema } from "./drizzle";
import {
  createSingleTenantScope,
  type AuditActor,
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
import { appendAuditLog } from "./audit";
import { AddressSchema, safeJsonParse } from "./validation-schemas";

type InvoiceRow = {
  id: string;
  client_id: string | null;
  client_number: string | null;
  project_id: string | null;
  number: string;
  client: string;
  client_email: string;
  client_address: string | null;
  billing_address_json: string | null;
  shipping_address_json: string | null;
  tax_mode: string | null;
  tax_meta_json: string | null;
  tax_snapshot_json: string | null;
  date: string;
  due_date: string;
  service_period: string | null;
  amount: number;
  status: string;
  dunning_level: number;
  created_at: string;
  updated_at: string;
};

type InvoiceItemRow = {
  invoice_id: string;
  position: number;
  description: string;
  article_id: string | null;
  category: string | null;
  unit: string | null;
  discount_percent: number | null;
  tax_rate: number | null;
  quantity: number;
  price: number;
  total: number;
};

type InvoicePaymentRow = {
  id: string;
  invoice_id: string;
  date: string;
  amount: number;
  method: string;
};

type OfferRow = {
  id: string;
  client_id: string | null;
  client_number: string | null;
  project_id: string | null;
  number: string;
  client: string;
  client_email: string;
  client_address: string | null;
  billing_address_json: string | null;
  shipping_address_json: string | null;
  tax_mode: string | null;
  tax_meta_json: string | null;
  tax_snapshot_json: string | null;
  date: string;
  valid_until: string;
  amount: number;
  status: string;
  share_token: string | null;
  share_published_at: string | null;
  accepted_at: string | null;
  accepted_by: string | null;
  accepted_email: string | null;
  accepted_user_agent: string | null;
  decision: string | null;
  decision_text_version: string | null;
  created_at: string;
  updated_at: string;
};

type OfferItemRow = {
  offer_id: string;
  position: number;
  description: string;
  article_id: string | null;
  category: string | null;
  unit: string | null;
  discount_percent: number | null;
  tax_rate: number | null;
  quantity: number;
  price: number;
  total: number;
};

type AuditRow = {
  sequence: number;
  ts: string;
  entity_type: string;
  entity_id: string;
  action: string;
  reason: string | null;
  before_json: string | null;
  after_json: string | null;
  prev_hash: string | null;
  hash: string;
  actor: string;
};

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

const parseJson = <T>(value: string | null, fallback: T): T => {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

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

const parseStoredAddress = (
  value: string | null,
  label: string,
): BillingAddress | undefined => {
  if (!value) {
    return undefined;
  }
  return safeJsonParse(value, AddressSchema, {}, label) as BillingAddress;
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
    items: (invoice.items ?? []).map((item) => ({
      description: item.description,
      quantity: item.quantity,
      price: item.price,
      total: item.total,
      articleId: item.articleId,
      category: item.category,
      unit: item.unit,
      discountPercent: item.discountPercent,
      taxRate: item.taxRate,
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
    items: (offer.items ?? []).map((item) => ({
      description: item.description,
      quantity: item.quantity,
      price: item.price,
      total: item.total,
      articleId: item.articleId,
      category: item.category,
      unit: item.unit,
      discountPercent: item.discountPercent,
      taxRate: item.taxRate,
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
    items: invoice.items.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      price: item.price,
      total: item.total,
      articleId: item.articleId,
      category: item.category,
      unit: item.unit,
      discountPercent: item.discountPercent,
      taxRate: item.taxRate,
    })),
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
    items: offer.items.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      price: item.price,
      total: item.total,
      articleId: item.articleId,
      category: item.category,
      unit: item.unit,
      discountPercent: item.discountPercent,
      taxRate: item.taxRate,
    })),
    payments: [],
    history: offer.history ?? [],
  };
};

const rowToInvoice = (
  scope: TenantScope,
  row: InvoiceRow,
  itemRows: InvoiceItemRow[],
  paymentRows: InvoicePaymentRow[],
): Invoice => {
  return {
    kind: "invoice",
    tenantId: scope.tenantId,
    id: row.id,
    clientId: row.client_id ?? undefined,
    clientNumber: row.client_number ?? undefined,
    projectId: row.project_id ?? undefined,
    number: row.number,
    client: row.client,
    clientEmail: row.client_email,
    clientAddress: row.client_address ?? undefined,
    billingAddress: parseStoredAddress(
      row.billing_address_json,
      `Invoice ${row.id} billing address`,
    ),
    shippingAddress: parseStoredAddress(
      row.shipping_address_json,
      `Invoice ${row.id} shipping address`,
    ),
    taxMode: (row.tax_mode as Invoice["taxMode"] | null) ?? "standard_vat",
    taxMeta: parseJson(row.tax_meta_json, undefined),
    taxSnapshot: parseJson(row.tax_snapshot_json, undefined),
    date: row.date,
    dueDate: row.due_date,
    servicePeriod: row.service_period ?? undefined,
    amount: row.amount,
    status: row.status as Invoice["status"],
    dunningLevel: row.dunning_level,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: itemRows.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      price: item.price,
      total: item.total,
      articleId: item.article_id ?? undefined,
      category: item.category ?? undefined,
      unit: item.unit ?? undefined,
      discountPercent: item.discount_percent ?? undefined,
      taxRate: item.tax_rate ?? undefined,
    })),
    payments: paymentRows.map((payment) => ({
      id: payment.id,
      date: payment.date,
      amount: payment.amount,
      method: payment.method,
    })),
    history: [],
  };
};

const rowToOffer = (
  scope: TenantScope,
  row: OfferRow,
  itemRows: OfferItemRow[],
): Offer => {
  const share =
    row.share_token ||
    row.share_published_at ||
    row.decision ||
    row.decision_text_version ||
    row.accepted_at ||
    row.accepted_by ||
    row.accepted_email ||
    row.accepted_user_agent
      ? {
          token: row.share_token ?? undefined,
          publishedAt: row.share_published_at ?? undefined,
          decision: (row.decision as OfferDecision | null) ?? undefined,
          decisionTextVersion: row.decision_text_version ?? undefined,
          acceptedAt: row.accepted_at ?? undefined,
          acceptedBy: row.accepted_by ?? undefined,
          acceptedEmail: row.accepted_email ?? undefined,
          acceptedUserAgent: row.accepted_user_agent ?? undefined,
        }
      : undefined;

  return {
    kind: "offer",
    tenantId: scope.tenantId,
    id: row.id,
    clientId: row.client_id ?? undefined,
    clientNumber: row.client_number ?? undefined,
    projectId: row.project_id ?? undefined,
    number: row.number,
    client: row.client,
    clientEmail: row.client_email,
    clientAddress: row.client_address ?? undefined,
    billingAddress: parseStoredAddress(
      row.billing_address_json,
      `Offer ${row.id} billing address`,
    ),
    shippingAddress: parseStoredAddress(
      row.shipping_address_json,
      `Offer ${row.id} shipping address`,
    ),
    taxMode: (row.tax_mode as Offer["taxMode"] | null) ?? "standard_vat",
    taxMeta: parseJson(row.tax_meta_json, undefined),
    taxSnapshot: parseJson(row.tax_snapshot_json, undefined),
    date: row.date,
    validUntil: row.valid_until,
    amount: row.amount,
    status: row.status as Offer["status"],
    share,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: itemRows.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      price: item.price,
      total: item.total,
      articleId: item.article_id ?? undefined,
      category: item.category ?? undefined,
      unit: item.unit ?? undefined,
      discountPercent: item.discount_percent ?? undefined,
      taxRate: item.tax_rate ?? undefined,
    })),
    history: [],
  };
};

const encodeAuditActor = (actor: AuditActor): string => {
  if (actor.type === "system" && actor.displayName === "local" && !actor.id) {
    return "local";
  }

  return JSON.stringify(actor);
};

const decodeAuditActor = (value: string): AuditActor => {
  if (!value || value === "local") {
    return { type: "system", displayName: "local" };
  }

  try {
    const parsed = JSON.parse(value) as AuditActor;
    if (parsed && typeof parsed === "object" && parsed.type) {
      return parsed;
    }
  } catch {
    // ignored
  }

  return {
    type: "system",
    displayName: value,
  };
};

const invoiceSelect = {
  id: schema.invoices.id,
  client_id: schema.invoices.clientId,
  client_number: schema.invoices.clientNumber,
  project_id: schema.invoices.projectId,
  number: schema.invoices.number,
  client: schema.invoices.client,
  client_email: schema.invoices.clientEmail,
  client_address: schema.invoices.clientAddress,
  billing_address_json: schema.invoices.billingAddressJson,
  shipping_address_json: schema.invoices.shippingAddressJson,
  tax_mode: schema.invoices.taxMode,
  tax_meta_json: schema.invoices.taxMetaJson,
  tax_snapshot_json: schema.invoices.taxSnapshotJson,
  date: schema.invoices.date,
  due_date: schema.invoices.dueDate,
  service_period: schema.invoices.servicePeriod,
  amount: schema.invoices.amount,
  status: schema.invoices.status,
  dunning_level: schema.invoices.dunningLevel,
  created_at: schema.invoices.createdAt,
  updated_at: schema.invoices.updatedAt,
};
const invoiceItemSelect = {
  invoice_id: schema.invoiceItems.invoiceId,
  position: schema.invoiceItems.position,
  description: schema.invoiceItems.description,
  article_id: schema.invoiceItems.articleId,
  category: schema.invoiceItems.category,
  unit: schema.invoiceItems.unit,
  discount_percent: schema.invoiceItems.discountPercent,
  tax_rate: schema.invoiceItems.taxRate,
  quantity: schema.invoiceItems.quantity,
  price: schema.invoiceItems.price,
  total: schema.invoiceItems.total,
};
const invoicePaymentSelect = {
  id: schema.invoicePayments.id,
  invoice_id: schema.invoicePayments.invoiceId,
  date: schema.invoicePayments.date,
  amount: schema.invoicePayments.amount,
  method: schema.invoicePayments.method,
};
const offerSelect = {
  id: schema.offers.id,
  client_id: schema.offers.clientId,
  client_number: schema.offers.clientNumber,
  project_id: schema.offers.projectId,
  number: schema.offers.number,
  client: schema.offers.client,
  client_email: schema.offers.clientEmail,
  client_address: schema.offers.clientAddress,
  billing_address_json: schema.offers.billingAddressJson,
  shipping_address_json: schema.offers.shippingAddressJson,
  tax_mode: schema.offers.taxMode,
  tax_meta_json: schema.offers.taxMetaJson,
  tax_snapshot_json: schema.offers.taxSnapshotJson,
  date: schema.offers.date,
  valid_until: schema.offers.validUntil,
  amount: schema.offers.amount,
  status: schema.offers.status,
  share_token: schema.offers.shareToken,
  share_published_at: schema.offers.sharePublishedAt,
  accepted_at: schema.offers.acceptedAt,
  accepted_by: schema.offers.acceptedBy,
  accepted_email: schema.offers.acceptedEmail,
  accepted_user_agent: schema.offers.acceptedUserAgent,
  decision: schema.offers.decision,
  decision_text_version: schema.offers.decisionTextVersion,
  created_at: schema.offers.createdAt,
  updated_at: schema.offers.updatedAt,
};
const offerItemSelect = {
  offer_id: schema.offerItems.offerId,
  position: schema.offerItems.position,
  description: schema.offerItems.description,
  article_id: schema.offerItems.articleId,
  category: schema.offerItems.category,
  unit: schema.offerItems.unit,
  discount_percent: schema.offerItems.discountPercent,
  tax_rate: schema.offerItems.taxRate,
  quantity: schema.offerItems.quantity,
  price: schema.offerItems.price,
  total: schema.offerItems.total,
};

const invoiceValues = (invoice: Invoice, now: string) => ({
  id: invoice.id,
  clientId: invoice.clientId ?? null,
  clientNumber: invoice.clientNumber ?? null,
  projectId: invoice.projectId ?? null,
  number: invoice.number,
  client: invoice.client,
  clientEmail: invoice.clientEmail,
  clientAddress: invoice.clientAddress ?? null,
  billingAddressJson: invoice.billingAddress
    ? JSON.stringify(invoice.billingAddress)
    : null,
  shippingAddressJson: invoice.shippingAddress
    ? JSON.stringify(invoice.shippingAddress)
    : null,
  taxMode: invoice.taxMode ?? "standard_vat",
  taxMetaJson: invoice.taxMeta ? JSON.stringify(invoice.taxMeta) : null,
  taxSnapshotJson: invoice.taxSnapshot
    ? JSON.stringify(invoice.taxSnapshot)
    : null,
  date: invoice.date,
  dueDate: invoice.dueDate,
  servicePeriod: invoice.servicePeriod ?? null,
  amount: invoice.amount,
  status: invoice.status,
  dunningLevel: invoice.dunningLevel ?? 0,
  createdAt: now,
  updatedAt: now,
});

const offerValues = (offer: Offer, now: string) => ({
  id: offer.id,
  clientId: offer.clientId ?? null,
  clientNumber: offer.clientNumber ?? null,
  projectId: offer.projectId ?? null,
  number: offer.number,
  client: offer.client,
  clientEmail: offer.clientEmail,
  clientAddress: offer.clientAddress ?? null,
  billingAddressJson: offer.billingAddress
    ? JSON.stringify(offer.billingAddress)
    : null,
  shippingAddressJson: offer.shippingAddress
    ? JSON.stringify(offer.shippingAddress)
    : null,
  taxMode: offer.taxMode ?? "standard_vat",
  taxMetaJson: offer.taxMeta ? JSON.stringify(offer.taxMeta) : null,
  taxSnapshotJson: offer.taxSnapshot ? JSON.stringify(offer.taxSnapshot) : null,
  date: offer.date,
  validUntil: offer.validUntil,
  amount: offer.amount,
  status: offer.status,
  shareToken: offer.share?.token ?? null,
  sharePublishedAt: offer.share?.publishedAt ?? null,
  acceptedAt: offer.share?.acceptedAt ?? null,
  acceptedBy: offer.share?.acceptedBy ?? null,
  acceptedEmail: offer.share?.acceptedEmail ?? null,
  acceptedUserAgent: offer.share?.acceptedUserAgent ?? null,
  decision: offer.share?.decision ?? null,
  decisionTextVersion: offer.share?.decisionTextVersion ?? null,
  createdAt: now,
  updatedAt: now,
});

export const createSqliteInvoiceRepository = (
  db: Database.Database,
): SqliteInvoiceRepository => {
  const sql = createDrizzle(db);
  const getById = (scope: TenantScope, id: string): Invoice | null => {
    const row = sql
      .select(invoiceSelect)
      .from(schema.invoices)
      .where(eq(schema.invoices.id, id))
      .get() as InvoiceRow | undefined;
    if (!row) return null;
    const itemRows = sql
      .select(invoiceItemSelect)
      .from(schema.invoiceItems)
      .where(eq(schema.invoiceItems.invoiceId, id))
      .orderBy(asc(schema.invoiceItems.position))
      .all() as InvoiceItemRow[];
    const paymentRows = sql
      .select(invoicePaymentSelect)
      .from(schema.invoicePayments)
      .where(eq(schema.invoicePayments.invoiceId, id))
      .orderBy(desc(schema.invoicePayments.date))
      .all() as InvoicePaymentRow[];
    return rowToInvoice(scope, row, itemRows, paymentRows);
  };
  return {
    list(scope) {
      const invoiceRows = sql
        .select(invoiceSelect)
        .from(schema.invoices)
        .orderBy(desc(schema.invoices.date), desc(schema.invoices.createdAt))
        .all() as InvoiceRow[];
      const itemRows = sql
        .select(invoiceItemSelect)
        .from(schema.invoiceItems)
        .orderBy(
          asc(schema.invoiceItems.invoiceId),
          asc(schema.invoiceItems.position),
        )
        .all() as InvoiceItemRow[];
      const paymentRows = sql
        .select(invoicePaymentSelect)
        .from(schema.invoicePayments)
        .orderBy(
          asc(schema.invoicePayments.invoiceId),
          desc(schema.invoicePayments.date),
        )
        .all() as InvoicePaymentRow[];
      const itemsByInvoice = new Map<string, InvoiceItemRow[]>();
      for (const row of itemRows)
        itemsByInvoice.set(row.invoice_id, [
          ...(itemsByInvoice.get(row.invoice_id) ?? []),
          row,
        ]);
      const paymentsByInvoice = new Map<string, InvoicePaymentRow[]>();
      for (const row of paymentRows)
        paymentsByInvoice.set(row.invoice_id, [
          ...(paymentsByInvoice.get(row.invoice_id) ?? []),
          row,
        ]);
      return invoiceRows.map((row) =>
        rowToInvoice(
          scope,
          row,
          itemsByInvoice.get(row.id) ?? [],
          paymentsByInvoice.get(row.id) ?? [],
        ),
      );
    },
    getById,
    save(scope, invoice) {
      const now = new Date().toISOString();
      const values = invoiceValues(invoice, now);
      sql
        .insert(schema.invoices)
        .values(values)
        .onConflictDoUpdate({
          target: schema.invoices.id,
          set: { ...values, createdAt: undefined },
        })
        .run();
      sql
        .delete(schema.invoiceItems)
        .where(eq(schema.invoiceItems.invoiceId, invoice.id))
        .run();
      if (invoice.items.length > 0) {
        sql
          .insert(schema.invoiceItems)
          .values(
            invoice.items.map((item, position) => ({
              invoiceId: invoice.id,
              position,
              description: item.description,
              articleId: item.articleId ?? null,
              category: item.category ?? null,
              unit: item.unit ?? null,
              discountPercent: item.discountPercent ?? null,
              taxRate: item.taxRate ?? null,
              quantity: item.quantity,
              price: item.price,
              total: item.total,
            })),
          )
          .run();
      }
      sql
        .delete(schema.invoicePayments)
        .where(eq(schema.invoicePayments.invoiceId, invoice.id))
        .run();
      if (invoice.payments.length > 0) {
        sql
          .insert(schema.invoicePayments)
          .values(
            invoice.payments.map((payment) => ({
              id: payment.id,
              invoiceId: invoice.id,
              date: payment.date,
              amount: payment.amount,
              method: payment.method,
            })),
          )
          .run();
      }
      const saved = getById(scope, invoice.id);
      if (!saved) throw new Error("Failed to retrieve invoice after save");
      return saved;
    },
    remove(_scope, id) {
      sql
        .delete(schema.invoiceItems)
        .where(eq(schema.invoiceItems.invoiceId, id))
        .run();
      sql
        .delete(schema.invoicePayments)
        .where(eq(schema.invoicePayments.invoiceId, id))
        .run();
      sql.delete(schema.invoices).where(eq(schema.invoices.id, id)).run();
    },
  };
};

export const createSqliteOfferRepository = (
  db: Database.Database,
): SqliteOfferRepository => {
  const sql = createDrizzle(db);
  const getById = (scope: TenantScope, id: string): Offer | null => {
    const row = sql
      .select(offerSelect)
      .from(schema.offers)
      .where(eq(schema.offers.id, id))
      .get() as OfferRow | undefined;
    if (!row) return null;
    const itemRows = sql
      .select(offerItemSelect)
      .from(schema.offerItems)
      .where(eq(schema.offerItems.offerId, id))
      .orderBy(asc(schema.offerItems.position))
      .all() as OfferItemRow[];
    return rowToOffer(scope, row, itemRows);
  };
  return {
    list(scope) {
      const offerRows = sql
        .select(offerSelect)
        .from(schema.offers)
        .orderBy(desc(schema.offers.date), desc(schema.offers.createdAt))
        .all() as OfferRow[];
      const itemRows = sql
        .select(offerItemSelect)
        .from(schema.offerItems)
        .orderBy(
          asc(schema.offerItems.offerId),
          asc(schema.offerItems.position),
        )
        .all() as OfferItemRow[];
      const itemsByOffer = new Map<string, OfferItemRow[]>();
      for (const row of itemRows)
        itemsByOffer.set(row.offer_id, [
          ...(itemsByOffer.get(row.offer_id) ?? []),
          row,
        ]);
      return offerRows.map((row) =>
        rowToOffer(scope, row, itemsByOffer.get(row.id) ?? []),
      );
    },
    getById,
    save(scope, offer) {
      const now = new Date().toISOString();
      const values = offerValues(offer, now);
      sql
        .insert(schema.offers)
        .values(values)
        .onConflictDoUpdate({
          target: schema.offers.id,
          set: { ...values, createdAt: undefined },
        })
        .run();
      sql
        .delete(schema.offerItems)
        .where(eq(schema.offerItems.offerId, offer.id))
        .run();
      if (offer.items.length > 0) {
        sql
          .insert(schema.offerItems)
          .values(
            offer.items.map((item, position) => ({
              offerId: offer.id,
              position,
              description: item.description,
              articleId: item.articleId ?? null,
              category: item.category ?? null,
              unit: item.unit ?? null,
              discountPercent: item.discountPercent ?? null,
              taxRate: item.taxRate ?? null,
              quantity: item.quantity,
              price: item.price,
              total: item.total,
            })),
          )
          .run();
      }
      const saved = getById(scope, offer.id);
      if (!saved) throw new Error("Failed to retrieve offer after save");
      return saved;
    },
    remove(_scope, id) {
      sql
        .delete(schema.offerItems)
        .where(eq(schema.offerItems.offerId, id))
        .run();
      sql.delete(schema.offers).where(eq(schema.offers.id, id)).run();
    },
  };
};

export const createSqliteAuditLogPort = (
  db: Database.Database,
): SqliteAuditLogPort => ({
  append(scope: TenantScope, entry: AuditEntryDraft) {
    const result = appendAuditLog(db, {
      entityType: entry.subject.entityType,
      entityId: entry.subject.entityId,
      action: entry.action,
      reason: entry.reason,
      before: entry.change?.before,
      after: entry.change?.after,
      actor: encodeAuditActor(entry.actor),
      ts: entry.occurredAt,
    });

    return {
      sequence: result.sequence,
      occurredAt: entry.occurredAt,
      action: entry.action,
      reason: entry.reason,
      actor: entry.actor,
      subject: {
        ...entry.subject,
        tenantId: entry.subject.tenantId ?? scope.tenantId,
      },
      change: entry.change,
      prevHash: null,
      hash: result.hash,
    };
  },
  listBySubject(scope: TenantScope, subject: AuditSubject) {
    const rows = createDrizzle(db).select({
      sequence: schema.auditLog.sequence,
      ts: schema.auditLog.ts,
      entity_type: schema.auditLog.entityType,
      entity_id: schema.auditLog.entityId,
      action: schema.auditLog.action,
      reason: schema.auditLog.reason,
      before_json: schema.auditLog.beforeJson,
      after_json: schema.auditLog.afterJson,
      prev_hash: schema.auditLog.prevHash,
      hash: schema.auditLog.hash,
      actor: schema.auditLog.actor,
    }).from(schema.auditLog).where(and(
      eq(schema.auditLog.entityType, subject.entityType),
      eq(schema.auditLog.entityId, subject.entityId),
    )).orderBy(desc(schema.auditLog.sequence)).all() as AuditRow[];

    return rows.map((row) => ({
      sequence: row.sequence,
      occurredAt: row.ts,
      action: row.action,
      reason: row.reason ?? undefined,
      actor: decodeAuditActor(row.actor),
      subject: {
        entityType: row.entity_type,
        entityId: row.entity_id,
        tenantId: subject.tenantId ?? scope.tenantId,
      },
      change: {
        before: parseJson(row.before_json, null),
        after: parseJson(row.after_json, null),
      },
      prevHash: row.prev_hash,
      hash: row.hash,
    }));
  },
});

export const createSqliteBillingDependencies = (db: Database.Database) => ({
  invoiceRepo: createSqliteInvoiceRepository(db),
  offerRepo: createSqliteOfferRepository(db),
  auditLog: createSqliteAuditLogPort(db),
});

export const withSqliteTransaction = <T>(
  db: Database.Database,
  work: () => T,
): T => {
  return db.transaction(work)();
};
