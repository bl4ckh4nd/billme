import { createSingleTenantScope, type DunningHistoryEntry, type DunningSettings, type Invoice } from '../domain/index.js';
import type { AuditEntry } from '../ports/index.js';
import { processDunningRun, shouldRunScheduledDunning, summarizeInvoiceDunningStatus, type DunningDomainDependencies } from './index.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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

    const invoiceRepo: DunningDomainDependencies<DunningSettings>['invoiceRepo'] = {
      list: async () => [invoice],
      getById: async (_scope, id: string) => (id === invoice.id ? invoice : null),
      save: async (_scope, nextInvoice: Invoice) => {
        Object.assign(invoice, nextInvoice);
        return invoice;
      },
    };

    const settingsRepo: DunningDomainDependencies<DunningSettings>['settingsRepo'] = {
      get: async () => settings,
      save: async (_scope, nextSettings: DunningSettings) => {
        Object.assign(settings, nextSettings);
      },
    };

    const dunningHistoryRepo: DunningDomainDependencies<DunningSettings>['dunningHistoryRepo'] = {
      listByInvoice: async (_scope, invoiceId: string) => history.filter((entry) => entry.invoiceId === invoiceId),
      record: async (_scope, entry: Omit<DunningHistoryEntry, 'id' | 'createdAt'>) => {
        const savedEntry: DunningHistoryEntry = {
          ...entry,
          id: `hist-${history.length + 1}`,
          createdAt: entry.processedAt,
        };
        history.push(savedEntry);
        return savedEntry;
      },
    };

    const emailPort: DunningDomainDependencies<DunningSettings>['emailPort'] = {
      send: async () => {
        const next = sendResults.shift();
        if (!next) {
          throw new Error('No email result queued');
        }
        return next;
      },
      log: async (_scope, entry) => ({
        ...entry,
        id: `mail-${history.length + 1}`,
        createdAt: entry.sentAt,
      }),
    };

    const auditLog: DunningDomainDependencies<DunningSettings>['auditLog'] = {
      append: async (_scope, entry): Promise<AuditEntry> => ({
        ...entry,
        sequence: 1,
        hash: 'hash',
      }),
    };

    const dependencies = {
      invoiceRepo,
      settingsRepo,
      dunningHistoryRepo,
      emailPort,
      secretStore: {
        get: async () => 'secret',
      },
      auditLog,
      clock: {
        now: () => new Date('2024-02-10T09:05:00.000Z'),
        nowIso: () => '2024-02-10T09:05:00.000Z',
      },
    };

    const firstRun = await processDunningRun(scope, dependencies);
    assert.equal(firstRun.feesApplied, 10);
    assert.equal(firstRun.emailsSent, 0);
    assert.deepEqual(firstRun.errors, [{ invoiceNumber: 'RE-1', error: 'Email failed: SMTP unavailable' }]);
    assert.equal(invoice.amount, 110);

    const secondRun = await processDunningRun(scope, dependencies);
    assert.equal(secondRun.feesApplied, 0);
    assert.equal(secondRun.emailsSent, 1);
    assert.equal(invoice.amount, 110);
    assert.equal((history).length, 2);
    assert.deepEqual(history.map((entry) => entry.feeApplied), [10, 0]);
    assert.equal(invoice.dunningLevel, 1);
    assert.equal(invoice.history?.[0]?.action, 'Zahlungserinnerung per E-Mail an billing@acme.test versendet');
    assert.equal(settings.automation.lastDunningRun, '2024-02-10T09:05:00.000Z');
  });

  it('evaluates schedule windows and summarizes invoice status', () => {
    const settings = createSettings();
    const runAt = new Date('2024-02-10T09:05:00');
    assert.equal(shouldRunScheduledDunning(settings, runAt), true);

    settings.automation.lastDunningRun = '2024-02-10T06:00:00.000Z';
    assert.equal(shouldRunScheduledDunning(settings, runAt), false);

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

    assert.equal(status.currentLevel, 1);
    assert.equal(status.daysOverdue, 31);
    assert.equal(status.totalFeesApplied, 10);
    assert.equal(status.lastReminderSent, '2024-02-10T09:05:00.000Z');
  });
});
