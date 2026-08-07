import type { Pool } from "pg";
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
} from "@billme/server-core";
import type {
  PostgresQueryable,
  PostgresTransactionClient,
} from "./connection.js";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { schema, tryCreateDrizzle } from "./drizzle.js";
import { withPostgresTransaction } from "./connection.js";
import { createPostgresAuditLogPort } from "./audit.js";

export interface ServerSettingsRecord {
  tenantId: string;
  settingsJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServerNumberReservation {
  id: string;
  tenantId: string;
  kind: "invoice" | "offer" | "customer";
  number: string;
  counterValue: number;
  status: "reserved" | "released" | "finalized";
  documentId: string | null;
  createdAt: string;
  updatedAt: string;
}

type TenantRow = {
  id: string;
  slug: string;
  display_name: string;
  product: Tenant["product"];
  deployment_mode: Tenant["deploymentMode"];
  status: Tenant["status"];
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
  role: TenantMembership["role"];
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
  status: Client["status"];
  avatar: string | null;
  tags_json: string;
  notes: string;
  addresses_json: string | null;
  emails_json: string | null;
  projects_json: string | null;
  activities_json: string | null;
  tax_profile_json: string | null;
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
  status: Invoice["status"];
  dunning_level: number;
  items_json: string | null;
  payments_json: string | null;
  history_json: string | null;
  tax_mode: Invoice["taxMode"] | null;
  tax_meta_json: string | null;
  tax_snapshot_json: string | null;
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
  status: Offer["status"];
  items_json: string | null;
  tax_mode: Offer["taxMode"] | null;
  tax_meta_json: string | null;
  tax_snapshot_json: string | null;
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
  interval: RecurringProfile["interval"];
  next_run: string;
  last_run: string | null;
  end_date: string | null;
  amount: string | number;
  items_json: string | null;
  tax_mode: Invoice["taxMode"] | null;
  tax_meta_json: string | null;
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
  document_type: EmailOutboxEntry["documentType"];
  document_id: string;
  document_number: string;
  recipient_email: string;
  recipient_name: string;
  subject: string;
  body_text: string;
  status: EmailOutboxEntry["status"];
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string;
  last_attempt_at: string | null;
  locked_at: string | null;
  lease_expires_at: string | null;
  locked_by: string | null;
  last_error: string | null;
  provider: EmailOutboxEntry["provider"] | null;
  provider_message_id: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
};

const nowIso = (): string => new Date().toISOString();
const randomId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

const requireDrizzle = (db: PostgresQueryable) => {
  const drizzleDb = tryCreateDrizzle(db);
  if (!drizzleDb) {
    throw new Error('Postgres billing repositories require a real pg Pool/PoolClient');
  }
  return drizzleDb;
};

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) {
    return fallback;
  }

  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  return value as T;
};

const toJson = (value: unknown): string => JSON.stringify(value ?? null);
const toNumber = (value: string | number): number =>
  typeof value === "number" ? value : Number(value);

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
    taxProfile: parseJson(row.tax_profile_json, undefined),
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
  });

const rowToInvoice = (row: InvoiceRow): Invoice =>
  invoiceSchema.parse({
    kind: "invoice",
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
    taxMode: row.tax_mode ?? "standard_vat",
    taxMeta: parseJson(row.tax_meta_json, undefined),
    taxSnapshot: parseJson(row.tax_snapshot_json, undefined),
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
  });

const rowToOffer = (row: OfferRow): Offer =>
  offerSchema.parse({
    kind: "offer",
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
    items: parseJson(row.items_json, []),
    taxMode: row.tax_mode ?? "standard_vat",
    taxMeta: parseJson(row.tax_meta_json, undefined),
    taxSnapshot: parseJson(row.tax_snapshot_json, undefined),
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
    taxMode: row.tax_mode ?? "standard_vat",
    taxMeta: parseJson(row.tax_meta_json, undefined),
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

const toDunningHistoryRow = (row: any): DunningHistoryRow => ({
  id: row.id!,
  tenant_id: row.tenantId!,
  invoice_id: row.invoiceId!,
  invoice_number: row.invoiceNumber!,
  dunning_level: row.dunningLevel!,
  days_overdue: row.daysOverdue!,
  fee_applied: row.feeApplied!,
  email_sent: row.emailSent!,
  email_log_id: row.emailLogId ?? null,
  processed_at: row.processedAt!,
  created_at: row.createdAt!,
});

const toEmailOutboxRow = (row: any): EmailOutboxRow => ({
  id: row.id!,
  tenant_id: row.tenantId!,
  dedupe_key: row.dedupeKey!,
  document_type: row.documentType!,
  document_id: row.documentId!,
  document_number: row.documentNumber!,
  recipient_email: row.recipientEmail!,
  recipient_name: row.recipientName!,
  subject: row.subject!,
  body_text: row.bodyText!,
  status: row.status!,
  attempt_count: row.attemptCount!,
  max_attempts: row.maxAttempts!,
  next_attempt_at: row.nextAttemptAt!,
  last_attempt_at: row.lastAttemptAt ?? null,
  locked_at: row.lockedAt ?? null,
  lease_expires_at: row.leaseExpiresAt ?? null,
  locked_by: row.lockedBy ?? null,
  last_error: row.lastError ?? null,
  provider: row.provider ?? null,
  provider_message_id: row.providerMessageId ?? null,
  sent_at: row.sentAt ?? null,
  created_at: row.createdAt!,
  updated_at: row.updatedAt!,
});

const toTenantRow = (r: any): TenantRow => ({
  id: r.id!,
  slug: r.slug!,
  display_name: r.displayName!,
  product: r.product,
  deployment_mode: r.deploymentMode,
  status: r.status,
  created_at: r.createdAt!,
  updated_at: r.updatedAt!,
});
const toUserRow = (r: any): UserRow => ({
  id: r.id!,
  email: r.email!,
  full_name: r.fullName!,
  status: r.status,
  last_login_at: r.lastLoginAt ?? null,
  created_at: r.createdAt!,
  updated_at: r.updatedAt!,
});
const toMembershipRow = (r: any): MembershipRow => ({
  id: r.id!,
  tenant_id: r.tenantId!,
  user_id: r.userId!,
  role: r.role,
  invited_by_user_id: r.invitedByUserId ?? null,
  created_at: r.createdAt!,
  updated_at: r.updatedAt!,
});
const toClientRow = (r: any): ClientRow => ({
  id: r.id!,
  tenant_id: r.tenantId!,
  customer_number: r.customerNumber ?? null,
  company: r.company!,
  contact_person: r.contactPerson!,
  email: r.email!,
  phone: r.phone!,
  address: r.address!,
  status: r.status,
  avatar: r.avatar ?? null,
  tags_json: r.tagsJson!,
  notes: r.notes!,
  addresses_json: r.addressesJson ?? null,
  emails_json: r.emailsJson ?? null,
  projects_json: r.projectsJson ?? null,
  activities_json: r.activitiesJson ?? null,
  tax_profile_json: r.taxProfileJson ?? null,
  created_at: r.createdAt ?? null,
  updated_at: r.updatedAt ?? null,
});
const toInvoiceRow = (r: any): InvoiceRow => ({
  id: r.id!,
  tenant_id: r.tenantId!,
  client_id: r.clientId ?? null,
  client_number: r.clientNumber ?? null,
  project_id: r.projectId ?? null,
  number: r.number!,
  client: r.client!,
  client_email: r.clientEmail!,
  client_address: r.clientAddress ?? null,
  billing_address_json: r.billingAddressJson ?? null,
  shipping_address_json: r.shippingAddressJson ?? null,
  date: r.date!,
  due_date: r.dueDate!,
  service_period: r.servicePeriod ?? null,
  amount: r.amount as any,
  status: r.status,
  dunning_level: r.dunningLevel ?? 0,
  items_json: r.itemsJson ?? null,
  payments_json: r.paymentsJson ?? null,
  history_json: r.historyJson ?? null,
  tax_mode: r.taxMode ?? null,
  tax_meta_json: r.taxMetaJson ?? null,
  tax_snapshot_json: r.taxSnapshotJson ?? null,
  created_at: r.createdAt ?? null,
  updated_at: r.updatedAt ?? null,
});
const toOfferRow = (r: any): OfferRow => ({
  id: r.id!,
  tenant_id: r.tenantId!,
  client_id: r.clientId ?? null,
  client_number: r.clientNumber ?? null,
  project_id: r.projectId ?? null,
  number: r.number!,
  client: r.client!,
  client_email: r.clientEmail!,
  client_address: r.clientAddress ?? null,
  billing_address_json: r.billingAddressJson ?? null,
  shipping_address_json: r.shippingAddressJson ?? null,
  date: r.date!,
  valid_until: r.validUntil!,
  amount: r.amount as any,
  status: r.status,
  items_json: r.itemsJson ?? null,
  tax_mode: r.taxMode ?? null,
  tax_meta_json: r.taxMetaJson ?? null,
  tax_snapshot_json: r.taxSnapshotJson ?? null,
  share_json: r.shareJson ?? null,
  history_json: r.historyJson ?? null,
  created_at: r.createdAt ?? null,
  updated_at: r.updatedAt ?? null,
});
const toRecurringRow = (r: any): RecurringProfileRow => ({
  id: r.id!,
  tenant_id: r.tenantId!,
  client_id: r.clientId!,
  active: r.active!,
  name: r.name!,
  interval: r.interval,
  next_run: r.nextRun!,
  last_run: r.lastRun ?? null,
  end_date: r.endDate ?? null,
  amount: r.amount as any,
  items_json: r.itemsJson ?? null,
  tax_mode: r.taxMode ?? null,
  tax_meta_json: r.taxMetaJson ?? null,
  created_at: r.createdAt ?? null,
  updated_at: r.updatedAt ?? null,
});

export const createPostgresTenantRepository = (
  db: PostgresQueryable,
): TenantRepository => ({
  async getById(id) {
    const drizzleDb = requireDrizzle(db);
      const rows = await drizzleDb
        .select()
        .from(schema.tenants)
        .where(eq(schema.tenants.id, id))
        .limit(1);
      return rows[0] ? rowToTenant(toTenantRow(rows[0])) : null;
      },
  async getPrimary() {
    const drizzleDb = requireDrizzle(db);
      const rows = await drizzleDb
        .select()
        .from(schema.tenants)
        .orderBy(asc(schema.tenants.createdAt))
        .limit(1);
      return rows[0] ? rowToTenant(toTenantRow(rows[0])) : null;
      },
  async save(tenant) {
    const nextTenant: Tenant = {
      ...tenant,
      createdAt: tenant.createdAt ?? nowIso(),
      updatedAt: tenant.updatedAt ?? nowIso(),
    };
    const drizzleDb = requireDrizzle(db);
      await drizzleDb
        .insert(schema.tenants)
        .values({
          id: nextTenant.id,
          slug: nextTenant.slug,
          displayName: nextTenant.displayName,
          product: nextTenant.product,
          deploymentMode: nextTenant.deploymentMode,
          status: nextTenant.status,
          createdAt: nextTenant.createdAt,
          updatedAt: nextTenant.updatedAt,
        })
        .onConflictDoUpdate({
          target: schema.tenants.id,
          set: {
            slug: nextTenant.slug,
            displayName: nextTenant.displayName,
            product: nextTenant.product,
            deploymentMode: nextTenant.deploymentMode,
            status: nextTenant.status,
            updatedAt: nextTenant.updatedAt,
          },
        });
      return nextTenant;
      },
});

export const createPostgresUserRepository = (
  db: PostgresQueryable,
): UserAccountRepository => ({
  async getById(scope, id) {
    const drizzleDb = requireDrizzle(db);
      const rows = await drizzleDb
        .select({ user: schema.userAccounts })
        .from(schema.userAccounts)
        .innerJoin(
          schema.tenantMemberships,
          eq(schema.userAccounts.id, schema.tenantMemberships.userId),
        )
        .where(
          and(
            eq(schema.tenantMemberships.tenantId, scope.tenantId),
            eq(schema.userAccounts.id, id),
          ),
        )
        .limit(1);
      return rows[0] ? rowToUser(toUserRow(rows[0].user)) : null;
      },
  async getByEmail(scope, email) {
    const drizzleDb = requireDrizzle(db);
      const rows = await drizzleDb
        .select({ user: schema.userAccounts })
        .from(schema.userAccounts)
        .innerJoin(
          schema.tenantMemberships,
          eq(schema.userAccounts.id, schema.tenantMemberships.userId),
        )
        .where(
          and(
            eq(schema.tenantMemberships.tenantId, scope.tenantId),
            eq(schema.userAccounts.email, email),
          ),
        )
        .limit(1);
      return rows[0] ? rowToUser(toUserRow(rows[0].user)) : null;
      },
  async list(scope) {
    const drizzleDb = requireDrizzle(db);
      const rows = await drizzleDb
        .select({ user: schema.userAccounts })
        .from(schema.userAccounts)
        .innerJoin(
          schema.tenantMemberships,
          eq(schema.userAccounts.id, schema.tenantMemberships.userId),
        )
        .where(eq(schema.tenantMemberships.tenantId, scope.tenantId))
        .orderBy(asc(schema.userAccounts.createdAt));
      return rows.map((row) => rowToUser(toUserRow(row.user)));
      },
  async save(_scope, user) {
    const nextUser: UserAccount = {
      ...user,
      createdAt: user.createdAt ?? nowIso(),
      updatedAt: user.updatedAt ?? nowIso(),
    };
    const drizzleDb = requireDrizzle(db);
      await drizzleDb
        .insert(schema.userAccounts)
        .values({
          id: nextUser.id,
          email: nextUser.email,
          fullName: nextUser.fullName,
          status: nextUser.status,
          lastLoginAt: nextUser.lastLoginAt ?? null,
          createdAt: nextUser.createdAt,
          updatedAt: nextUser.updatedAt,
        })
        .onConflictDoUpdate({
          target: schema.userAccounts.id,
          set: {
            email: nextUser.email,
            fullName: nextUser.fullName,
            status: nextUser.status,
            lastLoginAt: nextUser.lastLoginAt ?? null,
            updatedAt: nextUser.updatedAt,
          },
        });
      return nextUser;
      },
});

export const createPostgresTenantMembershipRepository = (
  db: PostgresQueryable,
): TenantMembershipRepository => ({
  async list(scope) {
    const drizzleDb = requireDrizzle(db);
      const rows = await drizzleDb
        .select()
        .from(schema.tenantMemberships)
        .where(eq(schema.tenantMemberships.tenantId, scope.tenantId))
        .orderBy(asc(schema.tenantMemberships.createdAt));
      return rows.map((row) => rowToMembership(toMembershipRow(row)));
      },
  async get(scope, userId) {
    const drizzleDb = requireDrizzle(db);
      const rows = await drizzleDb
        .select()
        .from(schema.tenantMemberships)
        .where(
          and(
            eq(schema.tenantMemberships.tenantId, scope.tenantId),
            eq(schema.tenantMemberships.userId, userId),
          ),
        )
        .limit(1);
      return rows[0] ? rowToMembership(toMembershipRow(rows[0])) : null;
      },
  async save(_scope, membership) {
    const nextMembership: TenantMembership = {
      ...membership,
      createdAt: membership.createdAt ?? nowIso(),
      updatedAt: membership.updatedAt ?? nowIso(),
    };
    const drizzleDb = requireDrizzle(db);
      await drizzleDb
        .insert(schema.tenantMemberships)
        .values({
          id: nextMembership.id,
          tenantId: nextMembership.tenantId,
          userId: nextMembership.userId,
          role: nextMembership.role,
          invitedByUserId: nextMembership.invitedByUserId ?? null,
          createdAt: nextMembership.createdAt,
          updatedAt: nextMembership.updatedAt,
        })
        .onConflictDoUpdate({
          target: schema.tenantMemberships.id,
          set: {
            tenantId: nextMembership.tenantId,
            userId: nextMembership.userId,
            role: nextMembership.role,
            invitedByUserId: nextMembership.invitedByUserId ?? null,
            updatedAt: nextMembership.updatedAt,
          },
        });
      return nextMembership;
      },
});

export const createPostgresClientRepository = (
  db: PostgresQueryable,
): ClientRepository => ({
  async list(scope) {
    const drizzleDb = requireDrizzle(db);
      const rows = await drizzleDb
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.tenantId, scope.tenantId))
        .orderBy(asc(schema.clients.company), asc(schema.clients.id));
      return rows.map((row) => rowToClient(toClientRow(row)));
      },
  async getById(scope, id) {
    const drizzleDb = requireDrizzle(db);
      const rows = await drizzleDb
        .select()
        .from(schema.clients)
        .where(
          and(
            eq(schema.clients.tenantId, scope.tenantId),
            eq(schema.clients.id, id),
          ),
        )
        .limit(1);
      return rows[0] ? rowToClient(toClientRow(rows[0])) : null;
      },
  async save(scope, client) {
    const nextClient: Client = {
      ...client,
      tenantId: scope.tenantId,
      createdAt: client.createdAt ?? nowIso(),
      updatedAt: client.updatedAt ?? nowIso(),
    };
    const drizzleDb = requireDrizzle(db);
      await drizzleDb
        .insert(schema.clients)
        .values({
          id: nextClient.id,
          tenantId: scope.tenantId,
          customerNumber: nextClient.customerNumber ?? null,
          company: nextClient.company,
          contactPerson: nextClient.contactPerson,
          email: nextClient.email,
          phone: nextClient.phone,
          address: nextClient.address,
          status: nextClient.status,
          avatar: nextClient.avatar ?? null,
          tagsJson: toJson(nextClient.tags),
          notes: nextClient.notes,
          addressesJson: toJson(nextClient.addresses ?? []),
          emailsJson: toJson(nextClient.emails ?? []),
          projectsJson: toJson(nextClient.projects ?? []),
          activitiesJson: toJson(nextClient.activities ?? []),
          taxProfileJson: nextClient.taxProfile
            ? toJson(nextClient.taxProfile)
            : null,
          createdAt: nextClient.createdAt ?? null,
          updatedAt: nextClient.updatedAt ?? null,
        })
        .onConflictDoUpdate({
          target: schema.clients.id,
          set: {
            tenantId: scope.tenantId,
            customerNumber: nextClient.customerNumber ?? null,
            company: nextClient.company,
            contactPerson: nextClient.contactPerson,
            email: nextClient.email,
            phone: nextClient.phone,
            address: nextClient.address,
            status: nextClient.status,
            avatar: nextClient.avatar ?? null,
            tagsJson: toJson(nextClient.tags),
            notes: nextClient.notes,
            addressesJson: toJson(nextClient.addresses ?? []),
            emailsJson: toJson(nextClient.emails ?? []),
            projectsJson: toJson(nextClient.projects ?? []),
            activitiesJson: toJson(nextClient.activities ?? []),
            taxProfileJson: nextClient.taxProfile
              ? toJson(nextClient.taxProfile)
              : null,
            updatedAt: nextClient.updatedAt ?? null,
          },
        });
      return nextClient;
      },
  async remove(scope, id) {
    const drizzleDb = requireDrizzle(db);
      await drizzleDb
        .delete(schema.clients)
        .where(
          and(
            eq(schema.clients.tenantId, scope.tenantId),
            eq(schema.clients.id, id),
          ),
        );
      return;
      },
});

export const createPostgresInvoiceRepository = (
  db: PostgresQueryable,
): InvoiceRepository => ({
  async list(scope) {
    const drizzleDb = requireDrizzle(db);
      const rows = await drizzleDb
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.tenantId, scope.tenantId))
        .orderBy(
          desc(schema.invoices.date),
          desc(schema.invoices.createdAt),
          desc(schema.invoices.id),
        );
      return rows.map((row) => rowToInvoice(toInvoiceRow(row)));
      },
  async getById(scope, id) {
    const drizzleDb = requireDrizzle(db);
      const rows = await drizzleDb
        .select()
        .from(schema.invoices)
        .where(
          and(
            eq(schema.invoices.tenantId, scope.tenantId),
            eq(schema.invoices.id, id),
          ),
        )
        .limit(1);
      return rows[0] ? rowToInvoice(toInvoiceRow(rows[0])) : null;
      },
  async save(scope, invoice) {
    const nextInvoice: Invoice = {
      ...invoice,
      tenantId: scope.tenantId,
      createdAt: invoice.createdAt ?? nowIso(),
      updatedAt: invoice.updatedAt ?? nowIso(),
    };
    const drizzleDb = requireDrizzle(db);
      await drizzleDb
        .insert(schema.invoices)
        .values({
          id: nextInvoice.id,
          tenantId: scope.tenantId,
          clientId: nextInvoice.clientId ?? null,
          clientNumber: nextInvoice.clientNumber ?? null,
          projectId: nextInvoice.projectId ?? null,
          number: nextInvoice.number,
          client: nextInvoice.client,
          clientEmail: nextInvoice.clientEmail,
          clientAddress: nextInvoice.clientAddress ?? null,
          billingAddressJson: nextInvoice.billingAddress
            ? toJson(nextInvoice.billingAddress)
            : null,
          shippingAddressJson: nextInvoice.shippingAddress
            ? toJson(nextInvoice.shippingAddress)
            : null,
          date: nextInvoice.date,
          dueDate: nextInvoice.dueDate,
          servicePeriod: nextInvoice.servicePeriod ?? null,
          amount: String(nextInvoice.amount),
          status: nextInvoice.status,
          dunningLevel: nextInvoice.dunningLevel ?? 0,
          itemsJson: toJson(nextInvoice.items ?? []),
          paymentsJson: toJson(nextInvoice.payments ?? []),
          historyJson: toJson(nextInvoice.history ?? []),
          taxMode: nextInvoice.taxMode ?? "standard_vat",
          taxMetaJson: nextInvoice.taxMeta ? toJson(nextInvoice.taxMeta) : null,
          taxSnapshotJson: nextInvoice.taxSnapshot
            ? toJson(nextInvoice.taxSnapshot)
            : null,
          createdAt: nextInvoice.createdAt ?? null,
          updatedAt: nextInvoice.updatedAt ?? null,
        })
        .onConflictDoUpdate({
          target: schema.invoices.id,
          set: {
            tenantId: scope.tenantId,
            clientId: nextInvoice.clientId ?? null,
            clientNumber: nextInvoice.clientNumber ?? null,
            projectId: nextInvoice.projectId ?? null,
            number: nextInvoice.number,
            client: nextInvoice.client,
            clientEmail: nextInvoice.clientEmail,
            clientAddress: nextInvoice.clientAddress ?? null,
            billingAddressJson: nextInvoice.billingAddress
              ? toJson(nextInvoice.billingAddress)
              : null,
            shippingAddressJson: nextInvoice.shippingAddress
              ? toJson(nextInvoice.shippingAddress)
              : null,
            date: nextInvoice.date,
            dueDate: nextInvoice.dueDate,
            servicePeriod: nextInvoice.servicePeriod ?? null,
            amount: String(nextInvoice.amount),
            status: nextInvoice.status,
            dunningLevel: nextInvoice.dunningLevel ?? 0,
            itemsJson: toJson(nextInvoice.items ?? []),
            paymentsJson: toJson(nextInvoice.payments ?? []),
            historyJson: toJson(nextInvoice.history ?? []),
            taxMode: nextInvoice.taxMode ?? "standard_vat",
            taxMetaJson: nextInvoice.taxMeta
              ? toJson(nextInvoice.taxMeta)
              : null,
            taxSnapshotJson: nextInvoice.taxSnapshot
              ? toJson(nextInvoice.taxSnapshot)
              : null,
            updatedAt: nextInvoice.updatedAt ?? null,
          },
        });
      return nextInvoice;
      },
  async remove(scope, id) {
    const drizzleDb = requireDrizzle(db);
      await drizzleDb
        .delete(schema.invoices)
        .where(
          and(
            eq(schema.invoices.tenantId, scope.tenantId),
            eq(schema.invoices.id, id),
          ),
        );
      return;
      },
});

export const createPostgresOfferRepository = (
  db: PostgresQueryable,
): OfferRepository => ({
  async list(scope) {
    const drizzleDb = requireDrizzle(db);
      const rows = await drizzleDb
        .select()
        .from(schema.offers)
        .where(eq(schema.offers.tenantId, scope.tenantId))
        .orderBy(
          desc(schema.offers.date),
          desc(schema.offers.createdAt),
          desc(schema.offers.id),
        );
      return rows.map((row) => rowToOffer(toOfferRow(row)));
      },
  async getById(scope, id) {
    const drizzleDb = requireDrizzle(db);
      const rows = await drizzleDb
        .select()
        .from(schema.offers)
        .where(
          and(
            eq(schema.offers.tenantId, scope.tenantId),
            eq(schema.offers.id, id),
          ),
        )
        .limit(1);
      return rows[0] ? rowToOffer(toOfferRow(rows[0])) : null;
      },
  async save(scope, offer) {
    const nextOffer: Offer = {
      ...offer,
      tenantId: scope.tenantId,
      createdAt: offer.createdAt ?? nowIso(),
      updatedAt: offer.updatedAt ?? nowIso(),
    };
    const drizzleDb = requireDrizzle(db);
      await drizzleDb
        .insert(schema.offers)
        .values({
          id: nextOffer.id,
          tenantId: scope.tenantId,
          clientId: nextOffer.clientId ?? null,
          clientNumber: nextOffer.clientNumber ?? null,
          projectId: nextOffer.projectId ?? null,
          number: nextOffer.number,
          client: nextOffer.client,
          clientEmail: nextOffer.clientEmail,
          clientAddress: nextOffer.clientAddress ?? null,
          billingAddressJson: nextOffer.billingAddress
            ? toJson(nextOffer.billingAddress)
            : null,
          shippingAddressJson: nextOffer.shippingAddress
            ? toJson(nextOffer.shippingAddress)
            : null,
          date: nextOffer.date,
          validUntil: nextOffer.validUntil,
          amount: String(nextOffer.amount),
          status: nextOffer.status,
          shareJson: nextOffer.share ? toJson(nextOffer.share) : null,
          historyJson: toJson(nextOffer.history ?? []),
          itemsJson: toJson(nextOffer.items ?? []),
          taxMode: nextOffer.taxMode ?? "standard_vat",
          taxMetaJson: nextOffer.taxMeta ? toJson(nextOffer.taxMeta) : null,
          taxSnapshotJson: nextOffer.taxSnapshot
            ? toJson(nextOffer.taxSnapshot)
            : null,
          createdAt: nextOffer.createdAt ?? null,
          updatedAt: nextOffer.updatedAt ?? null,
        })
        .onConflictDoUpdate({
          target: schema.offers.id,
          set: {
            tenantId: scope.tenantId,
            clientId: nextOffer.clientId ?? null,
            clientNumber: nextOffer.clientNumber ?? null,
            projectId: nextOffer.projectId ?? null,
            number: nextOffer.number,
            client: nextOffer.client,
            clientEmail: nextOffer.clientEmail,
            clientAddress: nextOffer.clientAddress ?? null,
            billingAddressJson: nextOffer.billingAddress
              ? toJson(nextOffer.billingAddress)
              : null,
            shippingAddressJson: nextOffer.shippingAddress
              ? toJson(nextOffer.shippingAddress)
              : null,
            date: nextOffer.date,
            validUntil: nextOffer.validUntil,
            amount: String(nextOffer.amount),
            status: nextOffer.status,
            shareJson: nextOffer.share ? toJson(nextOffer.share) : null,
            historyJson: toJson(nextOffer.history ?? []),
            itemsJson: toJson(nextOffer.items ?? []),
            taxMode: nextOffer.taxMode ?? "standard_vat",
            taxMetaJson: nextOffer.taxMeta ? toJson(nextOffer.taxMeta) : null,
            taxSnapshotJson: nextOffer.taxSnapshot
              ? toJson(nextOffer.taxSnapshot)
              : null,
            updatedAt: nextOffer.updatedAt ?? null,
          },
        });
      return nextOffer;
      },
  async remove(scope, id) {
    const drizzleDb = requireDrizzle(db);
      await drizzleDb
        .delete(schema.offers)
        .where(
          and(
            eq(schema.offers.tenantId, scope.tenantId),
            eq(schema.offers.id, id),
          ),
        );
      return;
      },
});

export const createPostgresRecurringProfileRepository = (
  db: PostgresQueryable,
): RecurringProfileRepository => ({
  async list(scope) {
    const drizzleDb = requireDrizzle(db);
      const rows = await drizzleDb
        .select()
        .from(schema.recurringProfiles)
        .where(eq(schema.recurringProfiles.tenantId, scope.tenantId))
        .orderBy(
          asc(schema.recurringProfiles.nextRun),
          asc(schema.recurringProfiles.name),
        );
      return rows.map((row) => rowToRecurringProfile(toRecurringRow(row)));
      },
  async getById(scope, id) {
    const drizzleDb = requireDrizzle(db);
      const rows = await drizzleDb
        .select()
        .from(schema.recurringProfiles)
        .where(
          and(
            eq(schema.recurringProfiles.tenantId, scope.tenantId),
            eq(schema.recurringProfiles.id, id),
          ),
        )
        .limit(1);
      return rows[0] ? rowToRecurringProfile(toRecurringRow(rows[0])) : null;
      },
  async save(scope, profile) {
    const nextProfile: RecurringProfile = {
      ...profile,
      tenantId: scope.tenantId,
      createdAt: profile.createdAt ?? nowIso(),
      updatedAt: profile.updatedAt ?? nowIso(),
    };
    const drizzleDb = requireDrizzle(db);
      await drizzleDb
        .insert(schema.recurringProfiles)
        .values({
          id: nextProfile.id,
          tenantId: scope.tenantId,
          clientId: nextProfile.clientId,
          active: nextProfile.active,
          name: nextProfile.name,
          interval: nextProfile.interval,
          nextRun: nextProfile.nextRun,
          lastRun: nextProfile.lastRun ?? null,
          endDate: nextProfile.endDate ?? null,
          amount: String(nextProfile.amount),
          itemsJson: toJson(nextProfile.items ?? []),
          taxMode: nextProfile.taxMode ?? "standard_vat",
          taxMetaJson: nextProfile.taxMeta ? toJson(nextProfile.taxMeta) : null,
          createdAt: nextProfile.createdAt ?? null,
          updatedAt: nextProfile.updatedAt ?? null,
        })
        .onConflictDoUpdate({
          target: schema.recurringProfiles.id,
          set: {
            tenantId: scope.tenantId,
            clientId: nextProfile.clientId,
            active: nextProfile.active,
            name: nextProfile.name,
            interval: nextProfile.interval,
            nextRun: nextProfile.nextRun,
            lastRun: nextProfile.lastRun ?? null,
            endDate: nextProfile.endDate ?? null,
            amount: String(nextProfile.amount),
            itemsJson: toJson(nextProfile.items ?? []),
            taxMode: nextProfile.taxMode ?? "standard_vat",
            taxMetaJson: nextProfile.taxMeta
              ? toJson(nextProfile.taxMeta)
              : null,
            updatedAt: nextProfile.updatedAt ?? null,
          },
        });
      return nextProfile;
      },
  async remove(scope, id) {
    const drizzleDb = requireDrizzle(db);
    await drizzleDb
      .delete(schema.recurringProfiles)
      .where(
        and(
          eq(schema.recurringProfiles.tenantId, scope.tenantId),
          eq(schema.recurringProfiles.id, id),
        ),
      );
  },
});

export const createPostgresDunningHistoryRepository = (
  db: PostgresQueryable,
): DunningHistoryRepository => ({
  async listByInvoice(scope, invoiceId) {
    const drizzleDb = requireDrizzle(db);
    const rows = await drizzleDb
      .select()
      .from(schema.dunningHistory)
      .where(
        and(
          eq(schema.dunningHistory.tenantId, scope.tenantId),
          eq(schema.dunningHistory.invoiceId, invoiceId),
        ),
      )
      .orderBy(desc(schema.dunningHistory.dunningLevel), desc(schema.dunningHistory.processedAt));
    return rows.map((row) => rowToDunningHistory(toDunningHistoryRow(row)));
  },
  async record(scope, entry: DunningHistoryEntryDraft) {
    const createdAt = nowIso();
    const id = randomId();
    const drizzleDb = requireDrizzle(db);
    await drizzleDb.insert(schema.dunningHistory).values({
      id,
      tenantId: scope.tenantId,
      invoiceId: entry.invoiceId,
      invoiceNumber: entry.invoiceNumber,
      dunningLevel: entry.dunningLevel,
      daysOverdue: entry.daysOverdue,
      feeApplied: String(entry.feeApplied),
      emailSent: entry.emailSent,
      emailLogId: entry.emailLogId ?? null,
      processedAt: entry.processedAt,
      createdAt,
    });
    return {
      ...entry,
      id,
      createdAt,
    };
  },
});

export const createPostgresEmailOutboxRepository = (
  db: PostgresQueryable,
): EmailOutboxRepository => ({
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
      status: "pending" as const,
      attemptCount: 0,
      maxAttempts: entry.maxAttempts ?? defaultEmailOutboxMaxAttempts,
      nextAttemptAt: entry.nextAttemptAt ?? createdAt,
      createdAt,
      updatedAt: createdAt,
    };

    const drizzleDb = requireDrizzle(db);
    const inserted = await drizzleDb
      .insert(schema.emailOutbox)
      .values(nextEntry)
      .onConflictDoNothing()
      .returning();

    if (inserted[0]) {
      return rowToEmailOutbox(toEmailOutboxRow(inserted[0]));
    }

    const existing = await drizzleDb
      .select()
      .from(schema.emailOutbox)
      .where(
        and(
          eq(schema.emailOutbox.tenantId, scope.tenantId),
          eq(schema.emailOutbox.dedupeKey, nextEntry.dedupeKey),
          inArray(schema.emailOutbox.status, ['pending', 'processing']),
        ),
      )
      .orderBy(asc(schema.emailOutbox.createdAt))
      .limit(1);

    if (!existing[0]) {
      throw new Error("Failed to enqueue email outbox entry");
    }

    return rowToEmailOutbox(toEmailOutboxRow(existing[0]));
  },

  async claimDue(scope, args) {
    const drizzleDb = requireDrizzle(db);
    const rows = await drizzleDb.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(schema.emailOutbox)
        .where(
          and(
            eq(schema.emailOutbox.tenantId, scope.tenantId),
            or(
              and(
                eq(schema.emailOutbox.status, 'pending'),
                lte(schema.emailOutbox.nextAttemptAt, args.now),
              ),
              and(
                eq(schema.emailOutbox.status, 'processing'),
                isNotNull(schema.emailOutbox.leaseExpiresAt),
                lte(schema.emailOutbox.leaseExpiresAt, args.now),
              ),
            ),
          ),
        )
        .orderBy(asc(schema.emailOutbox.nextAttemptAt), asc(schema.emailOutbox.createdAt))
        .limit(args.limit)
        .for('update', { skipLocked: true });
      if (!due.length) return [];
      const updated = await tx
        .update(schema.emailOutbox)
        .set({
          status: 'processing',
          lockedBy: args.workerId,
          lockedAt: args.now,
          leaseExpiresAt: args.leaseExpiresAt,
          updatedAt: args.now,
        })
        .where(inArray(schema.emailOutbox.id, due.map((row) => row.id!)))
        .returning();
      return updated;
    });
    return rows.map((row) => rowToEmailOutbox(toEmailOutboxRow(row)));
  },

  async markSent(scope, args) {
    const drizzleDb = requireDrizzle(db);
    const rows = await drizzleDb
      .update(schema.emailOutbox)
      .set({
        status: 'sent',
        attemptCount: sql`${schema.emailOutbox.attemptCount} + 1`,
        nextAttemptAt: args.sentAt,
        lastAttemptAt: args.sentAt,
        lastError: null,
        provider: args.provider,
        providerMessageId: args.providerMessageId ?? null,
        sentAt: args.sentAt,
        lockedAt: null,
        leaseExpiresAt: null,
        lockedBy: null,
        updatedAt: args.sentAt,
      })
      .where(
        and(
          eq(schema.emailOutbox.tenantId, scope.tenantId),
          eq(schema.emailOutbox.id, args.id),
          eq(schema.emailOutbox.status, 'processing'),
          eq(schema.emailOutbox.lockedBy, args.workerId),
        ),
      )
      .returning();

    return rows[0] ? rowToEmailOutbox(toEmailOutboxRow(rows[0])) : null;
  },

  async markFailed(scope, args) {
    const drizzleDb = requireDrizzle(db);
    const rows = await drizzleDb
      .update(schema.emailOutbox)
      .set({
        status: sql`CASE WHEN ${schema.emailOutbox.attemptCount} + 1 >= ${schema.emailOutbox.maxAttempts} OR ${args.retryAt ?? null} IS NULL THEN 'failed' ELSE 'pending' END`,
        attemptCount: sql`${schema.emailOutbox.attemptCount} + 1`,
        nextAttemptAt: sql`CASE WHEN ${schema.emailOutbox.attemptCount} + 1 >= ${schema.emailOutbox.maxAttempts} OR ${args.retryAt ?? null} IS NULL THEN ${args.failedAt} ELSE ${args.retryAt} END`,
        lastAttemptAt: args.failedAt,
        lastError: args.error,
        provider: args.provider,
        providerMessageId: null,
        lockedAt: null,
        leaseExpiresAt: null,
        lockedBy: null,
        updatedAt: args.failedAt,
      })
      .where(
        and(
          eq(schema.emailOutbox.tenantId, scope.tenantId),
          eq(schema.emailOutbox.id, args.id),
          eq(schema.emailOutbox.status, 'processing'),
          eq(schema.emailOutbox.lockedBy, args.workerId),
        ),
      )
      .returning();

    return rows[0] ? rowToEmailOutbox(toEmailOutboxRow(rows[0])) : null;
  },
});

export const getServerSettings = async (
  db: PostgresQueryable,
  tenantId: string,
): Promise<ServerSettingsRecord | null> => {
  const drizzleDb = requireDrizzle(db);
    const row = await drizzleDb
      .select()
      .from(schema.serverSettings)
      .where(eq(schema.serverSettings.tenantId, tenantId))
      .limit(1);
    const value = row[0];
    return value
      ? {
          tenantId: value.tenantId!,
          settingsJson: value.settingsJson!,
          createdAt: value.createdAt!,
          updatedAt: value.updatedAt!,
        }
      : null;
};

export const saveServerSettings = async (
  db: PostgresQueryable,
  record: ServerSettingsRecord,
): Promise<ServerSettingsRecord> => {
  const nextRecord: ServerSettingsRecord = {
    ...record,
    createdAt: record.createdAt || nowIso(),
    updatedAt: record.updatedAt || nowIso(),
  };
  const drizzleDb = requireDrizzle(db);
    await drizzleDb
      .insert(schema.serverSettings)
      .values({
        tenantId: nextRecord.tenantId,
        settingsJson: nextRecord.settingsJson,
        createdAt: nextRecord.createdAt,
        updatedAt: nextRecord.updatedAt,
      })
      .onConflictDoUpdate({
        target: schema.serverSettings.tenantId,
        set: {
          settingsJson: nextRecord.settingsJson,
          updatedAt: nextRecord.updatedAt,
        },
      });
    return nextRecord;
  };

export const listServerNumberReservations = async (
  db: PostgresQueryable,
  tenantId: string,
): Promise<ServerNumberReservation[]> => {
  const drizzleDb = requireDrizzle(db);
    const rows = await drizzleDb
      .select()
      .from(schema.numberReservations)
      .where(eq(schema.numberReservations.tenantId, tenantId))
      .orderBy(asc(schema.numberReservations.createdAt));
    return rows.map((row) => ({
      id: row.id!,
      tenantId: row.tenantId!,
      kind: row.kind as ServerNumberReservation["kind"],
      number: row.number!,
      counterValue: row.counterValue!,
      status: row.status as ServerNumberReservation["status"],
      documentId: row.documentId ?? null,
      createdAt: row.createdAt!,
      updatedAt: row.updatedAt!,
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

  const drizzleDb = requireDrizzle(db);
    await drizzleDb
      .insert(schema.numberReservations)
      .values({
        id: nextReservation.id,
        tenantId: nextReservation.tenantId,
        kind: nextReservation.kind,
        number: nextReservation.number,
        counterValue: nextReservation.counterValue,
        status: nextReservation.status,
        documentId: nextReservation.documentId,
        createdAt: nextReservation.createdAt,
        updatedAt: nextReservation.updatedAt,
      })
      .onConflictDoUpdate({
        target: schema.numberReservations.id,
        set: {
          tenantId: nextReservation.tenantId,
          kind: nextReservation.kind,
          number: nextReservation.number,
          counterValue: nextReservation.counterValue,
          status: nextReservation.status,
          documentId: nextReservation.documentId,
          updatedAt: nextReservation.updatedAt,
        },
      });
    return nextReservation;
  };

export const deleteReleasedServerNumberReservationsBefore = async (
  db: PostgresQueryable,
  tenantId: string,
  updatedBefore: string,
): Promise<number> => {
  const drizzleDb = requireDrizzle(db);
  const rows = await drizzleDb
    .delete(schema.numberReservations)
    .where(
      and(
        eq(schema.numberReservations.tenantId, tenantId),
        eq(schema.numberReservations.status, 'released'),
        isNotNull(schema.numberReservations.updatedAt),
        lt(schema.numberReservations.updatedAt, updatedBefore),
      ),
    )
    .returning({ id: schema.numberReservations.id });
  return rows.length;
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

  const drizzleDb = requireDrizzle(db);
  const rows = await drizzleDb
    .delete(schema.sqliteImportRuns)
    .where(
      and(
        eq(schema.sqliteImportRuns.tenantId, tenantId),
        inArray(schema.sqliteImportRuns.status, statuses),
        isNotNull(schema.sqliteImportRuns.completedAt),
        lt(schema.sqliteImportRuns.completedAt, completedBefore),
      ),
    )
    .returning({ id: schema.sqliteImportRuns.id });
  return rows.length;
};

export const createPostgresMaintenanceRepository = (
  db: PostgresQueryable,
): MaintenanceRetentionRepository => ({
  deleteReleasedNumberReservations(scope, args) {
    return deleteReleasedServerNumberReservationsBefore(
      db,
      scope.tenantId,
      args.updatedBefore,
    );
  },
  deleteSqliteImportRuns(scope, args) {
    return deleteServerSqliteImportRunsBefore(
      db,
      scope.tenantId,
      args.completedBefore,
      args.statuses,
    );
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

export const createPostgresBillingUnitOfWork = (
  pool: Pool,
): BillingUnitOfWork => ({
  async withTransaction<TResult>(
    scope: TenantScope,
    work: (context: BillingUnitOfWorkContext) => Promise<TResult> | TResult,
  ) {
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

export const createDefaultTenantScope = (
  tenantId: string,
  product: Tenant["product"],
): TenantScope => {
  return createSingleTenantScope(tenantId, product);
};

export const tenantCoreRowCountTables = [
  "server_settings",
  "number_reservations",
  "clients",
  "invoices",
  "offers",
  "recurring_profiles",
  "articles",
  "accounts",
  "pro_workflow_entries",
  "bank_transactions",
  "booking_drafts",
  "booking_draft_lines",
  "draft_validation_issues",
  "accounting_periods",
  "journal_entries",
  "journal_lines",
  "assets",
  "asset_depreciation_schedule",
  "asset_movements",
  "account_mappings_hgb",
  "report_snapshots",
  "datev_exports",
  "vat_evidence",
  "journal_posting_pairs",
  "transactions",
  "eur_classifications",
  "eur_rules",
  "account_keywords",
  "account_suggestion_rules",
  "import_batches",
  "templates",
  "active_templates",
  "dunning_history",
  "email_outbox",
  "email_log",
  "audit_log",
] as const;

export const countTenantCoreRows = async (
  db: PostgresQueryable,
  tenantId: string,
): Promise<number> => {
  const drizzleDb = requireDrizzle(db);
  const tableMap: Record<string, any> = {
    server_settings: schema.serverSettings,
    number_reservations: schema.numberReservations,
    clients: schema.clients,
    invoices: schema.invoices,
    offers: schema.offers,
    recurring_profiles: schema.recurringProfiles,
    articles: schema.articles,
    accounts: schema.accounts,
    pro_workflow_entries: schema.proWorkflowEntries,
    bank_transactions: schema.bankTransactions,
    booking_drafts: schema.bookingDrafts,
    booking_draft_lines: schema.bookingDraftLines,
    draft_validation_issues: schema.draftValidationIssues,
    accounting_periods: schema.accountingPeriods,
    journal_entries: schema.journalEntries,
    journal_lines: schema.journalLines,
    assets: schema.assets,
    asset_depreciation_schedule: schema.assetDepreciationSchedule,
    asset_movements: schema.assetMovements,
    account_mappings_hgb: schema.accountMappingsHgb,
    report_snapshots: schema.reportSnapshots,
    datev_exports: schema.datevExports,
    vat_evidence: schema.vatEvidence,
    journal_posting_pairs: schema.journalPostingPairs,
    transactions: schema.transactions,
    eur_classifications: schema.eurClassifications,
    eur_rules: schema.eurRules,
    account_keywords: schema.accountKeywords,
    account_suggestion_rules: schema.accountSuggestionRules,
    import_batches: schema.importBatches,
    templates: schema.templates,
    active_templates: schema.activeTemplates,
    dunning_history: schema.dunningHistory,
    email_outbox: schema.emailOutbox,
    email_log: schema.emailLog,
    audit_log: schema.auditLog,
  };
  let total = 0;
  for (const tableName of tenantCoreRowCountTables) {
    const table = tableMap[tableName];
    if (!table) continue;
    const rows = await drizzleDb
      .select({ count: count() })
      .from(table)
      .where(eq(table.tenantId, tenantId));
    total += Number(rows[0]?.count ?? 0);
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
  const drizzleDb = requireDrizzle(db);
  await drizzleDb.insert(schema.emailLog).values({
    id: row.id,
    tenantId,
    documentType: row.documentType,
    documentId: row.documentId,
    documentNumber: row.documentNumber,
    recipientEmail: row.recipientEmail,
    recipientName: row.recipientName,
    subject: row.subject,
    bodyText: row.bodyText,
    provider: row.provider,
    status: row.status,
    errorMessage: row.errorMessage ?? null,
    sentAt: row.sentAt,
    createdAt: row.createdAt,
  });
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
  const drizzleDb = requireDrizzle(db);
  await drizzleDb.insert(schema.auditLog).values({
    id: randomId(),
    tenantId,
    sequence: row.sequence,
    ts: row.ts,
    entityType: row.entityType,
    entityId: row.entityId,
    action: row.action,
    reason: row.reason ?? null,
    beforeJson: row.beforeJson ?? null,
    afterJson: row.afterJson ?? null,
    prevHash: row.prevHash ?? null,
    hash: row.hash,
    actor: row.actor,
  });
};
