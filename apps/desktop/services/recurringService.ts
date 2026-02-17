import { Database } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  RecurringProfile,
  Invoice,
  AppSettings,
  RecurrenceInterval,
  InvoiceItem,
} from '../types';
import { listRecurringProfiles, upsertRecurringProfile } from '../db/recurringRepo';
import { getClient } from '../db/clientsRepo';
import { upsertInvoice } from '../db/invoicesRepo';
import { ensureDefaultProjectForClient as ensureDefaultProject } from '../db/projectsRepo';
import { finalizeNumber, releaseNumber, reserveNumber } from '../db/numberingRepo';
import { logger } from '../utils/logger';

export interface RecurringResult {
  generated: number;
  deactivated: number;
  errors: Array<{ profileName: string; error: string }>;
}

/**
 * Calculate the next run date based on current date and interval
 */
export const calculateNextRun = (
  currentDate: string,
  interval: RecurrenceInterval,
): string => {
  // Parse date string (YYYY-MM-DD)
  const [yearStr, monthStr, dayStr] = currentDate.split('-');
  let year = parseInt(yearStr, 10);
  let month = parseInt(monthStr, 10); // 1-12
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

      // Handle month-end edge cases (e.g., Jan 31 → Feb 28)
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

      // Handle month-end edge cases
      const maxDay = new Date(year, month, 0).getDate();
      day = Math.min(day, maxDay);

      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    case 'yearly': {
      year += 1;

      // Handle leap year edge case (Feb 29 → Feb 28)
      const maxDay = new Date(year, month, 0).getDate();
      day = Math.min(day, maxDay);

      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    default:
      throw new Error(`Unsupported interval: ${interval}`);
  }
};

/**
 * Calculate due date based on payment terms
 */
const calculateDueDate = (paymentTermsDays: number): string => {
  const date = new Date();
  date.setDate(date.getDate() + paymentTermsDays);
  return date.toISOString().slice(0, 10);
};

const formatAddressMultiline = (address: {
  company?: string;
  contactPerson?: string;
  street: string;
  line2?: string;
  zip: string;
  city: string;
  country: string;
}): string => {
  const lines = [
    address.company ?? '',
    address.contactPerson ?? '',
    address.street ?? '',
    address.line2 ?? '',
    `${address.zip} ${address.city}`.trim(),
    address.country ?? '',
  ]
    .map((v) => String(v ?? '').trim())
    .filter((v) => v.length > 0);
  return lines.join('\n');
};

/**
 * Calculate service period based on interval
 */
const calculateServicePeriod = (
  interval: RecurrenceInterval,
  date: Date,
): { start: string; end: string } => {
  const start = new Date(date);
  const end = new Date(date);

  switch (interval) {
    case 'daily':
      // Service period is same day
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

/**
 * Generate an invoice from a recurring profile
 */
export const generateInvoiceFromProfile = (
  db: Database,
  profile: RecurringProfile,
  settings: AppSettings,
): Invoice => {
  // Fetch client details
  const client = getClient(db, profile.clientId);
  if (!client) {
    throw new Error(`Client ${profile.clientId} not found`);
  }
  if (client.status !== 'active') {
    throw new Error(`Client ${profile.clientId} is not active (status: ${client.status})`);
  }

  const numberReservation = reserveNumber(db, 'invoice');
  const invoiceNumber = numberReservation.number;

  // Calculate service period from interval
  const servicePeriod = calculateServicePeriod(profile.interval, new Date());

  const addresses = client.addresses ?? [];
  const billingAddress =
    addresses.find((a) => a.isDefaultBilling) ??
    addresses.find((a) => a.kind === 'billing') ??
    addresses[0] ??
    null;

  const shippingAddress =
    addresses.find((a) => a.isDefaultShipping) ??
    addresses.find((a) => a.kind === 'shipping') ??
    billingAddress ??
    null;

  const emails = client.emails ?? [];
  const billingEmail =
    emails.find((e) => e.isDefaultBilling) ??
    emails.find((e) => e.isDefaultGeneral) ??
    emails[0] ??
    null;

  // Get or create default project for client
  const project = ensureDefaultProject(db, profile.clientId);

  // Create invoice
  const items: InvoiceItem[] = (profile.items ?? []).map((item) => {
    const quantity = Number(item.quantity) || 0;
    const price = Number(item.price) || 0;
    return {
      description: item.description,
      quantity,
      price,
      total: Number(item.total) || quantity * price,
      articleId: item.articleId,
      category: item.category,
    };
  });

  const netTotal = items.reduce((sum, item) => sum + (Number(item.total) || 0), 0);
  const vatRate = settings.legal.smallBusinessRule ? 0 : Number(settings.legal.defaultVatRate) || 0;
  const grossTotal = netTotal + netTotal * (vatRate / 100);
  const today = new Date().toISOString().slice(0, 10);

  const invoice: Invoice = {
    id: uuidv4(),
    number: invoiceNumber,
    clientId: profile.clientId,
    clientNumber: client.customerNumber,
    projectId: project.id,
    client: client.company,
    clientEmail: billingEmail?.email ?? client.email,
    clientAddress: billingAddress ? formatAddressMultiline(billingAddress) : client.address,
    billingAddressJson: billingAddress ?? undefined,
    shippingAddressJson: shippingAddress ?? undefined,
    date: today,
    dueDate: calculateDueDate(settings.legal.paymentTermsDays),
    servicePeriod: servicePeriod.start,
    items,
    amount: Number.isFinite(grossTotal) ? grossTotal : 0,
    status: 'draft', // User decision: draft status for safety
    payments: [],
    history: [
      {
        date: today,
        action: `invoice.create (Auto-generated from recurring profile "${profile.name}")`,
      },
    ],
  };

  // Save invoice
  try {
    upsertInvoice(db, invoice, `Auto-generated from recurring profile ${profile.id}`);
    finalizeNumber(db, numberReservation.reservationId, invoice.id);
  } catch (error) {
    // Best effort: release if we fail before persisting a draft.
    try {
      releaseNumber(db, numberReservation.reservationId);
    } catch {
      // ignore
    }
    throw error;
  }

  logger.info('RecurringService', 'Generated invoice from profile', {
    profileId: profile.id,
    profileName: profile.name,
    invoiceNumber,
    invoiceId: invoice.id,
  });

  return invoice;
};

/**
 * Process all recurring profiles due for generation
 */
export const processRecurringRun = async (
  db: Database,
  settings: AppSettings,
): Promise<RecurringResult> => {
  const result: RecurringResult = { generated: 0, deactivated: 0, errors: [] };
  const today = new Date().toISOString().slice(0, 10);

  // Query active profiles due for generation
  const allProfiles = listRecurringProfiles(db);
  const profiles = allProfiles.filter(
    (p) =>
      p.active &&
      p.nextRun <= today &&
      (!p.endDate || p.endDate > today),
  );

  logger.info('RecurringService', `Found ${profiles.length} profiles due for generation`);

  // Process each profile
  for (const profile of profiles) {
    try {
      // Generate invoice
      const invoice = generateInvoiceFromProfile(db, profile, settings);
      result.generated++;

      // Calculate next run date
      const nextRun = calculateNextRun(profile.nextRun, profile.interval);

      // Check if profile should be deactivated (past endDate)
      const shouldDeactivate = profile.endDate && nextRun > profile.endDate;

      // Update profile
      const updatedProfile: RecurringProfile = {
        ...profile,
        lastRun: today,
        nextRun: shouldDeactivate ? (profile.endDate ?? nextRun) : nextRun,
        active: shouldDeactivate ? false : profile.active,
      };

      upsertRecurringProfile(db, updatedProfile);

      if (shouldDeactivate) {
        result.deactivated++;
        logger.info('RecurringService', 'Deactivated profile (past endDate)', {
          profileId: profile.id,
          profileName: profile.name,
          endDate: profile.endDate,
        });
      }

      logger.info('RecurringService', 'Generated invoice from recurring profile', {
        profileName: profile.name,
        invoiceNumber: invoice.number,
        nextRun,
      });
    } catch (error) {
      result.errors.push({
        profileName: profile.name,
        error: error instanceof Error ? error.message : String(error),
      });
      logger.error('RecurringService', 'Failed to generate invoice from profile', error as Error, {
        profileId: profile.id,
        profileName: profile.name,
      });
    }
  }

  logger.info('RecurringService', 'Recurring run completed', result);
  return result;
};
