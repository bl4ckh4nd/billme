import assert from 'node:assert/strict';
import test from 'node:test';
import { createSingleTenantScope, type Client, type RecurringProfile } from '../domain/foundations.js';
import type { RecurringDomainDependencies, RecurringResult } from './recurring.js';
import { runRecurringInvoiceRun, toRecurringRunFailure } from './recurringRun.js';

const scope = createSingleTenantScope('recurring-run-tenant', 'lite');
const clock = {
  now: () => new Date('2026-08-22T10:00:00.000Z'),
  nowIso: () => '2026-08-22T10:00:00.000Z',
};

const client = (id: string): Client => ({
  id,
  tenantId: scope.tenantId,
  customerNumber: 'KD-0001',
  company: 'Recurring Client',
  contactPerson: '',
  email: 'client@example.test',
  phone: '',
  address: '',
  status: 'active',
  tags: [],
  notes: '',
  addresses: [],
  emails: [],
  projects: [],
  activities: [],
});

const profile = (id: string, clientId: string, name: string): RecurringProfile => ({
  id,
  tenantId: scope.tenantId,
  clientId,
  active: true,
  name,
  interval: 'monthly',
  nextRun: '2026-08-01',
  amount: 100,
  items: [],
  taxMode: 'standard_vat',
});

type State = {
  profiles: RecurringProfile[];
  invoices: Array<{ id: string }>;
  nextNumber: number;
  lastRecurringRun?: string;
};

const createDependencies = (state: State, clients: Map<string, Client>) => {
  let transactionDepth = 0;
  let snapshot: State | undefined;
  const transaction = {
    inTransaction: async <T>(work: () => Promise<T> | T): Promise<T> => {
      if (transactionDepth > 0) return work();
      transactionDepth += 1;
      snapshot = structuredClone(state);
      try {
        return await work();
      } catch (error) {
        state.profiles = snapshot.profiles;
        state.invoices = snapshot.invoices;
        state.nextNumber = snapshot.nextNumber;
        state.lastRecurringRun = snapshot.lastRecurringRun;
        throw error;
      } finally {
        transactionDepth = 0;
        snapshot = undefined;
      }
    },
  };
  const settings = {
    numbers: {
      invoicePrefix: 'RE-', nextInvoiceNumber: state.nextNumber, numberLength: 4,
      offerPrefix: 'AN-', nextOfferNumber: 1, customerPrefix: 'KD-', nextCustomerNumber: 1, customerNumberLength: 4,
    },
    legal: { smallBusinessRule: false, defaultVatRate: 19, paymentTermsDays: 14 },
  };
  const dependencies: RecurringDomainDependencies = {
    tx: transaction,
    recurringProfileStore: {
      list: async () => state.profiles,
      getById: async (_scope, id) => state.profiles.find((entry) => entry.id === id) ?? null,
      save: async (_scope, next) => {
        state.profiles = state.profiles.map((entry) => entry.id === next.id ? next : entry);
        return next;
      },
      remove: async (_scope, id) => {
        state.profiles = state.profiles.filter((entry) => entry.id !== id);
      },
    },
    clientPort: { getById: async (_scope, id) => clients.get(id) ?? null },
    invoicePort: {
      save: async (_scope, params) => {
        state.invoices.push({ id: params.invoice.id });
        return params.invoice;
      },
    },
    numberingPort: {
      getSettings: async () => ({ ...settings, numbers: { ...settings.numbers, nextInvoiceNumber: state.nextNumber } }),
      reserve: async () => {
        const number = `RE-${String(state.nextNumber).padStart(4, '0')}`;
        state.nextNumber += 1;
        return { reservationId: `reservation-${state.nextNumber}`, number };
      },
      release: async () => ({ ok: true as const }),
      finalize: async () => ({ ok: true as const }),
    },
    projectPort: {
      ensureDefaultProject: async (clientId) => ({
        id: `project-${clientId}`,
        clientId,
        name: 'Allgemein',
        status: 'active',
        budget: 0,
        startDate: '2026-01-01',
      }),
    },
    createInvoiceId: () => `invoice-${state.invoices.length + 1}`,
  };
  return dependencies;
};

test('the shared recurring seam gives HTTP and worker adapters identical success semantics', async () => {
  const state: State = { profiles: [profile('profile-1', 'client-1', 'Monthly')], invoices: [], nextNumber: 1 };
  const audit: Array<{ action: string; result: RecurringResult }> = [];
  const result = await runRecurringInvoiceRun(scope, createDependencies(state, new Map([['client-1', client('client-1')]])), {
    auditLog: { append: async (_scope, entry) => {
      audit.push({ action: entry.action, result: entry.change?.after as RecurringResult });
      return entry as never;
    } },
    actor: { type: 'service', id: 'test-worker', displayName: 'test-worker' },
    reason: 'scheduled',
    action: 'recurring.scheduled_run',
    clock,
  });

  assert.deepEqual(result, { generated: 1, deactivated: 0, errors: [] });
  assert.equal(state.invoices.length, 1);
  assert.equal(state.nextNumber, 2);
  assert.equal(state.profiles[0]?.lastRun, '2026-08-22');
  assert.deepEqual(audit, [{ action: 'recurring.scheduled_run', result }]);
});

test('the shared recurring seam rolls back all mutations and emits no run audit on a later profile failure', async () => {
  const state: State = {
    profiles: [profile('profile-ok', 'client-1', 'A succeeds'), profile('profile-fails', 'missing-client', 'B fails')],
    invoices: [],
    nextNumber: 1,
  };
  const audit: unknown[] = [];
  let thrown: unknown;
  try {
    await runRecurringInvoiceRun(scope, createDependencies(state, new Map([['client-1', client('client-1')]])), {
      auditLog: { append: async (_scope, entry) => { audit.push(entry); return entry as never; } },
      actor: { type: 'service', id: 'test-http', displayName: 'test-http' },
      reason: 'manual',
      action: 'recurring.manual_run',
      clock,
      afterProcess: () => {
        state.lastRecurringRun = clock.nowIso();
      },
    });
  } catch (error) {
    thrown = error;
  }

  const failure = toRecurringRunFailure(thrown);
  assert.ok(failure);
  assert.deepEqual(failure.result, {
    generated: 1,
    deactivated: 0,
    errors: [{ profileName: 'B fails', error: 'Client missing-client not found' }],
  });
  assert.deepEqual(state.invoices, []);
  assert.equal(state.nextNumber, 1);
  assert.equal(state.profiles[0]?.lastRun, undefined);
  assert.equal(state.lastRecurringRun, undefined);
  assert.deepEqual(audit, []);
});
