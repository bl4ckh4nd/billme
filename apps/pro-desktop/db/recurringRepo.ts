import type Database from 'better-sqlite3';
import { createSingleTenantScope } from '@billme/server-core';
import {
  createSqliteRecurringProfileStore as createSharedSqliteRecurringProfileStore,
  deleteRecurringProfile as deleteSharedRecurringProfile,
  listRecurringProfiles as listSharedRecurringProfiles,
  upsertRecurringProfile as upsertSharedRecurringProfile,
  type LegacyRecurringProfile,
} from '@billme/desktop-data/recurring';
import type { RecurringProfile } from '../types';

const PRODUCT = 'pro' as const;

export const createSqliteRecurringProfileStore = (db: Database.Database) => createSharedSqliteRecurringProfileStore(db);

export const listRecurringProfiles = (db: Database.Database): RecurringProfile[] => {
  return listSharedRecurringProfiles(db, PRODUCT) as RecurringProfile[];
};

export const getRecurringProfile = (db: Database.Database, id: string): RecurringProfile | null => {
  return createSharedSqliteRecurringProfileStore(db).getById(
    createSingleTenantScope('default', PRODUCT),
    id,
  ) as RecurringProfile | null;
};

export const upsertRecurringProfile = (
  db: Database.Database,
  profile: RecurringProfile,
): RecurringProfile => {
  return upsertSharedRecurringProfile(db, PRODUCT, profile as LegacyRecurringProfile) as RecurringProfile;
};

export const deleteRecurringProfile = (db: Database.Database, id: string): void => {
  deleteSharedRecurringProfile(db, PRODUCT, id);
};
