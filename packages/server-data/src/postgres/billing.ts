import type { Pool } from 'pg';
import {
  buildEmailOutboxDedupeKey,
  clientSchema,
  createSingleTenantScope,
  defaultEmailOutboxMaxAttempts,
  dunningHistoryEntrySchema,
  emailOutboxEntrySchema,
  invoiceSchema,
  offerSchema,
  recurringProfileSchema,
  systemClock,
  tenantMembershipSchema,
  tenantSchema,
  type BillingRepositories,
  type BillingUnitOfWork,
  type BillingUnitOfWorkContext,
  type Client,
  type DunningHistoryEntry,
  type DunningHistoryEntryDraft,
  type EmailOutboxEntry,
  type EmailOutboxRepository,
  type Invoice,
  type MaintenanceRetentionRepository,
  type Offer,
  type QueueEmailDeliveryInput,
  type RecurringProfile,
  type SqliteImportRunRetentionStatus,
  type Tenant,
  type TenantMembership,
  type TenantMembershipRepository,
  type TenantRepository,
  type TenantScope,
  type UserAccount,
  type UserAccountRepository,
  type UserAccountStatus,
  type ClientRepository,
  type DunningHistoryRepository,
  type InvoiceRepository,
  type OfferRepository,
  type RecurringProfileRepository,
  userAccountSchema,
} from '@billme/server-core';
import type { PostgresQueryable, PostgresTransactionClient } from './connection.js';
import { withPostgresTransaction } from './connection.js';
import { createPostgresAuditLogPort } from './audit.js';

export interface ServerSettingsRecord {
  tenantId: string;
  settingsJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServerNumberReservation {
  id: string;
  tenantId: string;
  kind: 'invoice' | 'offer' | 'customer';
  number: string;
  counterValue: number;
  status: 'reserved' | 'released' | 'finalized';
  documentId: string | null;
  createdAt: string;
  updatedAt: string;
}

type TenantRow = {
  id: string;
  slug: string;
  display_name: string;
  product: Tenant['product'];
  deployment_mode: Tenant['deploymentMode'];
  status: Tenant['status'];
  created_at: string;
  updated_at: string;
};

type UserRow = {
  id: string;
  email: string;
  full_name: string;
  status: UserAccountStatus;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
};

type MembershipRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  role: TenantMembership['role'];
  invited_by_user_id: string | null;
  created_at: string;
  updated_at: string;
};

type ClientRow = {
  id: string;
  tenant_id: string;
  customer_number: string | null;
  company: string;
  contact_person: string;
  email: string;
  phone: string;
  address: string;
  status: Client['status'];
  avatar: string | null;
  tags_json: string;
  notes: string;
  addresses_json: string | null;
  emails_json: string | null;
  projects_json: string | null;
  activities_json: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type InvoiceRow = {
  id: string;
  tenant_id: string;
  client_id: string | null;
  client_number: string | null;
  project_id: string | null;
  number: string;
  client: string;
  client_email: string;
  client_address: string | null;
  billing_address_json: string | null;
  shipping_address_json: string | null;
  date: string;
  due_date: string;
  service_period: string | null;
  amount: string | number;
  status: Invoice['status'];
  dunning_level: number;
  items_json: string | null;
  payments_json: string | null;
  history_json: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type OfferRow = {
  id: string;
  tenant_id: string;
  client_id: string | null;
  client_number: string | null;
  project_id: string | null;
  number: string;
  client: string;
  client_email: string;
  client_address: string | null;
  billing_address_json: string | null;
  shipping_address_json: string | null;
  date: string;
  valid_until: string;
  amount: string | number;
  status: Offer['status'];
  share_json: string | null;
  history_json: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type RecurringProfileRow = {
  id: string;
  tenant_id: string;
  client_id: string;
  active: boolean;
  name: string;
  interval: RecurringProfile['interval'];
  next_run: string;
  last_run: string | null;
  end_date: string | null;
  amount: string | number;
  items_json: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type DunningHistoryRow = {
  id: string;
  tenant_id: string;
  invoice_id: string;
  invoice_number: string;
  dunning_level: number;
  days_overdue: number;
  fee_applied: string | number;
  email_sent: boolean;
  email_log_id: string | null;
  processed_at: string;
  created_at: string;
};

type EmailOutboxRow = {
  id: string;
  tenant_id: string;
  dedupe_key: string;
  document_type: EmailOutboxEntry['documentType'];
  document_id: string;
  document_number: string;
  recipient_email: string;
  recipient_name: string;
  subject: string;
  body_text: string;
  status: EmailOutboxEntry['status'];
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string;
  last_attempt_at: string | null;
  locked_at: string | null;
  lease_expires_at: string | null;
  locked_by: string | null;
  last_error: string | null;
  provider: EmailOutboxEntry['provider'] | null;
  provider_message_id: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
};

const nowIso = (): string => new Date().toISOString();
const randomId = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) {
    return fallback;
  }

  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  return value as T;
};

const toJson = (value: unknown): string => JSON.stringify(value ?? null);
const toNumber = (value: string | number): number => (typeof value === 'number' ? value : Number(value));

const rowToTenant = (row: TenantRow): Tenant =>
  tenantSchema.parse({
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    product: row.product,
    deploymentMode: row.deployment_mode,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const rowToUser = (row: UserRow): UserAccount =>
  userAccountSchema.parse({
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    status: row.status,
    lastLoginAt: row.last_login_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const rowToMembership = (row: MembershipRow): TenantMembership =>
  tenantMembershipSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    role: row.role,
    invitedByUserId: row.invited_by_user_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const rowToClient = (row: ClientRow): Client =>
  clientSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    customerNumber: row.customer_number ?? undefined,
    company: row.company,
    contactPerson: row.contact_person,
    email: row.email,
    phone: row.phone,
    address: row.address,
    status: row.status,
    avatar: row.avatar ?? undefined,
    tags: parseJson(row.tags_json, []),
    notes: row.notes,
    addresses: parseJson(row.addresses_json, []),
    emails: parseJson(row.emails_json, []),
    projects: parseJson(row.projects_json, []),
    activities: parseJson(row.activities_json, []),
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
  });

const rowToInvoice = (row: InvoiceRow): Invoice =>
  invoiceSchema.parse({
    kind: 'invoice',
    id: row.id,
    tenantId: row.tenant_id,
    clientId: row.client_id ?? undefined,
    clientNumber: row.client_number ?? undefined,
    projectId: row.project_id ?? undefined,
    number: row.number,
    client: row.client,
    clientEmail: row.client_email,
    clientAddress: row.client_address ?? undefined,
    billingAddress: parseJson(row.billing_address_json, undefined),
    shippingAddress: parseJson(row.shipping_address_json, undefined),
    date: row.date,
    dueDate: row.due_date,
    servicePeriod: row.service_period ?? undefined,
    amount: toNumber(row.amount),
    status: row.status,
    dunningLevel: row.dunning_level,
    items: parseJson(row.items_json, []),
    payments: parseJson(row.payments_json, []),
    history: parseJson(row.history_json, []),
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
  });

const rowToOffer = (row: OfferRow): Offer =>
  offerSchema.parse({
    kind: 'offer',
    id: row.id,
    tenantId: row.tenant_id,
    clientId: row.client_id ?? undefined,
    clientNumber: row.client_number ?? undefined,
    projectId: row.project_id ?? undefined,
    number: row.number,
    client: row.client,
    clientEmail: row.client_email,
    clientAddress: row.client_address ?? undefined,
    billingAddress: parseJson(row.billing_address_json, undefined),
    shippingAddress: parseJson(row.shipping_address_json, undefined),
    date: row.date,
    validUntil: row.valid_until,
    amount: toNumber(row.amount),
    status: row.status,
    share: parseJson(row.share_json, undefined),
    history: parseJson(row.history_json, []),
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
  });

const rowToRecurringProfile = (row: RecurringProfileRow): RecurringProfile =>
  recurringProfileSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    clientId: row.client_id,
    active: row.active,
    name: row.name,
    interval: row.interval,
    nextRun: row.next_run,
    lastRun: row.last_run ?? undefined,
    endDate: row.end_date ?? undefined,
    amount: toNumber(row.amount),
    items: parseJson(row.items_json, []),
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
  });

const rowToDunningHistory = (row: DunningHistoryRow): DunningHistoryEntry =>
  dunningHistoryEntrySchema.parse({
    id: row.id,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    dunningLevel: row.dunning_level,
    daysOverdue: row.days_overdue,
    feeApplied: toNumber(row.fee_applied),
    emailSent: row.email_sent,
    emailLogId: row.email_log_id ?? undefined,
    processedAt: row.processed_at,
    createdAt: row.created_at,
  });

const rowToEmailOutbox = (row: EmailOutboxRow): EmailOutboxEntry =>
  emailOutboxEntrySchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    dedupeKey: row.dedupe_key,
    documentType: row.document_type,
    documentId: row.document_id,
    documentNumber: row.document_number,
    recipientEmail: row.recipient_email,
    recipientName: row.recipient_name,
    subject: row.subject,
    bodyText: row.body_text,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    lastAttemptAt: row.last_attempt_at ?? undefined,
    lockedAt: row.locked_at ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    lockedBy: row.locked_by ?? undefined,
    lastError: row.last_error ?? undefined,
    provider: row.provider ?? undefined,
    providerMessageId: row.provider_message_id ?? undefined,
    sentAt: row.sent_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

export const createPostgresTenantRepository = (db: PostgresQueryable): TenantRepository => ({
  async getById(id) {
    const result = await db.query<TenantRow>('SELECT * FROM tenants WHERE id = $1 LIMIT 1', [id]);
    return result.rows[0] ? rowToTenant(result.rows[0]) : null;
  },
  async getPrimary() {
    const result = await db.query<TenantRow>('SELECT * FROM tenants ORDER BY created_at ASC LIMIT 1');
    return result.rows[0] ? rowToTenant(result.rows[0]) : null;
  },
  async save(tenant) {
    const nextTenant: Tenant = {
      ...tenant,
      createdAt: tenant.createdAt ?? nowIso(),
      updatedAt: tenant.updatedAt ?? nowIso(),
    };
    await db.query(
      `
        INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO UPDATE SET
          slug = EXCLUDED.slug,
          display_name = EXCLUDED.display_name,
          product = EXCLUDED.product,
          deployment_mode = EXCLUDED.deployment_mode,
          status = EXCLUDED.status,
          updated_at = EXCLUDED.updated_at
      `,
      [
        nextTenant.id,
        nextTenant.slug,
        nextTenant.displayName,
        nextTenant.product,
        nextTenant.deploymentMode,
        nextTenant.status,
        nextTenant.createdAt,
        nextTenant.updatedAt,
      ],
    );
    return nextTenant;
  },
});

export const createPostgresUserRepository = (db: PostgresQueryable): UserAccountRepository => ({
  async getById(scope, id) {
    const result = await db.query<UserRow>(
      `
        SELECT u.*
        FROM user_accounts u
        JOIN tenant_memberships m ON m.user_id = u.id
        WHERE m.tenant_id = $1 AND u.id = $2
        LIMIT 1
      `,
      [scope.tenantId, id],
    );
    return result.rows[0] ? rowToUser(result.rows[0]) : null;
  },
  async getByEmail(scope, email) {
    const result = await db.query<UserRow>(
      `
        SELECT u.*
        FROM user_accounts u
        JOIN tenant_memberships m ON m.user_id = u.id
        WHERE m.tenant_id = $1 AND lower(u.email) = lower($2)
        LIMIT 1
      `,
      [scope.tenantId, email],
    );
    return result.rows[0] ? rowToUser(result.rows[0]) : null;
  },
  async list(scope) {
    const result = await db.query<UserRow>(
      `
        SELECT u.*
        FROM user_accounts u
        JOIN tenant_memberships m ON m.user_id = u.id
        WHERE m.tenant_id = $1
        ORDER BY u.created_at ASC
      `,
      [scope.tenantId],
    );
    return result.rows.map(rowToUser);
  },
  async save(_scope, user) {
    const nextUser: UserAccount = {
      ...user,
      createdAt: user.createdAt ?? nowIso(),
      updatedAt: user.updatedAt ?? nowIso(),
    };
    await db.query(
      `
        INSERT INTO user_accounts (id, email, full_name, status, last_login_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO UPDATE SET
          email = EXCLUDED.email,
          full_name = EXCLUDED.full_name,
          status = EXCLUDED.status,
          last_login_at = EXCLUDED.last_login_at,
          updated_at = EXCLUDED.updated_at
      `,
      [
        nextUser.id,
        nextUser.email,
        nextUser.fullName,
        nextUser.status,
        nextUser.lastLoginAt ?? null,
        nextUser.createdAt,
        nextUser.updatedAt,
      ],
    );
    return nextUser;
  },
});

export const createPostgresTenantMembershipRepository = (db: PostgresQueryable): TenantMembershipRepository => ({
  async list(scope) {
    const result = await db.query<MembershipRow>(
      'SELECT * FROM tenant_memberships WHERE tenant_id = $1 ORDER BY created_at ASC',
      [scope.tenantId],
    );
    return result.rows.map((row) => rowToMembership(row));
  },
  async get(scope, userId) {
    const result = await db.query<MembershipRow>(
      'SELECT * FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 LIMIT 1',
      [scope.tenantId, userId],
    );
    return result.rows[0] ? rowToMembership(result.rows[0]) : null;
  },
  async save(_scope, membership) {
    const nextMembership: TenantMembership = {
      ...membership,
      createdAt: membership.createdAt ?? nowIso(),
      updatedAt: membership.updatedAt ?? nowIso(),
    };
    await db.query(
      `
        INSERT INTO tenant_memberships (id, tenant_id, user_id, role, invited_by_user_id, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO UPDATE SET
          tenant_id = EXCLUDED.tenant_id,
          user_id = EXCLUDED.user_id,
          role = EXCLUDED.role,
          invited_by_user_id = EXCLUDED.invited_by_user_id,
          updated_at = EXCLUDED.updated_at
      `,
      [
        nextMembership.id,
        nextMembership.tenantId,
        nextMembership.userId,
        nextMembership.role,
        nextMembership.invitedByUserId ?? null,
        nextMembership.createdAt,
        nextMembership.updatedAt,
      ],
    );
    return nextMembership;
  },
});

export const createPostgresClientRepository = (db: PostgresQueryable): ClientRepository => ({
  async list(scope) {
    const result = await db.query<ClientRow>('SELECT * FROM clients WHERE tenant_id = $1 ORDER BY company ASC, id ASC', [scope.tenantId]);
    return result.rows.map((row) => rowToClient(row));
  },
  async getById(scope, id) {
    const result = await db.query<ClientRow>('SELECT * FROM clients WHERE tenant_id = $1 AND id = $2 LIMIT 1', [scope.tenantId, id]);
    return result.rows[0] ? rowToClient(result.rows[0]) : null;
  },
  async save(scope, client) {
    const nextClient: Client = {
      ...client,
      tenantId: scope.tenantId,
      createdAt: client.createdAt ?? nowIso(),
      updatedAt: client.updatedAt ?? nowIso(),
    };
    await db.query(
      `
        INSERT INTO clients (
          id, tenant_id, customer_number, company, contact_person, email, phone, address, status, avatar,
          tags_json, notes, addresses_json, emails_json, projects_json, activities_json, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18
        )
        ON CONFLICT (id) DO UPDATE SET
          tenant_id = EXCLUDED.tenant_id,
          customer_number = EXCLUDED.customer_number,
          company = EXCLUDED.company,
          contact_person = EXCLUDED.contact_person,
          email = EXCLUDED.email,
          phone = EXCLUDED.phone,
          address = EXCLUDED.address,
          status = EXCLUDED.status,
          avatar = EXCLUDED.avatar,
          tags_json = EXCLUDED.tags_json,
          notes = EXCLUDED.notes,
          addresses_json = EXCLUDED.addresses_json,
          emails_json = EXCLUDED.emails_json,
          projects_json = EXCLUDED.projects_json,
          activities_json = EXCLUDED.activities_json,
          updated_at = EXCLUDED.updated_at
      `,
      [
        nextClient.id,
        scope.tenantId,
        nextClient.customerNumber ?? null,
        nextClient.company,
        nextClient.contactPerson,
        nextClient.email,
        nextClient.phone,
        nextClient.address,
        nextClient.status,
        nextClient.avatar ?? null,
        toJson(nextClient.tags),
        nextClient.notes,
        toJson(nextClient.addresses ?? []),
        toJson(nextClient.emails ?? []),
        toJson(nextClient.projects ?? []),
        toJson(nextClient.activities ?? []),
        nextClient.createdAt ?? null,
        nextClient.updatedAt ?? null,
      ],
    );
    return nextClient;
  },
  async remove(scope, id) {
    await db.query('DELETE FROM clients WHERE tenant_id = $1 AND id = $2', [scope.tenantId, id]);
  },
});

export const createPostgresInvoiceRepository = (db: PostgresQueryable): InvoiceRepository => ({
  async list(scope) {
    const result = await db.query<InvoiceRow>(
      'SELECT * FROM invoices WHERE tenant_id = $1 ORDER BY date DESC, created_at DESC NULLS LAST, id DESC',
      [scope.tenantId],
    );
    return result.rows.map((row) => rowToInvoice(row));
  },
  async getById(scope, id) {
    const result = await db.query<InvoiceRow>('SELECT * FROM invoices WHERE tenant_id = $1 AND id = $2 LIMIT 1', [scope.tenantId, id]);
    return result.rows[0] ? rowToInvoice(result.rows[0]) : null;
  },
  async save(scope, invoice) {
    const nextInvoice: Invoice = {
      ...invoice,
      tenantId: scope.tenantId,
      createdAt: invoice.createdAt ?? nowIso(),
      updatedAt: invoice.updatedAt ?? nowIso(),
    };
    await db.query(
      `
        INSERT INTO invoices (
          id, tenant_id, client_id, client_number, project_id, number, client, client_email, client_address,
          billing_address_json, shipping_address_json, date, due_date, service_period, amount, status,
          dunning_level, items_json, payments_json, history_json, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16,
          $17, $18, $19, $20, $21, $22
        )
        ON CONFLICT (id) DO UPDATE SET
          tenant_id = EXCLUDED.tenant_id,
          client_id = EXCLUDED.client_id,
          client_number = EXCLUDED.client_number,
          project_id = EXCLUDED.project_id,
          number = EXCLUDED.number,
          client = EXCLUDED.client,
          client_email = EXCLUDED.client_email,
          client_address = EXCLUDED.client_address,
          billing_address_json = EXCLUDED.billing_address_json,
          shipping_address_json = EXCLUDED.shipping_address_json,
          date = EXCLUDED.date,
          due_date = EXCLUDED.due_date,
          service_period = EXCLUDED.service_period,
          amount = EXCLUDED.amount,
          status = EXCLUDED.status,
          dunning_level = EXCLUDED.dunning_level,
          items_json = EXCLUDED.items_json,
          payments_json = EXCLUDED.payments_json,
          history_json = EXCLUDED.history_json,
          updated_at = EXCLUDED.updated_at
      `,
      [
        nextInvoice.id,
        scope.tenantId,
        nextInvoice.clientId ?? null,
        nextInvoice.clientNumber ?? null,
        nextInvoice.projectId ?? null,
        nextInvoice.number,
        nextInvoice.client,
        nextInvoice.clientEmail,
        nextInvoice.clientAddress ?? null,
        nextInvoice.billingAddress ? toJson(nextInvoice.billingAddress) : null,
        nextInvoice.shippingAddress ? toJson(nextInvoice.shippingAddress) : null,
        nextInvoice.date,
        nextInvoice.dueDate,
        nextInvoice.servicePeriod ?? null,
        nextInvoice.amount,
        nextInvoice.status,
        nextInvoice.dunningLevel ?? 0,
        toJson(nextInvoice.items ?? []),
        toJson(nextInvoice.payments ?? []),
        toJson(nextInvoice.history ?? []),
        nextInvoice.createdAt ?? null,
        nextInvoice.updatedAt ?? null,
      ],
    );
    return nextInvoice;
  },
  async remove(scope, id) {
    await db.query('DELETE FROM invoices WHERE tenant_id = $1 AND id = $2', [scope.tenantId, id]);
  },
});

export const createPostgresOfferRepository = (db: PostgresQueryable): OfferRepository => ({
  async list(scope) {
    const result = await db.query<OfferRow>(
      'SELECT * FROM offers WHERE tenant_id = $1 ORDER BY date DESC, created_at DESC NULLS LAST, id DESC',
      [scope.tenantId],
    );
    return result.rows.map((row) => rowToOffer(row));
  },
  async getById(scope, id) {
    const result = await db.query<OfferRow>('SELECT * FROM offers WHERE tenant_id = $1 AND id = $2 LIMIT 1', [scope.tenantId, id]);
    return result.rows[0] ? rowToOffer(result.rows[0]) : null;
  },
  async save(scope, offer) {
    const nextOffer: Offer = {
      ...offer,
      tenantId: scope.tenantId,
      createdAt: offer.createdAt ?? nowIso(),
      updatedAt: offer.updatedAt ?? nowIso(),
    };
    await db.query(
      `
        INSERT INTO offers (
          id, tenant_id, client_id, client_number, project_id, number, client, client_email, client_address,
          billing_address_json, shipping_address_json, date, valid_until, amount, status, share_json,
          history_json, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16,
          $17, $18, $19
        )
        ON CONFLICT (id) DO UPDATE SET
          tenant_id = EXCLUDED.tenant_id,
          client_id = EXCLUDED.client_id,
          client_number = EXCLUDED.client_number,
          project_id = EXCLUDED.project_id,
          number = EXCLUDED.number,
          client = EXCLUDED.client,
          client_email = EXCLUDED.client_email,
          client_address = EXCLUDED.client_address,
          billing_address_json = EXCLUDED.billing_address_json,
          shipping_address_json = EXCLUDED.shipping_address_json,
          date = EXCLUDED.date,
          valid_until = EXCLUDED.valid_until,
          amount = EXCLUDED.amount,
          status = EXCLUDED.status,
          share_json = EXCLUDED.share_json,
          history_json = EXCLUDED.history_json,
          updated_at = EXCLUDED.updated_at
      `,
      [
        nextOffer.id,
        scope.tenantId,
        nextOffer.clientId ?? null,
        nextOffer.clientNumber ?? null,
        nextOffer.projectId ?? null,
        nextOffer.number,
        nextOffer.client,
        nextOffer.clientEmail,
        nextOffer.clientAddress ?? null,
        nextOffer.billingAddress ? toJson(nextOffer.billingAddress) : null,
        nextOffer.shippingAddress ? toJson(nextOffer.shippingAddress) : null,
        nextOffer.date,
        nextOffer.validUntil,
        nextOffer.amount,
        nextOffer.status,
        nextOffer.share ? toJson(nextOffer.share) : null,
        toJson(nextOffer.history ?? []),
        nextOffer.createdAt ?? null,
        nextOffer.updatedAt ?? null,
      ],
    );
    return nextOffer;
  },
  async remove(scope, id) {
    await db.query('DELETE FROM offers WHERE tenant_id = $1 AND id = $2', [scope.tenantId, id]);
  },
});

export const createPostgresRecurringProfileRepository = (db: PostgresQueryable): RecurringProfileRepository => ({
  async list(scope) {
    const result = await db.query<RecurringProfileRow>(
      'SELECT * FROM recurring_profiles WHERE tenant_id = $1 ORDER BY next_run ASC, name ASC',
      [scope.tenantId],
    );
    return result.rows.map((row) => rowToRecurringProfile(row));
  },
  async getById(scope, id) {
    const result = await db.query<RecurringProfileRow>(
      'SELECT * FROM recurring_profiles WHERE tenant_id = $1 AND id = $2 LIMIT 1',
      [scope.tenantId, id],
    );
    return result.rows[0] ? rowToRecurringProfile(result.rows[0]) : null;
  },
  async save(scope, profile) {
    const nextProfile: RecurringProfile = {
      ...profile,
      tenantId: scope.tenantId,
      createdAt: profile.createdAt ?? nowIso(),
      updatedAt: profile.updatedAt ?? nowIso(),
    };
    await db.query(
      `
        INSERT INTO recurring_profiles (
          id, tenant_id, client_id, active, name, interval, next_run, last_run, end_date,
          amount, items_json, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13
        )
        ON CONFLICT (id) DO UPDATE SET
          tenant_id = EXCLUDED.tenant_id,
          client_id = EXCLUDED.client_id,
          active = EXCLUDED.active,
          name = EXCLUDED.name,
          interval = EXCLUDED.interval,
          next_run = EXCLUDED.next_run,
          last_run = EXCLUDED.last_run,
          end_date = EXCLUDED.end_date,
          amount = EXCLUDED.amount,
          items_json = EXCLUDED.items_json,
          updated_at = EXCLUDED.updated_at
      `,
      [
        nextProfile.id,
        scope.tenantId,
        nextProfile.clientId,
        nextProfile.active,
        nextProfile.name,
        nextProfile.interval,
        nextProfile.nextRun,
        nextProfile.lastRun ?? null,
        nextProfile.endDate ?? null,
        nextProfile.amount,
        toJson(nextProfile.items ?? []),
        nextProfile.createdAt ?? null,
        nextProfile.updatedAt ?? null,
      ],
    );
    return nextProfile;
  },
  async remove(scope, id) {
    await db.query('DELETE FROM recurring_profiles WHERE tenant_id = $1 AND id = $2', [scope.tenantId, id]);
  },
});

export const createPostgresDunningHistoryRepository = (db: PostgresQueryable): DunningHistoryRepository => ({
  async listByInvoice(scope, invoiceId) {
    const result = await db.query<DunningHistoryRow>(
      `
        SELECT *
        FROM dunning_history
        WHERE tenant_id = $1 AND invoice_id = $2
        ORDER BY dunning_level DESC, processed_at DESC
      `,
      [scope.tenantId, invoiceId],
    );
    return result.rows.map((row) => rowToDunningHistory(row));
  },
  async record(scope, entry: DunningHistoryEntryDraft) {
    const createdAt = nowIso();
    const id = randomId();
    await db.query(
      `
        INSERT INTO dunning_history (
          id, tenant_id, invoice_id, invoice_number, dunning_level, days_overdue,
          fee_applied, email_sent, email_log_id, processed_at, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11
        )
      `,
      [
        id,
        scope.tenantId,
        entry.invoiceId,
        entry.invoiceNumber,
        entry.dunningLevel,
        entry.daysOverdue,
        entry.feeApplied,
        entry.emailSent,
        entry.emailLogId ?? null,
        entry.processedAt,
        createdAt,
      ],
    );
    return {
      ...entry,
      id,
      createdAt,
    };
  },
});

export const createPostgresEmailOutboxRepository = (db: PostgresQueryable): EmailOutboxRepository => ({
  async enqueue(scope, entry: QueueEmailDeliveryInput) {
    const createdAt = nowIso();
    const nextEntry = {
      id: randomId(),
      tenantId: scope.tenantId,
      dedupeKey: entry.dedupeKey ?? buildEmailOutboxDedupeKey(entry),
      documentType: entry.documentType,
      documentId: entry.documentId,
      documentNumber: entry.documentNumber,
      recipientEmail: entry.recipientEmail,
      recipientName: entry.recipientName,
      subject: entry.subject,
      bodyText: entry.bodyText,
      status: 'pending' as const,
      attemptCount: 0,
      maxAttempts: entry.maxAttempts ?? defaultEmailOutboxMaxAttempts,
      nextAttemptAt: entry.nextAttemptAt ?? createdAt,
      createdAt,
      updatedAt: createdAt,
    };

    const inserted = await db.query<EmailOutboxRow>(
      `
        INSERT INTO email_outbox (
          id, tenant_id, dedupe_key, document_type, document_id, document_number,
          recipient_email, recipient_name, subject, body_text, status, attempt_count,
          max_attempts, next_attempt_at, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12,
          $13, $14, $15, $16
        )
        ON CONFLICT DO NOTHING
        RETURNING *
      `,
      [
        nextEntry.id,
        nextEntry.tenantId,
        nextEntry.dedupeKey,
        nextEntry.documentType,
        nextEntry.documentId,
        nextEntry.documentNumber,
        nextEntry.recipientEmail,
        nextEntry.recipientName,
        nextEntry.subject,
        nextEntry.bodyText,
        nextEntry.status,
        nextEntry.attemptCount,
        nextEntry.maxAttempts,
        nextEntry.nextAttemptAt,
        nextEntry.createdAt,
        nextEntry.updatedAt,
      ],
    );

    if (inserted.rows[0]) {
      return rowToEmailOutbox(inserted.rows[0]);
    }

    const existing = await db.query<EmailOutboxRow>(
      `
        SELECT *
        FROM email_outbox
        WHERE tenant_id = $1
          AND dedupe_key = $2
          AND status IN ('pending', 'processing')
        ORDER BY created_at ASC
        LIMIT 1
      `,
      [scope.tenantId, nextEntry.dedupeKey],
    );

    if (!existing.rows[0]) {
      throw new Error('Failed to enqueue email outbox entry');
    }

    return rowToEmailOutbox(existing.rows[0]);
  },

  async claimDue(scope, args) {
    const result = await db.query<EmailOutboxRow>(
      `
        WITH due AS (
          SELECT id
          FROM email_outbox
          WHERE tenant_id = $1
            AND (
              (status = 'pending' AND next_attempt_at <= $2)
              OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $2)
            )
          ORDER BY next_attempt_at ASC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $3
        )
        UPDATE email_outbox
        SET status = 'processing',
            locked_by = $4,
            locked_at = $2,
            lease_expires_at = $5,
            updated_at = $2
        FROM due
        WHERE email_outbox.id = due.id
        RETURNING email_outbox.*
      `,
      [scope.tenantId, args.now, args.limit, args.workerId, args.leaseExpiresAt],
    );

    return result.rows.map((row) => rowToEmailOutbox(row));
  },

  async markSent(scope, args) {
    const result = await db.query<EmailOutboxRow>(
      `
        UPDATE email_outbox
        SET status = 'sent',
            attempt_count = attempt_count + 1,
            next_attempt_at = $3,
            last_attempt_at = $3,
            last_error = NULL,
            provider = $4,
            provider_message_id = $5,
            sent_at = $3,
            locked_at = NULL,
            lease_expires_at = NULL,
            locked_by = NULL,
            updated_at = $3
        WHERE tenant_id = $1
          AND id = $2
          AND status = 'processing'
          AND locked_by = $6
        RETURNING *
      `,
      [scope.tenantId, args.id, args.sentAt, args.provider, args.providerMessageId ?? null, args.workerId],
    );

    return result.rows[0] ? rowToEmailOutbox(result.rows[0]) : null;
  },

  async markFailed(scope, args) {
    const result = await db.query<EmailOutboxRow>(
      `
        UPDATE email_outbox
        SET status = CASE
              WHEN attempt_count + 1 >= max_attempts OR $4::text IS NULL THEN 'failed'
              ELSE 'pending'
            END,
            attempt_count = attempt_count + 1,
            next_attempt_at = CASE
              WHEN attempt_count + 1 >= max_attempts OR $4::text IS NULL THEN $3
              ELSE $4
            END,
            last_attempt_at = $3,
            last_error = $5,
            provider = $6,
            provider_message_id = NULL,
            locked_at = NULL,
            lease_expires_at = NULL,
            locked_by = NULL,
            updated_at = $3
        WHERE tenant_id = $1
          AND id = $2
          AND status = 'processing'
          AND locked_by = $7
        RETURNING *
      `,
      [scope.tenantId, args.id, args.failedAt, args.retryAt ?? null, args.error, args.provider, args.workerId],
    );

    return result.rows[0] ? rowToEmailOutbox(result.rows[0]) : null;
  },
});

export const getServerSettings = async (db: PostgresQueryable, tenantId: string): Promise<ServerSettingsRecord | null> => {
  const result = await db.query<{
    tenant_id: string;
    settings_json: string;
    created_at: string;
    updated_at: string;
  }>('SELECT * FROM server_settings WHERE tenant_id = $1 LIMIT 1', [tenantId]);

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    tenantId: row.tenant_id,
    settingsJson: row.settings_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

export const saveServerSettings = async (db: PostgresQueryable, record: ServerSettingsRecord): Promise<ServerSettingsRecord> => {
  const nextRecord: ServerSettingsRecord = {
    ...record,
    createdAt: record.createdAt || nowIso(),
    updatedAt: record.updatedAt || nowIso(),
  };
  await db.query(
    `
      INSERT INTO server_settings (tenant_id, settings_json, created_at, updated_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (tenant_id) DO UPDATE SET
        settings_json = EXCLUDED.settings_json,
        updated_at = EXCLUDED.updated_at
    `,
    [nextRecord.tenantId, nextRecord.settingsJson, nextRecord.createdAt, nextRecord.updatedAt],
  );
  return nextRecord;
};

export const listServerNumberReservations = async (
  db: PostgresQueryable,
  tenantId: string,
): Promise<ServerNumberReservation[]> => {
  const result = await db.query<{
    id: string;
    tenant_id: string;
    kind: ServerNumberReservation['kind'];
    number: string;
    counter_value: number;
    status: ServerNumberReservation['status'];
    document_id: string | null;
    created_at: string;
    updated_at: string;
  }>('SELECT * FROM number_reservations WHERE tenant_id = $1 ORDER BY created_at ASC', [tenantId]);

  return result.rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    number: row.number,
    counterValue: row.counter_value,
    status: row.status,
    documentId: row.document_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
};

export const saveServerNumberReservation = async (
  db: PostgresQueryable,
  reservation: ServerNumberReservation,
): Promise<ServerNumberReservation> => {
  const nextReservation: ServerNumberReservation = {
    ...reservation,
    createdAt: reservation.createdAt || nowIso(),
    updatedAt: reservation.updatedAt || nowIso(),
  };

  await db.query(
    `
      INSERT INTO number_reservations (
        id, tenant_id, kind, number, counter_value, status, document_id, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9
      )
      ON CONFLICT (id) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
        kind = EXCLUDED.kind,
        number = EXCLUDED.number,
        counter_value = EXCLUDED.counter_value,
        status = EXCLUDED.status,
        document_id = EXCLUDED.document_id,
        updated_at = EXCLUDED.updated_at
    `,
    [
      nextReservation.id,
      nextReservation.tenantId,
      nextReservation.kind,
      nextReservation.number,
      nextReservation.counterValue,
      nextReservation.status,
      nextReservation.documentId,
      nextReservation.createdAt,
      nextReservation.updatedAt,
    ],
  );

  return nextReservation;
};

export const deleteReleasedServerNumberReservationsBefore = async (
  db: PostgresQueryable,
  tenantId: string,
  updatedBefore: string,
): Promise<number> => {
  const result = await db.query(
    `
      DELETE FROM number_reservations
      WHERE tenant_id = $1
        AND status = 'released'
        AND updated_at IS NOT NULL
        AND updated_at::timestamptz < $2::timestamptz
    `,
    [tenantId, updatedBefore],
  );

  return result.rowCount ?? 0;
};

export const deleteServerSqliteImportRunsBefore = async (
  db: PostgresQueryable,
  tenantId: string,
  completedBefore: string,
  statuses: SqliteImportRunRetentionStatus[],
): Promise<number> => {
  if (statuses.length === 0) {
    return 0;
  }

  const result = await db.query(
    `
      DELETE FROM sqlite_import_runs
      WHERE tenant_id = $1
        AND status = ANY($2::text[])
        AND completed_at IS NOT NULL
        AND completed_at::timestamptz < $3::timestamptz
    `,
    [tenantId, statuses, completedBefore],
  );

  return result.rowCount ?? 0;
};

export const createPostgresMaintenanceRepository = (db: PostgresQueryable): MaintenanceRetentionRepository => ({
  deleteReleasedNumberReservations(scope, args) {
    return deleteReleasedServerNumberReservationsBefore(db, scope.tenantId, args.updatedBefore);
  },
  deleteSqliteImportRuns(scope, args) {
    return deleteServerSqliteImportRunsBefore(db, scope.tenantId, args.completedBefore, args.statuses);
  },
});

export const createPostgresBillingDependencies = (
  db: Pool | PostgresTransactionClient,
): BillingRepositories => ({
  tenantRepo: createPostgresTenantRepository(db),
  userRepo: createPostgresUserRepository(db),
  membershipRepo: createPostgresTenantMembershipRepository(db),
  clientRepo: createPostgresClientRepository(db),
  invoiceRepo: createPostgresInvoiceRepository(db),
  offerRepo: createPostgresOfferRepository(db),
  recurringProfileRepo: createPostgresRecurringProfileRepository(db),
  dunningHistoryRepo: createPostgresDunningHistoryRepository(db),
  emailOutboxRepo: createPostgresEmailOutboxRepository(db),
  auditLog: createPostgresAuditLogPort(db),
});

export const createPostgresBillingUnitOfWork = (pool: Pool): BillingUnitOfWork => ({
  async withTransaction<TResult>(scope: TenantScope, work: (context: BillingUnitOfWorkContext) => Promise<TResult> | TResult) {
    return withPostgresTransaction(pool, async (client) => {
      const repositories = createPostgresBillingDependencies(client);
      return work({
        scope,
        clock: systemClock,
        repositories,
      });
    });
  },
});

export const createDefaultTenantScope = (tenantId: string, product: Tenant['product']): TenantScope => {
  return createSingleTenantScope(tenantId, product);
};

export const tenantCoreRowCountTables = [
  'server_settings',
  'number_reservations',
  'clients',
  'invoices',
  'offers',
  'recurring_profiles',
  'articles',
  'accounts',
  'pro_workflow_entries',
  'bank_transactions',
  'booking_drafts',
  'booking_draft_lines',
  'draft_validation_issues',
  'accounting_periods',
  'journal_entries',
  'journal_lines',
  'assets',
  'asset_depreciation_schedule',
  'asset_movements',
  'account_mappings_hgb',
  'report_snapshots',
  'datev_exports',
  'vat_evidence',
  'journal_posting_pairs',
  'transactions',
  'eur_classifications',
  'eur_rules',
  'account_keywords',
  'account_suggestion_rules',
  'import_batches',
  'templates',
  'active_templates',
  'dunning_history',
  'email_outbox',
  'email_log',
  'audit_log',
] as const;

export const countTenantCoreRows = async (db: PostgresQueryable, tenantId: string): Promise<number> => {
  const tables = [
    ...tenantCoreRowCountTables,
  ];
  let total = 0;
  for (const table of tables) {
    const result = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    total += Number(result.rows[0]?.count ?? 0);
  }
  return total;
};

export const insertEmailLogRow = async (
  db: PostgresQueryable,
  tenantId: string,
  row: {
    id: string;
    documentType: string;
    documentId: string;
    documentNumber: string;
    recipientEmail: string;
    recipientName: string;
    subject: string;
    bodyText: string;
    provider: string;
    status: string;
    errorMessage?: string | null;
    sentAt: string;
    createdAt: string;
  },
): Promise<void> => {
  await db.query(
    `
      INSERT INTO email_log (
        id, tenant_id, document_type, document_id, document_number, recipient_email,
        recipient_name, subject, body_text, provider, status, error_message, sent_at, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12, $13, $14
      )
    `,
    [
      row.id,
      tenantId,
      row.documentType,
      row.documentId,
      row.documentNumber,
      row.recipientEmail,
      row.recipientName,
      row.subject,
      row.bodyText,
      row.provider,
      row.status,
      row.errorMessage ?? null,
      row.sentAt,
      row.createdAt,
    ],
  );
};

export const insertAuditRow = async (
  db: PostgresQueryable,
  tenantId: string,
  row: {
    sequence: number;
    ts: string;
    entityType: string;
    entityId: string;
    action: string;
    reason?: string | null;
    beforeJson?: string | null;
    afterJson?: string | null;
    prevHash?: string | null;
    hash: string;
    actor: string;
  },
): Promise<void> => {
  await db.query(
    `
      INSERT INTO audit_log (
        tenant_id, sequence, ts, entity_type, entity_id, action, reason,
        before_json, after_json, prev_hash, hash, actor
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12
      )
    `,
    [
      tenantId,
      row.sequence,
      row.ts,
      row.entityType,
      row.entityId,
      row.action,
      row.reason ?? null,
      row.beforeJson ?? null,
      row.afterJson ?? null,
      row.prevHash ?? null,
      row.hash,
      row.actor,
    ],
  );
};
