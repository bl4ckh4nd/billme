import type Database from 'better-sqlite3';
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
} from '@billme/server-core';
import { appendAuditLog } from './audit';
import { AddressSchema, safeJsonParse } from './validation-schemas';

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
  taxMode?: Invoice['taxMode'];
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

const normalizeBillingAddress = (value: unknown): BillingAddress | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }

  const parsed = AddressSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data as BillingAddress;
  }

  return undefined;
};

const parseStoredAddress = (value: string | null, label: string): BillingAddress | undefined => {
  if (!value) {
    return undefined;
  }
  return safeJsonParse(value, AddressSchema, {}, label) as BillingAddress;
};

export const createBillingScope = (product: ServerProduct): TenantScope => {
  return createSingleTenantScope('default', product);
};

export const toDomainInvoice = (scope: TenantScope, invoice: LegacyInvoiceDocument): Invoice => {
  return {
    kind: 'invoice',
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
    taxMode: invoice.taxMode ?? 'standard_vat',
    taxMeta: invoice.taxMeta,
    taxSnapshot: invoice.taxSnapshot,
    date: invoice.date,
    dueDate: invoice.dueDate,
    servicePeriod: invoice.servicePeriod,
    amount: invoice.amount,
    status: invoice.status as Invoice['status'],
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

export const toDomainOffer = (scope: TenantScope, offer: LegacyInvoiceDocument): Offer => {
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
    billingAddress: normalizeBillingAddress(offer.billingAddressJson),
    shippingAddress: normalizeBillingAddress(offer.shippingAddressJson),
    taxMode: offer.taxMode ?? 'standard_vat',
    taxMeta: offer.taxMeta,
    taxSnapshot: offer.taxSnapshot,
    date: offer.date,
    validUntil: offer.dueDate,
    amount: offer.amount,
    status: offer.status as Offer['status'],
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
    kind: 'invoice',
    tenantId: scope.tenantId,
    id: row.id,
    clientId: row.client_id ?? undefined,
    clientNumber: row.client_number ?? undefined,
    projectId: row.project_id ?? undefined,
    number: row.number,
    client: row.client,
    clientEmail: row.client_email,
    clientAddress: row.client_address ?? undefined,
    billingAddress: parseStoredAddress(row.billing_address_json, `Invoice ${row.id} billing address`),
    shippingAddress: parseStoredAddress(row.shipping_address_json, `Invoice ${row.id} shipping address`),
    taxMode: (row.tax_mode as Invoice['taxMode'] | null) ?? 'standard_vat',
    taxMeta: parseJson(row.tax_meta_json, undefined),
    taxSnapshot: parseJson(row.tax_snapshot_json, undefined),
    date: row.date,
    dueDate: row.due_date,
    servicePeriod: row.service_period ?? undefined,
    amount: row.amount,
    status: row.status as Invoice['status'],
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

const rowToOffer = (scope: TenantScope, row: OfferRow, itemRows: OfferItemRow[]): Offer => {
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
    kind: 'offer',
    tenantId: scope.tenantId,
    id: row.id,
    clientId: row.client_id ?? undefined,
    clientNumber: row.client_number ?? undefined,
    projectId: row.project_id ?? undefined,
    number: row.number,
    client: row.client,
    clientEmail: row.client_email,
    clientAddress: row.client_address ?? undefined,
    billingAddress: parseStoredAddress(row.billing_address_json, `Offer ${row.id} billing address`),
    shippingAddress: parseStoredAddress(row.shipping_address_json, `Offer ${row.id} shipping address`),
    taxMode: (row.tax_mode as Offer['taxMode'] | null) ?? 'standard_vat',
    taxMeta: parseJson(row.tax_meta_json, undefined),
    taxSnapshot: parseJson(row.tax_snapshot_json, undefined),
    date: row.date,
    validUntil: row.valid_until,
    amount: row.amount,
    status: row.status as Offer['status'],
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
  if (actor.type === 'system' && actor.displayName === 'local' && !actor.id) {
    return 'local';
  }

  return JSON.stringify(actor);
};

const decodeAuditActor = (value: string): AuditActor => {
  if (!value || value === 'local') {
    return { type: 'system', displayName: 'local' };
  }

  try {
    const parsed = JSON.parse(value) as AuditActor;
    if (parsed && typeof parsed === 'object' && parsed.type) {
      return parsed;
    }
  } catch {
    // ignored
  }

  return {
    type: 'system',
    displayName: value,
  };
};

export const createSqliteInvoiceRepository = (db: Database.Database): SqliteInvoiceRepository => ({
  list(scope: TenantScope) {
    const invoiceRows = db
      .prepare('SELECT * FROM invoices ORDER BY date DESC, created_at DESC')
      .all() as InvoiceRow[];
    const itemRows = db
      .prepare('SELECT * FROM invoice_items ORDER BY invoice_id, position ASC')
      .all() as InvoiceItemRow[];
    const paymentRows = db
      .prepare('SELECT * FROM invoice_payments ORDER BY invoice_id, date DESC')
      .all() as InvoicePaymentRow[];

    const itemsByInvoice = new Map<string, InvoiceItemRow[]>();
    for (const row of itemRows) {
      const list = itemsByInvoice.get(row.invoice_id) ?? [];
      list.push(row);
      itemsByInvoice.set(row.invoice_id, list);
    }

    const paymentsByInvoice = new Map<string, InvoicePaymentRow[]>();
    for (const row of paymentRows) {
      const list = paymentsByInvoice.get(row.invoice_id) ?? [];
      list.push(row);
      paymentsByInvoice.set(row.invoice_id, list);
    }

    return invoiceRows.map((row) =>
      rowToInvoice(scope, row, itemsByInvoice.get(row.id) ?? [], paymentsByInvoice.get(row.id) ?? []),
    );
  },
  getById(scope: TenantScope, id: string) {
    const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as InvoiceRow | undefined;
    if (!row) {
      return null;
    }

    const itemRows = db
      .prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY position ASC')
      .all(id) as InvoiceItemRow[];
    const paymentRows = db
      .prepare('SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY date DESC')
      .all(id) as InvoicePaymentRow[];

    return rowToInvoice(scope, row, itemRows, paymentRows);
  },
  save(scope: TenantScope, invoice: Invoice) {
    const now = new Date().toISOString();
    const exists = db.prepare('SELECT 1 FROM invoices WHERE id = ?').get(invoice.id) as { 1: 1 } | undefined;

    if (!exists) {
      db.prepare(
        `
          INSERT INTO invoices (
            id, client_id, client_number, project_id, number, client, client_email, client_address, billing_address_json, shipping_address_json,
            tax_mode, tax_meta_json, tax_snapshot_json, date, due_date, service_period, amount, status, dunning_level,
            created_at, updated_at
          ) VALUES (
            @id, @clientId, @clientNumber, @projectId, @number, @client, @clientEmail, @clientAddress, @billingAddressJson, @shippingAddressJson,
            @taxMode, @taxMetaJson, @taxSnapshotJson, @date, @dueDate, @servicePeriod, @amount, @status, @dunningLevel,
            @createdAt, @updatedAt
          )
        `,
      ).run({
        id: invoice.id,
        clientId: invoice.clientId ?? null,
        clientNumber: invoice.clientNumber ?? null,
        projectId: invoice.projectId ?? null,
        number: invoice.number,
        client: invoice.client,
        clientEmail: invoice.clientEmail,
        clientAddress: invoice.clientAddress ?? null,
        billingAddressJson: invoice.billingAddress ? JSON.stringify(invoice.billingAddress) : null,
        shippingAddressJson: invoice.shippingAddress ? JSON.stringify(invoice.shippingAddress) : null,
        taxMode: invoice.taxMode ?? null,
        taxMetaJson: invoice.taxMeta ? JSON.stringify(invoice.taxMeta) : null,
        taxSnapshotJson: invoice.taxSnapshot ? JSON.stringify(invoice.taxSnapshot) : null,
        date: invoice.date,
        dueDate: invoice.dueDate,
        servicePeriod: invoice.servicePeriod ?? null,
        amount: invoice.amount,
        status: invoice.status,
        dunningLevel: invoice.dunningLevel ?? 0,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      db.prepare(
        `
          UPDATE invoices SET
            client_id = @clientId,
            client_number = @clientNumber,
            project_id = @projectId,
            number = @number,
            client = @client,
            client_email = @clientEmail,
            client_address = @clientAddress,
            billing_address_json = @billingAddressJson,
            shipping_address_json = @shippingAddressJson,
            tax_mode = @taxMode,
            tax_meta_json = @taxMetaJson,
            tax_snapshot_json = @taxSnapshotJson,
            date = @date,
            due_date = @dueDate,
            service_period = @servicePeriod,
            amount = @amount,
            status = @status,
            dunning_level = @dunningLevel,
            updated_at = @updatedAt
          WHERE id = @id
        `,
      ).run({
        id: invoice.id,
        clientId: invoice.clientId ?? null,
        clientNumber: invoice.clientNumber ?? null,
        projectId: invoice.projectId ?? null,
        number: invoice.number,
        client: invoice.client,
        clientEmail: invoice.clientEmail,
        clientAddress: invoice.clientAddress ?? null,
        billingAddressJson: invoice.billingAddress ? JSON.stringify(invoice.billingAddress) : null,
        shippingAddressJson: invoice.shippingAddress ? JSON.stringify(invoice.shippingAddress) : null,
        taxMode: invoice.taxMode ?? null,
        taxMetaJson: invoice.taxMeta ? JSON.stringify(invoice.taxMeta) : null,
        taxSnapshotJson: invoice.taxSnapshot ? JSON.stringify(invoice.taxSnapshot) : null,
        date: invoice.date,
        dueDate: invoice.dueDate,
        servicePeriod: invoice.servicePeriod ?? null,
        amount: invoice.amount,
        status: invoice.status,
        dunningLevel: invoice.dunningLevel ?? 0,
        updatedAt: now,
      });
    }

    db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoice.id);
    const insertItem = db.prepare(
      `
        INSERT INTO invoice_items (invoice_id, position, description, article_id, category, unit, discount_percent, tax_rate, quantity, price, total)
        VALUES (@invoiceId, @position, @description, @articleId, @category, @unit, @discountPercent, @taxRate, @quantity, @price, @total)
      `,
    );
    invoice.items.forEach((item: Invoice['items'][number], index: number) => {
      insertItem.run({
        invoiceId: invoice.id,
        position: index,
        description: item.description,
        articleId: item.articleId ?? null,
        category: item.category ?? null,
        unit: item.unit ?? null,
        discountPercent: item.discountPercent ?? null,
        taxRate: item.taxRate ?? null,
        quantity: item.quantity,
        price: item.price,
        total: item.total,
      });
    });

    db.prepare('DELETE FROM invoice_payments WHERE invoice_id = ?').run(invoice.id);
    const insertPayment = db.prepare(
      `
        INSERT INTO invoice_payments (id, invoice_id, date, amount, method)
        VALUES (@id, @invoiceId, @date, @amount, @method)
      `,
    );
    invoice.payments.forEach((payment: Invoice['payments'][number]) => {
      insertPayment.run({
        id: payment.id,
        invoiceId: invoice.id,
        date: payment.date,
        amount: payment.amount,
        method: payment.method,
      });
    });

    const saved = this.getById(scope, invoice.id);
    if (!saved) {
      throw new Error('Failed to retrieve invoice after save');
    }
    return saved;
  },
  remove(_scope: TenantScope, id: string) {
    db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(id);
    db.prepare('DELETE FROM invoice_payments WHERE invoice_id = ?').run(id);
    db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
  },
});

export const createSqliteOfferRepository = (db: Database.Database): SqliteOfferRepository => ({
  list(scope: TenantScope) {
    const offerRows = db.prepare('SELECT * FROM offers ORDER BY date DESC, created_at DESC').all() as OfferRow[];
    const itemRows = db
      .prepare('SELECT * FROM offer_items ORDER BY offer_id, position ASC')
      .all() as OfferItemRow[];

    const itemsByOffer = new Map<string, OfferItemRow[]>();
    for (const row of itemRows) {
      const list = itemsByOffer.get(row.offer_id) ?? [];
      list.push(row);
      itemsByOffer.set(row.offer_id, list);
    }

    return offerRows.map((row) => rowToOffer(scope, row, itemsByOffer.get(row.id) ?? []));
  },
  getById(scope: TenantScope, id: string) {
    const row = db.prepare('SELECT * FROM offers WHERE id = ?').get(id) as OfferRow | undefined;
    if (!row) {
      return null;
    }

    const itemRows = db
      .prepare('SELECT * FROM offer_items WHERE offer_id = ? ORDER BY position ASC')
      .all(id) as OfferItemRow[];

    return rowToOffer(scope, row, itemRows);
  },
  save(scope: TenantScope, offer: Offer) {
    const now = new Date().toISOString();
    const exists = db.prepare('SELECT 1 FROM offers WHERE id = ?').get(offer.id) as { 1: 1 } | undefined;

    if (!exists) {
      db.prepare(
        `
          INSERT INTO offers (
            id, client_id, client_number, project_id, number, client, client_email, client_address, billing_address_json, shipping_address_json,
            tax_mode, tax_meta_json, tax_snapshot_json, date, valid_until, amount, status,
            share_token, share_published_at, accepted_at, accepted_by, accepted_email, accepted_user_agent, decision, decision_text_version,
            created_at, updated_at
          ) VALUES (
            @id, @clientId, @clientNumber, @projectId, @number, @client, @clientEmail, @clientAddress, @billingAddressJson, @shippingAddressJson,
            @taxMode, @taxMetaJson, @taxSnapshotJson, @date, @validUntil, @amount, @status,
            @shareToken, @sharePublishedAt, @acceptedAt, @acceptedBy, @acceptedEmail, @acceptedUserAgent, @decision, @decisionTextVersion,
            @createdAt, @updatedAt
          )
        `,
      ).run({
        id: offer.id,
        clientId: offer.clientId ?? null,
        clientNumber: offer.clientNumber ?? null,
        projectId: offer.projectId ?? null,
        number: offer.number,
        client: offer.client,
        clientEmail: offer.clientEmail,
        clientAddress: offer.clientAddress ?? null,
        billingAddressJson: offer.billingAddress ? JSON.stringify(offer.billingAddress) : null,
        shippingAddressJson: offer.shippingAddress ? JSON.stringify(offer.shippingAddress) : null,
        taxMode: offer.taxMode ?? null,
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
    } else {
      db.prepare(
        `
          UPDATE offers SET
            client_id = @clientId,
            client_number = @clientNumber,
            project_id = @projectId,
            number = @number,
            client = @client,
            client_email = @clientEmail,
            client_address = @clientAddress,
            billing_address_json = @billingAddressJson,
            shipping_address_json = @shippingAddressJson,
            tax_mode = @taxMode,
            tax_meta_json = @taxMetaJson,
            tax_snapshot_json = @taxSnapshotJson,
            date = @date,
            valid_until = @validUntil,
            amount = @amount,
            status = @status,
            share_token = @shareToken,
            share_published_at = @sharePublishedAt,
            accepted_at = @acceptedAt,
            accepted_by = @acceptedBy,
            accepted_email = @acceptedEmail,
            accepted_user_agent = @acceptedUserAgent,
            decision = @decision,
            decision_text_version = @decisionTextVersion,
            updated_at = @updatedAt
          WHERE id = @id
        `,
      ).run({
        id: offer.id,
        clientId: offer.clientId ?? null,
        clientNumber: offer.clientNumber ?? null,
        projectId: offer.projectId ?? null,
        number: offer.number,
        client: offer.client,
        clientEmail: offer.clientEmail,
        clientAddress: offer.clientAddress ?? null,
        billingAddressJson: offer.billingAddress ? JSON.stringify(offer.billingAddress) : null,
        shippingAddressJson: offer.shippingAddress ? JSON.stringify(offer.shippingAddress) : null,
        taxMode: offer.taxMode ?? null,
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
        updatedAt: now,
      });
    }

    db.prepare('DELETE FROM offer_items WHERE offer_id = ?').run(offer.id);
    const insertItem = db.prepare(
      `
        INSERT INTO offer_items (offer_id, position, description, article_id, category, unit, discount_percent, tax_rate, quantity, price, total)
        VALUES (@offerId, @position, @description, @articleId, @category, @unit, @discountPercent, @taxRate, @quantity, @price, @total)
      `,
    );
    offer.items.forEach((item: Offer['items'][number], index: number) => {
      insertItem.run({
        offerId: offer.id,
        position: index,
        description: item.description,
        articleId: item.articleId ?? null,
        category: item.category ?? null,
        unit: item.unit ?? null,
        discountPercent: item.discountPercent ?? null,
        taxRate: item.taxRate ?? null,
        quantity: item.quantity,
        price: item.price,
        total: item.total,
      });
    });

    const saved = this.getById(scope, offer.id);
    if (!saved) {
      throw new Error('Failed to retrieve offer after save');
    }
    return saved;
  },
  remove(_scope: TenantScope, id: string) {
    db.prepare('DELETE FROM offer_items WHERE offer_id = ?').run(id);
    db.prepare('DELETE FROM offers WHERE id = ?').run(id);
  },
});

export const createSqliteAuditLogPort = (db: Database.Database): SqliteAuditLogPort => ({
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
    const rows = db
      .prepare(
        `
          SELECT sequence, ts, entity_type, entity_id, action, reason, before_json, after_json, prev_hash, hash, actor
          FROM audit_log
          WHERE entity_type = ? AND entity_id = ?
          ORDER BY sequence DESC
        `,
      )
      .all(subject.entityType, subject.entityId) as AuditRow[];

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

export const withSqliteTransaction = <T>(db: Database.Database, work: () => T): T => {
  return db.transaction(work)();
};
