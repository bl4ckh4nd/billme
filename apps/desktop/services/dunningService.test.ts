import { createSingleTenantScope, type DunningHistoryEntry, type DunningSettings, type Invoice } from '@billme/server-core/domain';
import type { AuditEntry } from '@billme/server-core/ports';
import { processDunningRun, shouldRunScheduledDunning, summarizeInvoiceDunningStatus } from '@billme/server-core/services';
import { describe, expect, it, vi } from 'vitest';

const scope = createSingleTenantScope('default', 'lite');

const createInvoice = (): Invoice => ({
  kind: 'invoice',
  tenantId: scope.tenantId,
  id: 'inv-1',
  number: 'RE-1',
  client: 'Acme GmbH',
  clientEmail: 'billing@acme.test',
  taxMode: 'standard_vat',
  date: '2024-01-01',
  dueDate: '2024-01-10',
  amount: 100,
  // Stored as open: the run must derive "overdue" from the due date itself.
  status: 'open',
  items: [],
  payments: [],
  history: [],
});

const createSettings = (): DunningSettings => ({
  company: {
    name: 'Billme GmbH',
    email: 'info@billme.test',
  },
  email: {
    provider: 'smtp',
    smtpHost: 'smtp.billme.test',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: 'mailer',
    fromName: '',
    fromEmail: '',
  },
  dunning: {
    levels: [
      {
        id: 1,
        name: 'Zahlungserinnerung',
        enabled: true,
        daysAfterDueDate: 5,
        fee: 10,
        subject: 'Mahnung %N',
        text: 'Rechnung %N ist %T Tage überfällig. Gebühr %F.',
      },
    ],
  },
  automation: {
    dunningEnabled: true,
    dunningRunTime: '09:00',
  },
});

describe('dunning domain service', () => {
  it('applies a dunning fee only once across retries', async () => {
    const invoice = createInvoice();
    const settings = createSettings();
    const history: DunningHistoryEntry[] = [];
    const sendResults = [
      { success: false as const, error: 'SMTP unavailable' },
      { success: true as const, messageId: 'msg-1' },
    ];

    const invoiceRepo = {
      list: vi.fn(async () => [invoice]),
      getById: vi.fn(async (_scope, id: string) => (id === invoice.id ? invoice : null)),
      save: vi.fn(async (_scope, nextInvoice: Invoice) => {
        Object.assign(invoice, nextInvoice);
        return invoice;
      }),
    };

    const settingsRepo = {
      get: vi.fn(async () => settings),
      save: vi.fn(async (_scope, nextSettings: DunningSettings) => {
        Object.assign(settings, nextSettings);
      }),
    };

    const dunningHistoryRepo = {
      listByInvoice: vi.fn(async (_scope, invoiceId: string) => history.filter((entry) => entry.invoiceId === invoiceId)),
      record: vi.fn(async (_scope, entry: Omit<DunningHistoryEntry, 'id' | 'createdAt'>) => {
        const savedEntry: DunningHistoryEntry = {
          ...entry,
          id: `hist-${history.length + 1}`,
          createdAt: entry.processedAt,
        };
        history.push(savedEntry);
        return savedEntry;
      }),
    };

    const emailPort = {
      send: vi.fn(async () => {
        const next = sendResults.shift();
        if (!next) {
          throw new Error('No email result queued');
        }
        return next;
      }),
      log: vi.fn(async (_scope, entry) => ({
        ...entry,
        id: `mail-${history.length + 1}`,
        createdAt: entry.sentAt,
      })),
    };

    const auditLog = {
      append: vi.fn(async (_scope, entry): Promise<AuditEntry> => ({
        ...entry,
        sequence: 1,
        hash: 'hash',
      })),
    };

    const dependencies = {
      invoiceRepo,
      settingsRepo,
      dunningHistoryRepo,
      emailPort,
      secretStore: {
        get: vi.fn(async () => 'secret'),
      },
      auditLog,
      clock: {
        now: () => new Date('2024-02-10T09:05:00.000Z'),
        nowIso: () => '2024-02-10T09:05:00.000Z',
      },
    };

    const firstRun = await processDunningRun(scope, dependencies);
    expect(firstRun.feesApplied).toBe(10);
    expect(firstRun.emailsSent).toBe(0);
    expect(firstRun.errors).toEqual([{ invoiceNumber: 'RE-1', error: 'Email failed: SMTP unavailable' }]);
    expect(invoice.amount).toBe(110);

    const secondRun = await processDunningRun(scope, dependencies);
    expect(secondRun.feesApplied).toBe(0);
    expect(secondRun.emailsSent).toBe(1);
    expect(invoice.amount).toBe(110);
    expect(history).toHaveLength(2);
    expect(history.map((entry) => entry.feeApplied)).toEqual([10, 0]);
    expect(invoice.dunningLevel).toBe(1);
    expect(invoice.history?.[0]?.action).toBe('Zahlungserinnerung per E-Mail an billing@acme.test versendet');
    expect(settings.automation.lastDunningRun).toBe('2024-02-10T09:05:00.000Z');
  });

  it('evaluates schedule windows and summarizes invoice status', () => {
    const settings = createSettings();
    const runAt = new Date('2024-02-10T09:05:00');
    expect(shouldRunScheduledDunning(settings, runAt)).toBe(true);

    settings.automation.lastDunningRun = '2024-02-10T06:00:00.000Z';
    expect(shouldRunScheduledDunning(settings, runAt)).toBe(false);

    const status = summarizeInvoiceDunningStatus(
      createInvoice(),
      [
        {
          id: 'hist-1',
          invoiceId: 'inv-1',
          invoiceNumber: 'RE-1',
          dunningLevel: 1,
          daysOverdue: 31,
          feeApplied: 10,
          emailSent: true,
          emailLogId: 'mail-1',
          processedAt: '2024-02-10T09:05:00.000Z',
          createdAt: '2024-02-10T09:05:00.000Z',
        },
      ],
      runAt,
    );

    expect(status.currentLevel).toBe(1);
    expect(status.daysOverdue).toBe(31);
    expect(status.totalFeesApplied).toBe(10);
    expect(status.lastReminderSent).toBe('2024-02-10T09:05:00.000Z');
  });
});
