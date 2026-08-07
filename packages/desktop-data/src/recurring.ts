import type Database from 'better-sqlite3';
import { asc, desc, eq } from 'drizzle-orm';
import {
  createSingleTenantScope,
  type BillingAddress,
  type Client as DomainClient,
  type ClientProject,
  type Invoice as DomainInvoice,
  type RecurringProfile as DomainRecurringProfile,
  type ServerProduct,
  type TenantScope,
} from '@billme/server-core';
import type { DocumentNumberKind, RecurringNumberingSettingsShape, SyncRecurringProfileStore } from '@billme/server-core/ports';
import {
  calculateInvoiceTaxSnapshot,
  calculateNextRun,
  deleteRecurringProfile as deleteDomainRecurringProfile,
  generateInvoiceFromProfile as generateDomainInvoiceFromProfile,
  listRecurringProfiles as listDomainRecurringProfiles,
  processRecurringRun as processDomainRecurringRun,
  resolveInvoiceTaxMode,
  shouldRunScheduledRecurring,
  upsertRecurringProfile as upsertDomainRecurringProfile,
  type RecurringResult,
} from '@billme/server-core/services';
import { safeJsonParse, InvoiceItemsSchema } from './validation-schemas';
import { createDrizzle, schema } from './drizzle';

const parseOptionalJson = <T>(value: string | null | undefined): T | undefined => {
  if (!value) return undefined;
  try { return JSON.parse(value) as T; } catch { return undefined; }
};

export interface LegacyRecurringItem {
  description: string;
  quantity?: number | string;
  price?: number | string;
  total?: number | string;
  articleId?: string;
  category?: string;
}

export interface LegacyRecurringProfile {
  id: string;
  clientId: string;
  active: boolean;
  name: string;
  interval: DomainRecurringProfile['interval'];
  nextRun: string;
  lastRun?: string;
  endDate?: string;
  amount: number;
  taxMode?: DomainRecurringProfile['taxMode'];
  items?: LegacyRecurringItem[];
}

export interface LegacyRecurringClientAddress {
  id: string;
  clientId: string;
  label: string;
  kind?: 'billing' | 'shipping' | 'other';
  company?: string;
  contactPerson?: string;
  street: string;
  line2?: string;
  zip: string;
  city: string;
  country: string;
  isDefaultBilling?: boolean;
  isDefaultShipping?: boolean;
}

export interface LegacyRecurringClientEmail {
  id: string;
  clientId: string;
  label: string;
  kind?: 'billing' | 'shipping' | 'general' | 'other';
  email: string;
  isDefaultBilling?: boolean;
  isDefaultGeneral?: boolean;
}

export interface LegacyRecurringClient {
  id: string;
  customerNumber?: string;
  company: string;
  contactPerson?: string;
  email?: string;
  phone?: string;
  address?: string;
  status: DomainClient['status'];
  avatar?: string;
  tags?: string[];
  notes?: string;
  addresses?: LegacyRecurringClientAddress[];
  emails?: LegacyRecurringClientEmail[];
  projects?: unknown[];
  activities?: unknown[];
}

export interface LegacyRecurringProject {
  id: string;
  clientId?: string;
  code?: string;
  name?: string;
  status?: ClientProject['status'];
  budget?: number;
  startDate?: string;
  endDate?: string;
  description?: string;
  archivedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface LegacyRecurringInvoice {
  id: string;
  clientId?: string;
  clientNumber?: string;
  projectId?: string;
  number: string;
  client: string;
  clientEmail?: string;
  clientAddress?: string;
  billingAddressJson?: BillingAddress;
  shippingAddressJson?: BillingAddress;
  taxMode?: DomainInvoice['taxMode'];
  taxMeta?: DomainInvoice['taxMeta'];
  taxSnapshot?: DomainInvoice['taxSnapshot'];
  date: string;
  dueDate: string;
  servicePeriod?: string;
  amount: number;
  status: DomainInvoice['status'];
  dunningLevel?: number;
  items?: LegacyRecurringItem[];
  payments?: DomainInvoice['payments'];
  history?: DomainInvoice['history'];
}

interface RecurringRow {
  id: string;
  client_id: string;
  active: number;
  name: string;
  interval: string;
  next_run: string;
  last_run: string | null;
  end_date: string | null;
  amount: number;
  items_json: string;
  tax_mode?: DomainRecurringProfile['taxMode'] | null;
  tax_meta_json?: string | null;
}

interface LoggerPort {
  info?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

export interface SqliteRecurringRuntime<
  TClient extends LegacyRecurringClient = LegacyRecurringClient,
  TInvoice extends LegacyRecurringInvoice = LegacyRecurringInvoice,
  TProject extends LegacyRecurringProject = LegacyRecurringProject,
> {
  listRecurringProfiles?(db: Database.Database): LegacyRecurringProfile[];
  getRecurringProfile?(db: Database.Database, id: string): LegacyRecurringProfile | null;
  saveRecurringProfile?(db: Database.Database, profile: LegacyRecurringProfile): LegacyRecurringProfile | undefined;
  deleteRecurringProfile?(db: Database.Database, id: string): void;
  getClient(db: Database.Database, id: string): TClient | null;
  saveInvoice(db: Database.Database, invoice: TInvoice, reason: string): TInvoice | undefined;
  ensureDefaultProject(db: Database.Database, clientId: string): TProject;
  reserveNumber(
    db: Database.Database,
    kind: DocumentNumberKind,
    now?: Date,
  ): { reservationId: string; number: string };
  releaseNumber(db: Database.Database, reservationId: string): void;
  finalizeNumber(db: Database.Database, reservationId: string, documentId: string): void;
  createInvoiceId(): string;
  logger?: LoggerPort;
}

const createRecurringScope = (product: ServerProduct): TenantScope => createSingleTenantScope('default', product);

const normalizeRecurringItems = (items: LegacyRecurringItem[] = []): DomainInvoice['items'] => {
  return items.map((item) => {
    const quantity = Number(item.quantity) || 0;
    const price = Number(item.price) || 0;
    const total = Number(item.total);
    return {
      description: item.description,
      quantity,
      price,
      total: Number.isNaN(total) ? quantity * price : total,
      articleId: item.articleId,
      category: item.category,
    };
  });
};

const toDomainAddresses = (
  addresses: LegacyRecurringClientAddress[] = [],
): DomainClient['addresses'] => {
  return addresses.map((address) => ({
    id: address.id,
    clientId: address.clientId,
    label: address.label,
    kind: address.kind ?? 'other',
    company: address.company,
    contactPerson: address.contactPerson,
    street: address.street,
    line2: address.line2,
    zip: address.zip,
    city: address.city,
    country: address.country,
    isDefaultBilling: Boolean(address.isDefaultBilling),
    isDefaultShipping: Boolean(address.isDefaultShipping),
  }));
};

const toDomainEmails = (
  emails: LegacyRecurringClientEmail[] = [],
): DomainClient['emails'] => {
  return emails.map((email) => ({
    id: email.id,
    clientId: email.clientId,
    label: email.label,
    kind: email.kind ?? 'other',
    email: email.email,
    isDefaultBilling: Boolean(email.isDefaultBilling),
    isDefaultGeneral: Boolean(email.isDefaultGeneral),
  }));
};

const rowToDomainRecurringProfile = (
  scope: TenantScope,
  row: RecurringRow,
): DomainRecurringProfile => ({
  tenantId: scope.tenantId,
  id: row.id,
  clientId: row.client_id,
  active: Boolean(row.active),
  name: row.name,
  interval: row.interval as DomainRecurringProfile['interval'],
  nextRun: row.next_run,
  lastRun: row.last_run ?? undefined,
  endDate: row.end_date ?? undefined,
  amount: row.amount,
  taxMode: row.tax_mode ?? 'standard_vat',
  taxMeta: parseOptionalJson(row.tax_meta_json),
  items: safeJsonParse(row.items_json, InvoiceItemsSchema, [], `Recurring profile ${row.id} items`),
});

const toLegacyRecurringProfile = (profile: DomainRecurringProfile): LegacyRecurringProfile => ({
  id: profile.id,
  clientId: profile.clientId,
  active: profile.active,
  name: profile.name,
  interval: profile.interval,
  nextRun: profile.nextRun,
  lastRun: profile.lastRun,
  endDate: profile.endDate,
  amount: profile.amount,
  taxMode: profile.taxMode ?? 'standard_vat',
  items: profile.items,
});

const toDomainRecurringProfile = (
  scope: TenantScope,
  profile: LegacyRecurringProfile,
): DomainRecurringProfile => ({
  tenantId: scope.tenantId,
  id: profile.id,
  clientId: profile.clientId,
  active: profile.active,
  name: profile.name,
  interval: profile.interval,
  nextRun: profile.nextRun,
  lastRun: profile.lastRun,
  endDate: profile.endDate,
  amount: profile.amount,
  taxMode: profile.taxMode ?? 'standard_vat',
  items: normalizeRecurringItems(profile.items),
});

const toDomainClient = (scope: TenantScope, client: LegacyRecurringClient): DomainClient => ({
  tenantId: scope.tenantId,
  id: client.id,
  customerNumber: client.customerNumber,
  company: client.company,
  contactPerson: client.contactPerson ?? '',
  email: client.email ?? '',
  phone: client.phone ?? '',
  address: client.address ?? '',
  status: client.status,
  avatar: client.avatar,
  tags: client.tags ?? [],
  notes: client.notes ?? '',
  addresses: toDomainAddresses(client.addresses),
  emails: toDomainEmails(client.emails),
  projects: (client.projects ?? []) as DomainClient['projects'],
  activities: (client.activities ?? []) as DomainClient['activities'],
});

const toDomainProject = (project: LegacyRecurringProject, clientId: string): ClientProject => ({
  id: project.id,
  clientId: project.clientId ?? clientId,
  code: project.code,
  name: project.name ?? 'Standardprojekt',
  status: project.status ?? 'active',
  budget: project.budget ?? 0,
  startDate: project.startDate ?? new Date().toISOString().slice(0, 10),
  endDate: project.endDate,
  description: project.description,
  archivedAt: project.archivedAt,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
});

const toDomainAddress = (value: unknown): BillingAddress | undefined => {
  return value && typeof value === 'object' ? (value as BillingAddress) : undefined;
};

const toLegacyInvoice = (invoice: DomainInvoice): LegacyRecurringInvoice => ({
  id: invoice.id,
  clientId: invoice.clientId ?? '',
  clientNumber: invoice.clientNumber,
  projectId: invoice.projectId,
  number: invoice.number,
  client: invoice.client,
  clientEmail: invoice.clientEmail,
  clientAddress: invoice.clientAddress,
  billingAddressJson: invoice.billingAddress,
  shippingAddressJson: invoice.shippingAddress,
  taxMode: invoice.taxMode ?? 'standard_vat',
  taxMeta: invoice.taxMeta,
  taxSnapshot: invoice.taxSnapshot,
  date: invoice.date,
  dueDate: invoice.dueDate,
  servicePeriod: invoice.servicePeriod,
  amount: invoice.amount,
  status: invoice.status,
  dunningLevel: invoice.dunningLevel,
  items: invoice.items,
  payments: invoice.payments,
  history: invoice.history,
});

const toDomainInvoice = (scope: TenantScope, invoice: LegacyRecurringInvoice): DomainInvoice => ({
  kind: 'invoice',
  tenantId: scope.tenantId,
  id: invoice.id,
  clientId: invoice.clientId ?? '',
  clientNumber: invoice.clientNumber,
  projectId: invoice.projectId,
  number: invoice.number,
  client: invoice.client,
  clientEmail: invoice.clientEmail ?? '',
  clientAddress: invoice.clientAddress ?? '',
  billingAddress: toDomainAddress(invoice.billingAddressJson),
  shippingAddress: toDomainAddress(invoice.shippingAddressJson),
  taxMode: invoice.taxMode ?? 'standard_vat',
  taxMeta: invoice.taxMeta,
  taxSnapshot: invoice.taxSnapshot,
  date: invoice.date,
  dueDate: invoice.dueDate,
  servicePeriod: invoice.servicePeriod,
  amount: invoice.amount,
  status: invoice.status,
  dunningLevel: invoice.dunningLevel ?? 0,
  items: normalizeRecurringItems(invoice.items),
  payments: invoice.payments ?? [],
  history: invoice.history ?? [],
});

export const createSqliteRecurringProfileStore = (db: Database.Database): SyncRecurringProfileStore => ({
  list(scope) {
    const rows = createDrizzle(db).select({
      id: schema.recurringProfiles.id,
      client_id: schema.recurringProfiles.clientId,
      active: schema.recurringProfiles.active,
      name: schema.recurringProfiles.name,
      interval: schema.recurringProfiles.interval,
      next_run: schema.recurringProfiles.nextRun,
      last_run: schema.recurringProfiles.lastRun,
      end_date: schema.recurringProfiles.endDate,
      amount: schema.recurringProfiles.amount,
      items_json: schema.recurringProfiles.itemsJson,
      tax_mode: schema.recurringProfiles.taxMode,
      tax_meta_json: schema.recurringProfiles.taxMetaJson,
    }).from(schema.recurringProfiles).orderBy(desc(schema.recurringProfiles.active), asc(schema.recurringProfiles.name)).all() as RecurringRow[];
    return rows.map((row) => rowToDomainRecurringProfile(scope, row));
  },
  getById(scope, id) {
    const row = createDrizzle(db).select({
      id: schema.recurringProfiles.id,
      client_id: schema.recurringProfiles.clientId,
      active: schema.recurringProfiles.active,
      name: schema.recurringProfiles.name,
      interval: schema.recurringProfiles.interval,
      next_run: schema.recurringProfiles.nextRun,
      last_run: schema.recurringProfiles.lastRun,
      end_date: schema.recurringProfiles.endDate,
      amount: schema.recurringProfiles.amount,
      items_json: schema.recurringProfiles.itemsJson,
      tax_mode: schema.recurringProfiles.taxMode,
      tax_meta_json: schema.recurringProfiles.taxMetaJson,
    }).from(schema.recurringProfiles).where(eq(schema.recurringProfiles.id, id)).get() as RecurringRow | undefined;
    return row ? rowToDomainRecurringProfile(scope, row) : null;
  },
  save(_scope, profile) {
    const drizzle = createDrizzle(db);
    const exists = drizzle.select({ id: schema.recurringProfiles.id }).from(schema.recurringProfiles).where(eq(schema.recurringProfiles.id, profile.id)).get();
    const payload = {
      id: profile.id,
      clientId: profile.clientId,
      active: profile.active ? 1 : 0,
      name: profile.name,
      interval: profile.interval,
      nextRun: profile.nextRun,
      lastRun: profile.lastRun ?? null,
      endDate: profile.endDate ?? null,
      amount: profile.amount,
      itemsJson: JSON.stringify(profile.items ?? []),
      taxMode: profile.taxMode ?? 'standard_vat',
      taxMetaJson: profile.taxMeta ? JSON.stringify(profile.taxMeta) : null,
    };

    if (!exists) drizzle.insert(schema.recurringProfiles).values({
      id: payload.id,
      clientId: payload.clientId,
      active: payload.active,
      name: payload.name,
      interval: payload.interval,
      nextRun: payload.nextRun,
      lastRun: payload.lastRun,
      endDate: payload.endDate,
      amount: payload.amount,
      itemsJson: payload.itemsJson,
      taxMode: payload.taxMode,
      taxMetaJson: payload.taxMetaJson,
    }).run();
    else drizzle.update(schema.recurringProfiles).set({
      clientId: payload.clientId,
      active: payload.active,
      name: payload.name,
      interval: payload.interval,
      nextRun: payload.nextRun,
      lastRun: payload.lastRun,
      endDate: payload.endDate,
      amount: payload.amount,
      itemsJson: payload.itemsJson,
      taxMode: payload.taxMode,
      taxMetaJson: payload.taxMetaJson,
    }).where(eq(schema.recurringProfiles.id, profile.id)).run();

    return profile;
  },
  remove(_scope, id) {
    createDrizzle(db).delete(schema.recurringProfiles).where(eq(schema.recurringProfiles.id, id)).run();
  },
});

const createRecurringProfileStore = (
  db: Database.Database,
  scope: TenantScope,
  runtime: SqliteRecurringRuntime,
): SyncRecurringProfileStore => {
  const fallbackStore = createSqliteRecurringProfileStore(db);
  return {
    list(innerScope) {
      if (!runtime.listRecurringProfiles) {
        return fallbackStore.list(innerScope);
      }
      return runtime.listRecurringProfiles(db).map((profile) => toDomainRecurringProfile(scope, profile));
    },
    getById(innerScope, id) {
      if (runtime.getRecurringProfile) {
        const profile = runtime.getRecurringProfile(db, id);
        return profile ? toDomainRecurringProfile(scope, profile) : null;
      }
      return fallbackStore.getById(innerScope, id);
    },
    save(innerScope, profile) {
      if (!runtime.saveRecurringProfile) {
        return fallbackStore.save(innerScope, profile);
      }
      const saved = runtime.saveRecurringProfile(db, toLegacyRecurringProfile(profile)) ?? toLegacyRecurringProfile(profile);
      return toDomainRecurringProfile(scope, saved);
    },
    remove(innerScope, id) {
      if (runtime.deleteRecurringProfile) {
        runtime.deleteRecurringProfile(db, id);
        return;
      }
      fallbackStore.remove(innerScope, id);
    },
  };
};

const createDependencies = <
  TSettings extends RecurringNumberingSettingsShape,
  TClient extends LegacyRecurringClient,
  TInvoice extends LegacyRecurringInvoice,
  TProject extends LegacyRecurringProject,
>(
  db: Database.Database,
  product: ServerProduct,
  settings: TSettings,
  runtime: SqliteRecurringRuntime<TClient, TInvoice, TProject>,
) => {
  const scope = createRecurringScope(product);

  return {
    scope,
    dependencies: {
      tx: {
        inTransaction<TResult>(work: () => TResult): TResult {
          if (typeof (db as { transaction?: unknown }).transaction === 'function') {
            return db.transaction(work)();
          }
          return work();
        },
      },
      recurringProfileStore: createRecurringProfileStore(db, scope, runtime),
      clientPort: {
        getById(_scope: TenantScope, id: string) {
          const client = runtime.getClient(db, id);
          return client ? toDomainClient(scope, client) : null;
        },
      },
      invoicePort: {
        save(_scope: TenantScope, params: { invoice: DomainInvoice; reason: string }) {
          const fallbackInvoice = toLegacyInvoice(params.invoice) as TInvoice;
          const savedInvoice = runtime.saveInvoice(db, fallbackInvoice, params.reason) ?? fallbackInvoice;
          return toDomainInvoice(scope, savedInvoice);
        },
      },
      numberingPort: {
        getSettings: () => settings,
        reserve: (kind: DocumentNumberKind, now?: Date) => runtime.reserveNumber(db, kind, now),
        release: (reservationId: string) => {
          runtime.releaseNumber(db, reservationId);
          return { ok: true as const };
        },
        finalize: (reservationId: string, documentId: string) => {
          runtime.finalizeNumber(db, reservationId, documentId);
          return { ok: true as const };
        },
      },
      projectPort: {
        ensureDefaultProject(clientId: string) {
          return toDomainProject(runtime.ensureDefaultProject(db, clientId), clientId);
        },
      },
      createInvoiceId: () => runtime.createInvoiceId(),
    },
  };
};

export { calculateNextRun, shouldRunScheduledRecurring };
export type { RecurringResult };

export const listRecurringProfiles = (
  db: Database.Database,
  product: ServerProduct,
): LegacyRecurringProfile[] => {
  const scope = createRecurringScope(product);
  return listDomainRecurringProfiles(scope, {
    recurringProfileStore: createSqliteRecurringProfileStore(db),
  }).map(toLegacyRecurringProfile);
};

export const upsertRecurringProfile = (
  db: Database.Database,
  product: ServerProduct,
  profile: LegacyRecurringProfile,
): LegacyRecurringProfile => {
  const scope = createRecurringScope(product);
  return toLegacyRecurringProfile(
    upsertDomainRecurringProfile(
      scope,
      { recurringProfileStore: createSqliteRecurringProfileStore(db) },
      toDomainRecurringProfile(scope, profile),
    ),
  );
};

export const deleteRecurringProfile = (
  db: Database.Database,
  product: ServerProduct,
  id: string,
): void => {
  const scope = createRecurringScope(product);
  deleteDomainRecurringProfile(scope, { recurringProfileStore: createSqliteRecurringProfileStore(db) }, id);
};

export const generateInvoiceFromProfile = <
  TSettings extends RecurringNumberingSettingsShape,
  TClient extends LegacyRecurringClient,
  TInvoice extends LegacyRecurringInvoice,
  TProject extends LegacyRecurringProject,
>(
  db: Database.Database,
  product: ServerProduct,
  runtime: SqliteRecurringRuntime<TClient, TInvoice, TProject>,
  profile: LegacyRecurringProfile,
  settings: TSettings,
): TInvoice => {
  const { scope, dependencies } = createDependencies(db, product, settings, runtime);
  const invoice = generateDomainInvoiceFromProfile(scope, dependencies, toDomainRecurringProfile(scope, profile));
  const taxMode = resolveInvoiceTaxMode(invoice.taxMode, settings);
  const taxSnapshot = calculateInvoiceTaxSnapshot(
    {
      items: invoice.items,
      taxMode,
      taxMeta: invoice.taxMeta,
    },
    settings,
  );
  const normalizedInvoice: DomainInvoice = {
    ...invoice,
    taxMode,
    taxSnapshot,
    amount: taxSnapshot.grossAmount,
  };

  runtime.logger?.info?.('Generated invoice from profile', {
    profileId: profile.id,
    profileName: profile.name,
    invoiceNumber: normalizedInvoice.number,
    invoiceId: normalizedInvoice.id,
  });

  return toLegacyInvoice(normalizedInvoice) as TInvoice;
};

export const processRecurringRun = async <
  TSettings extends RecurringNumberingSettingsShape,
  TClient extends LegacyRecurringClient,
  TInvoice extends LegacyRecurringInvoice,
  TProject extends LegacyRecurringProject,
>(
  db: Database.Database,
  product: ServerProduct,
  runtime: SqliteRecurringRuntime<TClient, TInvoice, TProject>,
  settings: TSettings,
): Promise<RecurringResult> => {
  const { scope, dependencies } = createDependencies(db, product, settings, runtime);
  const result = await processDomainRecurringRun(scope, dependencies);

  runtime.logger?.info?.('Recurring run completed', {
    generated: result.generated,
    deactivated: result.deactivated,
    errors: result.errors,
  });

  if (result.errors.length > 0) {
    runtime.logger?.error?.('Errors during recurring run', { errors: result.errors });
  }

  return result;
};
