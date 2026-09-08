import type {
  Client,
  ClientProject,
  Invoice,
  RecurringInterval,
  RecurringProfile,
  TenantScope,
} from '../domain/foundations.js';
import { getBillingLineAmount, isBillableLine } from '../domain/foundations.js';
import {
  systemClock,
  type Clock,
  type MaybePromise,
  type RecurringClientPort,
  type RecurringInvoicePort,
  type RecurringNumberingPort,
  type RecurringNumberingSettingsShape,
  type RecurringProfileStore,
  type RecurringProjectPort,
  type SyncRecurringClientPort,
  type SyncRecurringInvoicePort,
  type SyncRecurringNumberingPort,
  type SyncRecurringProfileStore,
  type SyncRecurringProjectPort,
  type SyncTransactionPort,
  type TransactionPort,
} from '../ports/index.js';
import { ZodError } from 'zod';
import { chooseDefaultBillingAddress, chooseDefaultBillingEmail, formatAddressMultiline } from './clientNumbering.js';
import { catchMaybePromise, chainMaybePromise, isPromiseLike, mapMaybePromise } from './maybePromise.js';
import { calculateInvoiceTaxSnapshot, resolveInvoiceTaxMode } from './taxMode.js';

export interface RecurringResult {
  generated: number;
  deactivated: number;
  errors: Array<{ profileName: string; error: string }>;
}

/**
 * A failure caused by one recurring profile's business data. The run can
 * isolate and report this profile while allowing all other profiles to commit.
 */
export class InvalidRecurringProfileError extends Error {
  readonly code = 'INVALID_RECURRING_PROFILE';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidRecurringProfileError';
  }
}

const isRecurringProfileError = (error: unknown): error is InvalidRecurringProfileError =>
  error instanceof InvalidRecurringProfileError;

const toExpectedRecurringProfileError = (error: unknown): InvalidRecurringProfileError | null => {
  if (isRecurringProfileError(error)) return error;
  if (error instanceof ZodError) {
    return new InvalidRecurringProfileError(
      `Das Abo-Profil enthält ungültige Rechnungsdaten: ${error.issues[0]?.message ?? 'Validierung fehlgeschlagen.'}`,
    );
  }
  if (!(error instanceof Error)) return null;
  const code = (error as Error & { code?: unknown }).code;
  const marker = typeof code === 'string' ? code : error.message;
  if (/^(INVALID_(?:INVOICE|LINE|TAX)|VALIDATION_(?:INVOICE|LINE|TAX)|TAX_(?:INVOICE|LINE|SNAPSHOT)|INVOICE_(?:INVALID|VALIDATION)|LINE_(?:INVALID|VALIDATION))/.test(marker)) {
    return new InvalidRecurringProfileError(`Die Rechnungsdaten des Abo-Profils sind ungültig: ${error.message}`);
  }
  return null;
};

/** Validate data at the shared write seam, independently of the UI. */
export const validateRecurringProfile = (profile: RecurringProfile): void => {
  if (typeof profile.name !== 'string' || !profile.name.trim()) {
    throw new InvalidRecurringProfileError('Die Bezeichnung des Abo-Profils ist erforderlich.');
  }
  // `amount` is a persisted/cache value in older desktop profiles; the
  // generated invoice uses normalized line values as the source of truth.
  if (!Number.isFinite(profile.amount) || profile.amount < 0) {
    throw new InvalidRecurringProfileError(`Das Abo-Profil ${profile.id} muss einen gültigen Betrag enthalten.`);
  }
  if (!['daily', 'weekly', 'monthly', 'quarterly', 'yearly'].includes(profile.interval)) {
    throw new InvalidRecurringProfileError(`Das Abo-Profil ${profile.id} enthält ein ungültiges Intervall.`);
  }

  const items = Array.isArray(profile.items) ? profile.items : [];
  if (items.length === 0) {
    throw new InvalidRecurringProfileError(`Das Abo-Profil ${profile.id} muss mindestens eine Position enthalten.`);
  }

  const billableItems = items.filter(isBillableLine);
  const isValidBillableItem = (item: (typeof items)[number]): boolean => {
    if (!isBillableLine(item) || typeof item.description !== 'string' || !item.description.trim()) return false;
    const quantity = Number(item.quantity);
    const price = Number(item.price);
    const total = Number(item.total);
    return Number.isFinite(quantity)
      && quantity > 0
      && Number.isFinite(price)
      && Number.isFinite(total)
      && total >= 0
      && getBillingLineAmount(item) > 0;
  };
  if (billableItems.length === 0 || !billableItems.every(isValidBillableItem)) {
    throw new InvalidRecurringProfileError(`Das Abo-Profil ${profile.id} muss mindestens eine abrechenbare Position mit Beschreibung, gültiger Menge und Betrag größer als 0 enthalten.`);
  }
};

export interface RecurringDomainDependencies<
  TSettings extends RecurringNumberingSettingsShape = RecurringNumberingSettingsShape,
  TProject extends ClientProject = ClientProject,
> {
  tx: TransactionPort;
  clock?: Clock;
  recurringProfileStore: RecurringProfileStore;
  clientPort: RecurringClientPort;
  invoicePort: RecurringInvoicePort;
  numberingPort: RecurringNumberingPort<TSettings>;
  projectPort: RecurringProjectPort<TProject>;
  createInvoiceId(): string;
}

type SyncRecurringDependencies<
  TSettings extends RecurringNumberingSettingsShape = RecurringNumberingSettingsShape,
  TProject extends ClientProject = ClientProject,
> = Omit<
  RecurringDomainDependencies<TSettings, TProject>,
  'tx' | 'recurringProfileStore' | 'clientPort' | 'invoicePort' | 'numberingPort' | 'projectPort'
> & {
  tx: SyncTransactionPort;
  recurringProfileStore: SyncRecurringProfileStore;
  clientPort: SyncRecurringClientPort;
  invoicePort: SyncRecurringInvoicePort;
  numberingPort: SyncRecurringNumberingPort<TSettings>;
  projectPort: SyncRecurringProjectPort<TProject>;
};

type SyncRecurringProfileDependencies = {
  recurringProfileStore: SyncRecurringProfileStore;
};

const getClock = (dependencies: Pick<RecurringDomainDependencies, 'clock'>): Clock => {
  return dependencies.clock ?? systemClock;
};

const isSameDay = (left: Date, right: Date): boolean => {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
};

export const shouldRunScheduledRecurring = <
  TSettings extends {
    automation: {
      recurringEnabled: boolean;
      recurringRunTime: string;
      lastRecurringRun?: string;
    };
  },
>(
  settings: TSettings | null | undefined,
  now = new Date(),
  windowMinutes = 15,
): boolean => {
  if (!settings?.automation.recurringEnabled) {
    return false;
  }

  const [hourRaw, minuteRaw] = settings.automation.recurringRunTime.split(':');
  const targetHour = Number(hourRaw);
  const targetMinute = Number(minuteRaw);
  if (!Number.isFinite(targetHour) || !Number.isFinite(targetMinute)) {
    return false;
  }

  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  const isTargetTime =
    currentHour === targetHour && currentMinute >= targetMinute && currentMinute < targetMinute + windowMinutes;

  if (!isTargetTime) {
    return false;
  }

  if (!settings.automation.lastRecurringRun) {
    return true;
  }

  return !isSameDay(new Date(settings.automation.lastRecurringRun), now);
};

export const calculateNextRun = (currentDate: string, interval: RecurringInterval): string => {
  const [yearStr, monthStr, dayStr] = currentDate.split('-');
  let year = parseInt(yearStr, 10);
  let month = parseInt(monthStr, 10);
  let day = parseInt(dayStr, 10);

  switch (interval) {
    case 'daily': {
      const date = new Date(Date.UTC(year, month - 1, day));
      date.setUTCDate(date.getUTCDate() + 1);
      return date.toISOString().slice(0, 10);
    }
    case 'weekly': {
      const date = new Date(Date.UTC(year, month - 1, day));
      date.setUTCDate(date.getUTCDate() + 7);
      return date.toISOString().slice(0, 10);
    }
    case 'monthly': {
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
      const maxDay = new Date(year, month, 0).getDate();
      day = Math.min(day, maxDay);
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    case 'quarterly': {
      month += 3;
      while (month > 12) {
        month -= 12;
        year += 1;
      }
      const maxDay = new Date(year, month, 0).getDate();
      day = Math.min(day, maxDay);
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    case 'yearly': {
      year += 1;
      const maxDay = new Date(year, month, 0).getDate();
      day = Math.min(day, maxDay);
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    default:
      throw new Error(`Unsupported interval: ${interval}`);
  }
};

const calculateDueDate = (source: Date, paymentTermsDays: number): string => {
  const date = new Date(source);
  date.setDate(date.getDate() + paymentTermsDays);
  return date.toISOString().slice(0, 10);
};

const calculateServicePeriod = (
  interval: RecurringInterval,
  date: Date,
): { start: string; end: string } => {
  const start = new Date(date);
  const end = new Date(date);

  switch (interval) {
    case 'daily':
      break;
    case 'weekly':
      end.setDate(end.getDate() + 6);
      break;
    case 'monthly':
      end.setMonth(end.getMonth() + 1);
      end.setDate(end.getDate() - 1);
      break;
    case 'quarterly':
      end.setMonth(end.getMonth() + 3);
      end.setDate(end.getDate() - 1);
      break;
    case 'yearly':
      end.setFullYear(end.getFullYear() + 1);
      end.setDate(end.getDate() - 1);
      break;
    default:
      throw new Error(`Unsupported interval: ${interval}`);
  }

  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
};

const buildInvoiceItems = (profile: RecurringProfile): Invoice['items'] => {
  return (profile.items ?? []).map((item) => {
    const quantity = Number(item.quantity) || 0;
    const price = Number(item.price) || 0;
    return {
      ...item,
      description: item.description,
      quantity,
      price,
      total: Number(item.total) || quantity * price,
      articleId: item.articleId,
      category: item.category,
    };
  });
};

const requireActiveClient = (client: Client | null, profile: RecurringProfile): Client => {
  if (!client) {
    throw new InvalidRecurringProfileError(`Der Kunde ${profile.clientId} wurde nicht gefunden.`);
  }
  if (client.status !== 'active') {
    throw new InvalidRecurringProfileError(`Der Kunde ${profile.clientId} ist nicht aktiv (Status: ${client.status}).`);
  }
  return client;
};

const buildInvoiceFromProfile = (
  scope: TenantScope,
  dependencies: RecurringDomainDependencies,
  client: Client,
  profile: RecurringProfile,
  now: Date,
  invoiceNumber: string,
): MaybePromise<Invoice> => {
  return chainMaybePromise(dependencies.numberingPort.getSettings(), (settings) => {
    if (!settings) {
      throw new Error('Settings not found');
    }

    const servicePeriod = calculateServicePeriod(profile.interval, now);
    const billingAddress = chooseDefaultBillingAddress(client.addresses ?? []);
    const shippingAddress =
      (client.addresses ?? []).find((address) => address.isDefaultShipping) ??
      (client.addresses ?? []).find((address) => address.kind === 'shipping') ??
      billingAddress ??
      null;
    const billingEmail = chooseDefaultBillingEmail(client.emails ?? []);
    const items = buildInvoiceItems(profile);
    const today = now.toISOString().slice(0, 10);
    const taxMode = resolveInvoiceTaxMode(undefined, settings);
    const taxSnapshot = calculateInvoiceTaxSnapshot({ items, taxMode }, settings);

    return chainMaybePromise(dependencies.projectPort.ensureDefaultProject(profile.clientId), (project) => ({
      kind: 'invoice',
      documentKind: 'invoice',
      revisionNumber: 0,
      tenantId: scope.tenantId,
      id: dependencies.createInvoiceId(),
      clientId: profile.clientId,
      clientNumber: client.customerNumber,
      projectId: project.id,
      number: invoiceNumber,
      client: client.company,
      clientEmail: billingEmail?.email ?? client.email,
      clientAddress: billingAddress ? formatAddressMultiline(billingAddress) : client.address,
      billingAddress: billingAddress ?? undefined,
      shippingAddress: shippingAddress ?? undefined,
      taxMode,
      taxSnapshot,
      date: today,
      dueDate: calculateDueDate(now, settings.legal.paymentTermsDays),
      servicePeriod: servicePeriod.start,
      amount: taxSnapshot.grossAmount,
      status: 'draft',
      dunningLevel: 0,
      items,
      payments: [],
      history: [],
    }));
  });
};

/** Generate and finalize one invoice without opening a transaction. */
const generateInvoiceFromProfileWithoutTransaction = (
  scope: TenantScope,
  dependencies: RecurringDomainDependencies,
  profile: RecurringProfile,
  now: Date,
): MaybePromise<Invoice> => {
  validateRecurringProfile(profile);
  return chainMaybePromise(dependencies.clientPort.getById(scope, profile.clientId), (client) => {
    const activeClient = requireActiveClient(client, profile);
    return chainMaybePromise(dependencies.numberingPort.reserve('invoice', now), (numberReservation) => {
      const releaseReservationAndRethrow = (error: unknown): MaybePromise<never> => {
        try {
          const releaseResult = dependencies.numberingPort.release(numberReservation.reservationId);
          if (isPromiseLike(releaseResult)) {
            return releaseResult.then(
              () => Promise.reject(error),
              () => Promise.reject(error),
            );
          }
        } catch {
          // Keep the persistence/finalization error as the useful cause.
        }
        throw error;
      };
      const rethrowGenerationError = (error: unknown): MaybePromise<never> => {
        const profileError = toExpectedRecurringProfileError(error);
        return releaseReservationAndRethrow(profileError ?? error);
      };

      return catchMaybePromise(
        () => chainMaybePromise(
          buildInvoiceFromProfile(scope, dependencies, activeClient, profile, now, numberReservation.number),
          (invoice) => {
            const reason = `Auto-generated from recurring profile ${profile.id}`;
            return chainMaybePromise(
              dependencies.invoicePort.save(scope, { invoice, reason }),
              (saved) => chainMaybePromise(
                dependencies.numberingPort.finalize(numberReservation.reservationId, saved.id),
                () => saved,
              ),
            );
          },
        ),
        rethrowGenerationError,
      );
    });
  });
};

export function listRecurringProfiles(
  scope: TenantScope,
  dependencies: SyncRecurringProfileDependencies,
): RecurringProfile[];
export function listRecurringProfiles(
  scope: TenantScope,
  dependencies: Pick<RecurringDomainDependencies, 'recurringProfileStore'>,
): MaybePromise<RecurringProfile[]>;
export function listRecurringProfiles(
  scope: TenantScope,
  dependencies: Pick<RecurringDomainDependencies, 'recurringProfileStore'>,
): MaybePromise<RecurringProfile[]> {
  return dependencies.recurringProfileStore.list(scope);
}

export function getRecurringProfile(
  scope: TenantScope,
  dependencies: SyncRecurringProfileDependencies,
  id: string,
): RecurringProfile | null;
export function getRecurringProfile(
  scope: TenantScope,
  dependencies: Pick<RecurringDomainDependencies, 'recurringProfileStore'>,
  id: string,
): MaybePromise<RecurringProfile | null>;
export function getRecurringProfile(
  scope: TenantScope,
  dependencies: Pick<RecurringDomainDependencies, 'recurringProfileStore'>,
  id: string,
): MaybePromise<RecurringProfile | null> {
  return dependencies.recurringProfileStore.getById(scope, id);
}

export function upsertRecurringProfile(
  scope: TenantScope,
  dependencies: SyncRecurringProfileDependencies,
  profile: RecurringProfile,
): RecurringProfile;
export function upsertRecurringProfile(
  scope: TenantScope,
  dependencies: Pick<RecurringDomainDependencies, 'recurringProfileStore'>,
  profile: RecurringProfile,
): MaybePromise<RecurringProfile>;
export function upsertRecurringProfile(
  scope: TenantScope,
  dependencies: Pick<RecurringDomainDependencies, 'recurringProfileStore'>,
  profile: RecurringProfile,
): MaybePromise<RecurringProfile> {
  validateRecurringProfile(profile);
  return dependencies.recurringProfileStore.save(scope, profile);
}

export function deleteRecurringProfile(
  scope: TenantScope,
  dependencies: SyncRecurringProfileDependencies,
  id: string,
): { ok: true };
export function deleteRecurringProfile(
  scope: TenantScope,
  dependencies: Pick<RecurringDomainDependencies, 'recurringProfileStore'>,
  id: string,
): MaybePromise<{ ok: true }>;
export function deleteRecurringProfile(
  scope: TenantScope,
  dependencies: Pick<RecurringDomainDependencies, 'recurringProfileStore'>,
  id: string,
): MaybePromise<{ ok: true }> {
  return mapMaybePromise(dependencies.recurringProfileStore.remove(scope, id), () => ({ ok: true } as const));
}

export function generateInvoiceFromProfile(
  scope: TenantScope,
  dependencies: SyncRecurringDependencies,
  profile: RecurringProfile,
): Invoice;
export function generateInvoiceFromProfile(
  scope: TenantScope,
  dependencies: RecurringDomainDependencies,
  profile: RecurringProfile,
): MaybePromise<Invoice>;
export function generateInvoiceFromProfile(
  scope: TenantScope,
  dependencies: RecurringDomainDependencies,
  profile: RecurringProfile,
): MaybePromise<Invoice> {
  return dependencies.tx.inTransaction(() =>
    generateInvoiceFromProfileWithoutTransaction(
      scope,
      dependencies,
      profile,
      getClock(dependencies).now(),
    )
  );
}

const isProfileDue = (profile: RecurringProfile, today: string): boolean => {
  return profile.active && profile.nextRun <= today && (!profile.endDate || profile.endDate > today);
};

export const processRecurringRun = async (
  scope: TenantScope,
  dependencies: RecurringDomainDependencies,
): Promise<RecurringResult> => {
  const result: RecurringResult = { generated: 0, deactivated: 0, errors: [] };
  const runNow = getClock(dependencies).now();
  const today = runNow.toISOString().slice(0, 10);
  const profiles = (await dependencies.recurringProfileStore.list(scope)).filter((profile) => isProfileDue(profile, today));

  for (const profile of profiles) {
    let currentProfile = profile;
    try {
      // Keep the callback synchronous for better-sqlite3 while preserving the
      // same single transaction boundary for async Postgres/PGlite ports.
      const profileResult = await dependencies.tx.inTransaction(() =>
        chainMaybePromise(
          dependencies.recurringProfileStore.getByIdForUpdate
            ? dependencies.recurringProfileStore.getByIdForUpdate(scope, profile.id)
            : dependencies.recurringProfileStore.getById(scope, profile.id),
          (freshProfile) => {
            // A second run can have listed this profile before the first run
            // committed. The PostgreSQL/PGlite adapter holds a row lock here;
            // all adapters still re-read and reject a stale list snapshot.
            if (!freshProfile
              || freshProfile.nextRun !== profile.nextRun
              || freshProfile.active !== profile.active
              || !isProfileDue(freshProfile, today)) {
              return { processed: false, shouldDeactivate: false };
            }
            currentProfile = freshProfile;
            return chainMaybePromise(
              generateInvoiceFromProfileWithoutTransaction(scope, dependencies, freshProfile, runNow),
              () => {
                const nextRun = calculateNextRun(freshProfile.nextRun, freshProfile.interval);
                const shouldDeactivate = Boolean(freshProfile.endDate && nextRun > freshProfile.endDate);

                return mapMaybePromise(
                  dependencies.recurringProfileStore.save(scope, {
                    ...freshProfile,
                    lastRun: today,
                    nextRun: shouldDeactivate ? (freshProfile.endDate ?? nextRun) : nextRun,
                    active: shouldDeactivate ? false : freshProfile.active,
                  }),
                  () => ({ processed: true, shouldDeactivate }),
                );
              },
            );
          },
        ),
      );

      if (!profileResult.processed) continue;
      // Count only after the profile transaction has committed successfully.
      result.generated += 1;
      if (profileResult.shouldDeactivate) {
        result.deactivated += 1;
      }
    } catch (error) {
      if (!isRecurringProfileError(error)) throw error;
      result.errors.push({
        profileName: currentProfile.name,
        error: error.message,
      });
    }
  }

  return result;
};
