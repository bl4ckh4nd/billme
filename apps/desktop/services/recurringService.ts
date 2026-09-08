import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  calculateNextRun,
  generateInvoiceFromProfile as generateSharedInvoiceFromProfile,
  processRecurringRun as processSharedRecurringRun,
  shouldRunScheduledRecurring,
  type LegacyRecurringInvoice,
  type LegacyRecurringProfile,
  type RecurringResult,
  type SqliteRecurringRuntime,
} from '@billme/desktop-data/recurring';
import type { AppSettings, Client, Invoice, Project, RecurringProfile } from '../types';
import { getClient } from '../db/clientsRepo';
import { getRecurringProfile, listRecurringProfiles, upsertRecurringProfile } from '../db/recurringRepo';
import { upsertInvoice } from '../db/invoicesRepo';
import { ensureDefaultProjectForClient } from '../db/projectsRepo';
import { finalizeNumber, releaseNumber, reserveNumber } from '../db/numberingRepo';
import { logger } from '../utils/logger';

const PRODUCT = 'lite' as const;

const runtime: SqliteRecurringRuntime<Client, LegacyRecurringInvoice, Project> = {
  listRecurringProfiles: (db) => listRecurringProfiles(db) as RecurringProfile[],
  getRecurringProfile: (db, id) => getRecurringProfile(db, id) as RecurringProfile | null,
  saveRecurringProfile: (db, profile) => upsertRecurringProfile(db, profile as RecurringProfile) as RecurringProfile,
  getClient: (db, id) => getClient(db, id) as Client | null,
  saveInvoice: (db, invoice, reason) => upsertInvoice(db, invoice as Invoice, reason) as unknown as LegacyRecurringInvoice,
  ensureDefaultProject: (db, clientId) => ensureDefaultProjectForClient(db, clientId) as Project,
  reserveNumber: (db, kind) => reserveNumber(db, kind),
  releaseNumber: (db, reservationId) => releaseNumber(db, reservationId),
  finalizeNumber: (db, reservationId, documentId) => finalizeNumber(db, reservationId, documentId),
  createInvoiceId: () => uuidv4(),
  logger: {
    info: (message, meta) => logger.info('RecurringService', message, meta),
    error: (message, meta) => logger.error('RecurringService', message, undefined, meta),
  },
};

export { calculateNextRun, shouldRunScheduledRecurring };
export type { RecurringResult };

export const generateInvoiceFromProfile = (
  db: Database.Database,
  profile: RecurringProfile,
  settings: AppSettings,
): Invoice => {
  return generateSharedInvoiceFromProfile(
    db,
    PRODUCT,
    runtime,
    profile as LegacyRecurringProfile,
    settings,
  ) as LegacyRecurringInvoice as Invoice;
};

export const processRecurringRun = async (
  db: Database.Database,
  settings: AppSettings,
): Promise<RecurringResult> => {
  return processSharedRecurringRun(db, PRODUCT, runtime, settings);
};
