import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('uuid', () => ({
  v4: () => 'invoice-uuid',
}));
import { bootstrapSql } from '../db/bootstrap';
import { getClient, upsertClient } from '../db/clientsRepo';
import { getInvoice } from '../db/invoicesRepo';
import { listRecurringProfiles, upsertRecurringProfile } from '../db/recurringRepo';
import { getSettings, setSettings } from '../db/settingsRepo';
import { MOCK_SETTINGS } from '../data/mockData';
import type { Client, RecurringProfile } from '../types';
import { processRecurringRun, shouldRunScheduledRecurring } from './recurringService';

const canRunNativeSqlite = (() => {
  try {
    const probe = new Database(':memory:');
    probe.close();
    return true;
  } catch {
    return false;
  }
})();

const createDb = (): Database.Database => {
  const db = new Database(':memory:');
  db.exec(bootstrapSql);
  setSettings(db, structuredClone(MOCK_SETTINGS));
  return db;
};

const client: Client = {
  id: 'client-1',
  customerNumber: 'KD-0001',
  company: 'Acme GmbH',
  contactPerson: 'Alice',
  email: 'fallback@acme.example',
  phone: '+49',
  address: 'Fallback Str. 1',
  status: 'active',
  avatar: '',
  tags: [],
  notes: '',
  projects: [],
  activities: [],
  addresses: [
    {
      id: 'addr-billing',
      clientId: 'client-1',
      label: 'HQ',
      kind: 'billing',
      company: 'Acme GmbH',
      street: 'Main Street 1',
      zip: '12345',
      city: 'Berlin',
      country: 'DE',
      isDefaultBilling: true,
    },
  ],
  emails: [
    {
      id: 'mail-1',
      clientId: 'client-1',
      label: 'billing',
      kind: 'billing',
      email: 'billing@acme.example',
      isDefaultBilling: true,
    },
  ],
};

const profile: RecurringProfile = {
  id: 'profile-1',
  clientId: 'client-1',
  active: true,
  name: 'Maintenance',
  interval: 'monthly',
  nextRun: '2026-05-10',
  amount: 0,
  items: [
    { description: 'Service A', quantity: 2, price: 50, total: 0 },
    { description: 'Service B', quantity: 1, price: 25, total: 25 },
  ],
};

describe.skipIf(!canRunNativeSqlite)('recurringService sqlite adapters', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T09:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('generates invoices through the shared sqlite adapter stack and updates recurring state', async () => {
    const db = createDb();
    upsertClient(db, client);
    upsertRecurringProfile(db, profile);

    const result = await processRecurringRun(db, getSettings(db)!);
    const storedInvoice = getInvoice(db, 'invoice-uuid');
    const storedClient = getClient(db, client.id);
    const storedProfiles = listRecurringProfiles(db);

    expect(result).toEqual({ generated: 1, deactivated: 0, errors: [] });
    expect(storedClient?.customerNumber).toBe(client.customerNumber);
    expect(storedInvoice).toEqual(
      expect.objectContaining({
        id: 'invoice-uuid',
        clientId: client.id,
        clientEmail: 'billing@acme.example',
        projectId: expect.any(String),
        status: 'draft',
      }),
    );
    expect(storedInvoice?.number).toBe('RE-2026-104');
    expect(storedInvoice?.amount).toBeCloseTo(148.75, 5);
    expect(storedProfiles).toEqual([
      expect.objectContaining({
        id: profile.id,
        lastRun: '2026-05-10',
        nextRun: '2026-06-10',
        active: true,
      }),
    ]);
  });

  it('uses the shared recurring schedule helper for automation timing', () => {
    const settings = structuredClone(MOCK_SETTINGS);
    settings.automation.recurringEnabled = true;
    settings.automation.recurringRunTime = '09:00';

    const scheduledNow = new Date(2026, 4, 10, 9, 5);
    expect(shouldRunScheduledRecurring(settings, scheduledNow)).toBe(true);

    settings.automation.lastRecurringRun = new Date(2026, 4, 10, 8, 0).toISOString();
    expect(shouldRunScheduledRecurring(settings, scheduledNow)).toBe(false);
  });
});
