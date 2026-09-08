import assert from 'node:assert/strict';
import test from 'node:test';
import { createSingleTenantScope, type Client, type RecurringProfile } from '../domain/foundations.js';
import { upsertRecurringProfile, type RecurringDomainDependencies, type RecurringResult } from './recurring.js';
import { runRecurringInvoiceRun } from './recurringRun.js';

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
  items: [{ kind: 'item', description: 'Subscription', quantity: 1, price: 100, total: 100 }],
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
        const existingIndex = state.profiles.findIndex((entry) => entry.id === next.id);
        state.profiles = existingIndex < 0
          ? [...state.profiles, next]
          : state.profiles.map((entry) => entry.id === next.id ? next : entry);
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

test('the shared recurring seam commits good profiles and reports later profile failures', async () => {
  const state: State = {
    profiles: [
      profile('profile-ok', 'client-1', 'A succeeds'),
      { ...profile('profile-empty', 'client-1', 'B empty'), amount: 0, items: [] },
    ],
    invoices: [],
    nextNumber: 1,
  };
  const audit: Array<{ change?: { after?: unknown } }> = [];
  const result = await runRecurringInvoiceRun(scope, createDependencies(state, new Map([['client-1', client('client-1')]])), {
    auditLog: { append: async (_scope, entry) => { audit.push(entry); return entry as never; } },
    actor: { type: 'service', id: 'test-http', displayName: 'test-http' },
    reason: 'manual',
    action: 'recurring.manual_run',
    clock,
    afterProcess: () => {
      state.lastRecurringRun = clock.nowIso();
    },
  });

  assert.deepEqual(result, {
    generated: 1,
    deactivated: 0,
    errors: [{ profileName: 'B empty', error: 'Das Abo-Profil profile-empty muss mindestens eine Position enthalten.' }],
  });
  assert.equal(state.invoices.length, 1);
  assert.equal(state.nextNumber, 2);
  assert.equal(state.profiles[0]?.lastRun, '2026-08-22');
  assert.equal(state.profiles[0]?.nextRun, '2026-09-01');
  assert.equal(state.profiles[1]?.lastRun, undefined);
  assert.equal(state.profiles[1]?.nextRun, '2026-08-01');
  assert.equal(state.lastRecurringRun, clock.nowIso());
  assert.deepEqual(audit[0]?.change?.after, result);
});

test('a summary audit failure stays visible after committed profile progress', async () => {
  const state: State = { profiles: [profile('profile-1', 'client-1', 'Monthly')], invoices: [], nextNumber: 1 };
  const dependencies = createDependencies(state, new Map([['client-1', client('client-1')]]));
  const options = {
    auditLog: { append: async () => { throw new Error('audit unavailable'); } },
    actor: { type: 'service' as const, id: 'test-worker', displayName: 'test-worker' },
    reason: 'scheduled',
    clock,
    afterProcess: () => {
      state.lastRecurringRun = clock.nowIso();
    },
  };

  await assert.rejects(
    runRecurringInvoiceRun(scope, dependencies, options),
    /audit unavailable/,
  );

  assert.equal(state.invoices.length, 1);
  assert.equal(state.nextNumber, 2);
  assert.equal(state.profiles[0]?.lastRun, '2026-08-22');
  assert.equal(state.lastRecurringRun, undefined);

  // A retry sees the already advanced profile and cannot duplicate its invoice.
  await assert.rejects(runRecurringInvoiceRun(scope, dependencies, options), /audit unavailable/);
  assert.equal(state.invoices.length, 1);
  assert.equal(state.nextNumber, 2);
});

test('invoice persistence infrastructure failures are not reported as profile errors', async () => {
  const state: State = { profiles: [profile('profile-1', 'client-1', 'Monthly')], invoices: [], nextNumber: 1 };
  const dependencies = createDependencies(state, new Map([['client-1', client('client-1')]]));
  dependencies.invoicePort.save = async () => { throw new Error('database unavailable'); };

  await assert.rejects(
    runRecurringInvoiceRun(scope, dependencies, {
      auditLog: { append: async () => { throw new Error('audit must not run'); } },
      actor: { type: 'service', id: 'test-worker', displayName: 'test-worker' },
      reason: 'scheduled',
      clock,
    }),
    /database unavailable/,
  );
  assert.equal(state.invoices.length, 0);
  assert.equal(state.nextNumber, 1);
  assert.equal(state.profiles[0]?.lastRun, undefined);
});

test('known invoice validation failures are isolated as profile errors', async () => {
  const state: State = { profiles: [profile('profile-1', 'client-1', 'Monthly')], invoices: [], nextNumber: 1 };
  const dependencies = createDependencies(state, new Map([['client-1', client('client-1')]]));
  dependencies.invoicePort.save = async () => {
    const error = new Error('Invoice line is invalid') as Error & { code?: string };
    error.code = 'INVOICE_VALIDATION';
    throw error;
  };

  const result = await runRecurringInvoiceRun(scope, dependencies, {
    auditLog: { append: async (_scope, entry) => entry as never },
    actor: { type: 'service', id: 'test-worker', displayName: 'test-worker' },
    reason: 'scheduled',
    clock,
  });

  assert.deepEqual(result, {
    generated: 0,
    deactivated: 0,
    errors: [{
      profileName: 'Monthly',
      error: 'Die Rechnungsdaten des Abo-Profils sind ungültig: Invoice line is invalid',
    }],
  });
  assert.equal(state.invoices.length, 0);
  assert.equal(state.nextNumber, 1);
  assert.equal(state.profiles[0]?.lastRun, undefined);
});

test('upsert accepts a zero cache amount when billable positions provide the value', async () => {
  const state: State = { profiles: [], invoices: [], nextNumber: 1 };
  const cachedAmountProfile = { ...profile('profile-cached-amount', 'client-1', 'Cached amount'), amount: 0 };
  const dependencies = createDependencies(state, new Map());

  const saved = await upsertRecurringProfile(scope, dependencies, cachedAmountProfile);

  assert.equal(saved.amount, 0);
  assert.equal(state.profiles.length, 1);
});

test('the shared upsert seam rejects empty and zero-value writes, including legacy profiles', async () => {
  const legacy = { ...profile('legacy-empty', 'client-1', 'Legacy'), amount: 0, items: [] };
  const state: State = { profiles: [legacy], invoices: [], nextNumber: 1 };
  const dependencies = createDependencies(state, new Map());

  await assert.rejects(
    async () => upsertRecurringProfile(scope, dependencies, {
        ...profile('profile-invalid', 'client-1', 'Invalid'),
        amount: 0,
        items: [],
      }),
    /mindestens eine Position/,
  );
  assert.deepEqual(state.profiles, [legacy]);

  await assert.rejects(
    async () => upsertRecurringProfile(scope, dependencies, {
      ...profile('profile-phantom', 'client-1', 'Phantom'),
      items: [{ kind: 'item', description: 'Phantom total', quantity: 0, price: 100, total: 100 }],
    }),
    /Beschreibung, gültiger Menge/,
  );
  assert.deepEqual(state.profiles, [legacy]);

  await assert.rejects(
    async () => upsertRecurringProfile(scope, dependencies, {
      ...profile('profile-mixed', 'client-1', 'Mixed'),
      items: [
        ...profile('profile-mixed', 'client-1', 'Mixed').items,
        { kind: 'item', description: '', quantity: 1, price: 100, total: 100 },
      ],
    }),
    /Beschreibung, gültiger Menge/,
  );
  assert.deepEqual(state.profiles, [legacy]);

  await assert.rejects(
    async () => upsertRecurringProfile(scope, dependencies, { ...legacy, name: 'Legacy corrected later' }),
    /mindestens eine Position/,
  );
  assert.equal(state.profiles[0]?.name, 'Legacy');
});
