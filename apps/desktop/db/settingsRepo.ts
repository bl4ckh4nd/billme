import type Database from 'better-sqlite3';
import type { AppSettings } from '../types';
import { strictJsonParse, SettingsSchema } from './validation-schemas';
import { logger } from '../utils/logger';

const normalizeSettings = (settings: unknown): AppSettings => {
  const next = settings as Partial<AppSettings>;
  // Backward compatibility for older saved settings that predate the portal section.
  if (!next.portal) {
    next.portal = { baseUrl: '' };
  } else if (typeof next.portal.baseUrl !== 'string') {
    next.portal.baseUrl = '';
  }
  if (!next.eInvoice) {
    next.eInvoice = {
      enabled: false,
      standard: 'zugferd-en16931',
      profile: 'EN16931',
      version: '2.3',
    };
  } else {
    if (typeof next.eInvoice.enabled !== 'boolean') {
      next.eInvoice.enabled = false;
    }
    if (next.eInvoice.standard !== 'zugferd-en16931') {
      next.eInvoice.standard = 'zugferd-en16931';
    }
    if (next.eInvoice.profile !== 'EN16931') {
      next.eInvoice.profile = 'EN16931';
    }
    if (next.eInvoice.version !== '2.3') {
      next.eInvoice.version = '2.3';
    }
  }
  // Backward compatibility for email section.
  if (!next.email) {
    next.email = {
      provider: 'none',
      smtpHost: '',
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: '',
      fromName: '',
      fromEmail: '',
    };
  }
  // Backward compatibility for numbering section.
  if (!next.numbers) {
    next.numbers = {
      invoicePrefix: 'RE-%Y-',
      nextInvoiceNumber: 1,
      numberLength: 3,
      offerPrefix: 'ANG-%Y-',
      nextOfferNumber: 1,
      customerPrefix: 'KD-',
      nextCustomerNumber: 1,
      customerNumberLength: 4,
    };
  } else {
    if (typeof next.numbers.customerPrefix !== 'string') {
      next.numbers.customerPrefix = 'KD-';
    }
    if (typeof next.numbers.nextCustomerNumber !== 'number' || !Number.isFinite(next.numbers.nextCustomerNumber)) {
      next.numbers.nextCustomerNumber = 1;
    }
    if (typeof next.numbers.customerNumberLength !== 'number' || !Number.isFinite(next.numbers.customerNumberLength)) {
      next.numbers.customerNumberLength = 4;
    }
  }
  // Backward compatibility for automation section.
  if (!next.automation) {
    next.automation = {
      dunningEnabled: false,
      dunningRunTime: '09:00',
      recurringEnabled: false,
      recurringRunTime: '03:00',
    };
  } else {
    if (typeof next.automation.recurringEnabled !== 'boolean') {
      next.automation.recurringEnabled = false;
    }
    if (typeof next.automation.recurringRunTime !== 'string') {
      next.automation.recurringRunTime = '03:00';
    }
  }
  // Backward compatibility for dashboard section.
  if (!next.dashboard) {
    next.dashboard = {
      monthlyRevenueGoal: 30000,
      dueSoonDays: 7,
      topCategoriesLimit: 5,
      recentPaymentsLimit: 5,
      topClientsLimit: 5,
    };
  }
  // Backward compatibility for dunning level enabled field.
  if (next.dunning?.levels) {
    next.dunning.levels = next.dunning.levels.map((level: any) => ({
      ...level,
      enabled: level.enabled !== undefined ? level.enabled : true,
    }));
  }
  return next as AppSettings;
};

export const getSettings = (db: Database.Database): AppSettings | null => {
  const row = db.prepare('SELECT settings_json FROM settings WHERE id = 1').get() as
    | { settings_json: string }
    | undefined;
  if (!row) return null;
  try {
    const parsed = strictJsonParse(row.settings_json, SettingsSchema, 'Application settings');
    return normalizeSettings(parsed);
  } catch (error) {
    logger.error('SettingsRepo', 'Failed to parse settings, returning null', error as Error);
    return null;
  }
};

export const setSettings = (db: Database.Database, settings: AppSettings): void => {
  db.prepare(
    `
      INSERT INTO settings (id, settings_json)
      VALUES (1, @json)
      ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json
    `,
  ).run({ json: JSON.stringify(settings) });
};
