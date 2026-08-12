import type {
  Client,
  ClientProject,
  Invoice,
  RecurringInterval,
  RecurringProfile,
  TenantScope,
} from '../domain/foundations.js';
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
import { chooseDefaultBillingAddress, chooseDefaultBillingEmail, formatAddressMultiline } from './clientNumbering.js';
import { catchMaybePromise, chainMaybePromise, isPromiseLike, mapMaybePromise } from './maybePromise.js';
import { calculateInvoiceTaxSnapshot, resolveInvoiceTaxMode } from './taxMode.js';

export interface RecurringResult {
  generated: number;
  deactivated: number;
  errors: Array<{ profileName: string; error: string }>;
}

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
    throw new Error(`Client ${profile.clientId} not found`);
  }
  if (client.status !== 'active') {
    throw new Error(`Client ${profile.clientId} is not active (status: ${client.status})`);
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
  return dependencies.tx.inTransaction(() => {
    const now = getClock(dependencies).now();
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
            // ignore release failures and rethrow original persistence error
          }
          throw error;
        };

        return chainMaybePromise(
          buildInvoiceFromProfile(scope, dependencies, activeClient, profile, now, numberReservation.number),
          (invoice) => {
            const reason = `Auto-generated from recurring profile ${profile.id}`;
            return catchMaybePromise(
              () =>
                chainMaybePromise(
                  dependencies.invoicePort.save(scope, {
                    invoice,
                    reason,
                  }),
                  (saved) =>
                    chainMaybePromise(
                      dependencies.numberingPort.finalize(numberReservation.reservationId, saved.id),
                      () => saved,
                    ),
                ),
              releaseReservationAndRethrow,
            );
          },
        );
      });
    });
  });
}

const isProfileDue = (profile: RecurringProfile, today: string): boolean => {
  return profile.active && profile.nextRun <= today && (!profile.endDate || profile.endDate > today);
};

export const processRecurringRun = async (
  scope: TenantScope,
  dependencies: RecurringDomainDependencies,
): Promise<RecurringResult> => {
  const result: RecurringResult = { generated: 0, deactivated: 0, errors: [] };
  const today = getClock(dependencies).now().toISOString().slice(0, 10);
  const profiles = (await dependencies.recurringProfileStore.list(scope)).filter((profile) => isProfileDue(profile, today));

  for (const profile of profiles) {
    try {
      await generateInvoiceFromProfile(scope, dependencies, profile);
      result.generated += 1;

      const nextRun = calculateNextRun(profile.nextRun, profile.interval);
      const shouldDeactivate = Boolean(profile.endDate && nextRun > profile.endDate);

      await dependencies.recurringProfileStore.save(scope, {
        ...profile,
        lastRun: today,
        nextRun: shouldDeactivate ? (profile.endDate ?? nextRun) : nextRun,
        active: shouldDeactivate ? false : profile.active,
      });

      if (shouldDeactivate) {
        result.deactivated += 1;
      }
    } catch (error) {
      result.errors.push({
        profileName: profile.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
};
