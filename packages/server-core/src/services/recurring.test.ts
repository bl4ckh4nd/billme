import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSingleTenantScope,
  type Client,
  type ClientAddress,
  type ClientEmail,
  type Invoice,
  type RecurringProfile,
} from '../domain/foundations.js';
import {
  calculateNextRun,
  generateInvoiceFromProfile,
  InvalidRecurringProfileError,
  processRecurringRun,
  type RecurringDomainDependencies,
} from './recurring.js';

const scope = createSingleTenantScope('recurring-tenant', 'pro');
const clock = {
  now: () => new Date('2026-05-10T09:00:00.000Z'),
  nowIso: () => '2026-05-10T09:00:00.000Z',
};

const billingAddress: ClientAddress = {
  id: 'addr-billing', clientId: 'client-1', label: 'HQ', kind: 'billing', company: 'Acme GmbH',
  street: 'Main Street 1', zip: '12345', city: 'Berlin', country: 'DE', isDefaultBilling: true, isDefaultShipping: false,
};
const shippingAddress: ClientAddress = {
  id: 'addr-shipping', clientId: 'client-1', label: 'Warehouse', kind: 'shipping',
  street: 'Storage 9', zip: '67890', city: 'Hamburg', country: 'DE', isDefaultBilling: false, isDefaultShipping: true,
};
const billingEmail: ClientEmail = {
  id: 'mail-1', clientId: 'client-1', label: 'billing', kind: 'billing', email: 'billing@acme.example', isDefaultBilling: true, isDefaultGeneral: false,
};

const makeClient = (overrides: Partial<Client> = {}): Client => ({
  id: 'client-1',
  tenantId: scope.tenantId,
  customerNumber: 'KD-0001',
  company: 'Acme GmbH',
  contactPerson: 'Alice',
  email: 'fallback@acme.example',
  phone: '+49',
  address: 'Fallback Str. 1',
  status: 'active',
  tags: [],
  notes: '',
  projects: [],
  activities: [],
  addresses: [billingAddress, shippingAddress],
  emails: [billingEmail],
  ...overrides,
});

const makeProfile = (overrides: Partial<RecurringProfile> = {}): RecurringProfile => ({
  id: 'profile-1',
  tenantId: scope.tenantId,
  clientId: 'client-1',
  active: true,
  name: 'Maintenance',
  interval: 'monthly',
  nextRun: '2026-05-10',
  amount: 125,
  taxMode: 'standard_vat',
  items: [{ kind: 'item', description: 'Service', quantity: 1, price: 125, total: 125 }],
  ...overrides,
});

const makeSettings = (smallBusinessRule = false) => ({
  numbers: {
    invoicePrefix: 'RE-', nextInvoiceNumber: 1, numberLength: 3,
    offerPrefix: 'AN-', nextOfferNumber: 1, customerPrefix: 'KD-', nextCustomerNumber: 1, customerNumberLength: 4,
  },
  legal: { smallBusinessRule, defaultVatRate: 19, paymentTermsDays: 14 },
});

const setup = (options: { profiles?: RecurringProfile[]; clients?: Record<string, Client | null>; smallBusinessRule?: boolean; failSave?: boolean; failRelease?: boolean } = {}) => {
  const profiles = options.profiles ?? [];
  const clients = options.clients ?? { 'client-1': makeClient() };
  const saved: Array<{ invoice: Invoice; reason: string }> = [];
  const saves: RecurringProfile[] = [];
  const calls = { reserve: 0, release: [] as string[], finalize: [] as Array<[string, string]> };
  const dependencies = {
    tx: { inTransaction: <T>(work: () => T): T => work() },
    clock,
    recurringProfileStore: {
      list: () => profiles,
      getById: (_scope: unknown, id: string) => profiles.find((entry) => entry.id === id) ?? null,
      save: (_scope: unknown, next: RecurringProfile) => { saves.push(next); return next; },
      remove: () => undefined,
    },
    clientPort: { getById: (_scope: unknown, id: string) => clients[id] ?? null },
    invoicePort: {
      save: (_scope: unknown, params: { invoice: Invoice; reason: string }) => {
        if (options.failSave) throw new Error('persist failed');
        saved.push(params);
        return params.invoice;
      },
    },
    numberingPort: {
      getSettings: () => makeSettings(options.smallBusinessRule),
      reserve: () => { calls.reserve += 1; return { reservationId: 'res-1', number: 'RE-2026-001' }; },
      release: (id: string) => {
        calls.release.push(id);
        if (options.failRelease) throw new Error('release failed');
        return { ok: true as const };
      },
      finalize: (id: string, documentId: string) => { calls.finalize.push([id, documentId]); return { ok: true as const }; },
    },
    projectPort: {
      ensureDefaultProject: (clientId: string) => ({
        id: 'project-1', clientId, name: 'Allgemein', status: 'active', budget: 0, startDate: '2026-01-01',
      }),
    },
    createInvoiceId: () => 'invoice-uuid',
  } as unknown as RecurringDomainDependencies & { tx: { inTransaction: <T>(work: () => T) => T } };
  return { dependencies, saved, saves, calls };
};

test('generateInvoiceFromProfile builds a draft from the profile and finalizes the number reservation', () => {
  const { dependencies, saved, calls } = setup();
  const invoice = generateInvoiceFromProfile(scope, dependencies as never, makeProfile());

  assert.equal(invoice.id, 'invoice-uuid');
  assert.equal(invoice.number, 'RE-2026-001');
  assert.equal(invoice.projectId, 'project-1');
  assert.equal(invoice.status, 'draft');
  assert.equal(invoice.clientEmail, 'billing@acme.example');
  assert.ok(invoice.clientAddress?.includes('Acme GmbH'));
  assert.ok(invoice.clientAddress?.includes('Main Street 1'));
  assert.equal(invoice.amount, 148.75);
  assert.equal(invoice.date, '2026-05-10');
  assert.equal(invoice.dueDate, '2026-05-24');
  assert.deepEqual(saved.map((entry) => entry.reason), ['Auto-generated from recurring profile profile-1']);
  assert.equal(saved[0]?.invoice.number, 'RE-2026-001');
  assert.deepEqual(calls.finalize, [['res-1', 'invoice-uuid']]);
  assert.deepEqual(calls.release, []);
});

test('generateInvoiceFromProfile bills the net total under the small business rule', () => {
  const { dependencies } = setup({ smallBusinessRule: true });
  const invoice = generateInvoiceFromProfile(scope, dependencies as never, makeProfile());
  assert.equal(invoice.amount, 125);
});

test('generateInvoiceFromProfile falls back to the legacy client contact fields without structured records', () => {
  const { dependencies } = setup({ clients: { 'client-1': makeClient({ addresses: [], emails: [] }) } });
  const invoice = generateInvoiceFromProfile(scope, dependencies as never, makeProfile());

  assert.equal(invoice.clientEmail, 'fallback@acme.example');
  assert.equal(invoice.clientAddress, 'Fallback Str. 1');
  assert.equal(invoice.billingAddress, undefined);
  assert.equal(invoice.shippingAddress, undefined);
});

test('generateInvoiceFromProfile picks addresses by kind and the general email when no default is flagged', () => {
  const { dependencies } = setup({
    clients: {
      'client-1': makeClient({
        addresses: [
          { ...billingAddress, id: 'b', isDefaultBilling: false, street: 'Billing St. 7' },
          { ...shippingAddress, id: 's', isDefaultShipping: false, street: 'Shipping St. 8' },
        ],
        emails: [{ id: 'm', clientId: 'client-1', label: 'general', kind: 'general', email: 'general@acme.example', isDefaultBilling: false, isDefaultGeneral: true }],
      }),
    },
  });
  const invoice = generateInvoiceFromProfile(scope, dependencies as never, makeProfile());

  assert.equal(invoice.clientEmail, 'general@acme.example');
  assert.ok(invoice.clientAddress?.includes('Billing St. 7'));
  assert.equal(invoice.shippingAddress?.street, 'Shipping St. 8');
});

test('generateInvoiceFromProfile rejects invalid item values before reserving a number', () => {
  const { dependencies, calls } = setup();
  const badProfile = makeProfile({
    items: [{ kind: 'item', description: 'Invalid', quantity: 'x', price: 'y', total: Number.POSITIVE_INFINITY } as never],
  });

  assert.throws(() => generateInvoiceFromProfile(scope, dependencies as never, badProfile), InvalidRecurringProfileError);
  assert.equal(calls.reserve, 0);
});

test('generateInvoiceFromProfile stamps every supported interval with the run date as service period', () => {
  for (const interval of ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'] as const) {
    const { dependencies } = setup();
    const invoice = generateInvoiceFromProfile(scope, dependencies as never, makeProfile({ interval }));
    assert.equal(invoice.servicePeriod, '2026-05-10', interval);
  }
});

test('generateInvoiceFromProfile rejects an unknown interval before reserving a number', () => {
  const { dependencies, calls } = setup();
  assert.throws(
    () => generateInvoiceFromProfile(scope, dependencies as never, makeProfile({ interval: 'hourly' as never })),
    /Das Abo-Profil profile-1 enthält ein ungültiges Intervall\./,
  );
  assert.equal(calls.reserve, 0);
});

test('generateInvoiceFromProfile rejects a missing client without reserving a number', () => {
  const { dependencies, calls } = setup({ clients: {} });
  assert.throws(
    () => generateInvoiceFromProfile(scope, dependencies as never, makeProfile()),
    /Der Kunde client-1 wurde nicht gefunden\./,
  );
  assert.equal(calls.reserve, 0);
});

test('generateInvoiceFromProfile rejects an inactive client without reserving a number', () => {
  const { dependencies, calls } = setup({ clients: { 'client-1': makeClient({ status: 'inactive' }) } });
  assert.throws(
    () => generateInvoiceFromProfile(scope, dependencies as never, makeProfile()),
    /Der Kunde client-1 ist nicht aktiv \(Status: inactive\)\./,
  );
  assert.equal(calls.reserve, 0);
});

test('generateInvoiceFromProfile rethrows the persistence error when releasing the reservation also fails', () => {
  const { dependencies, calls } = setup({ failSave: true, failRelease: true });
  assert.throws(() => generateInvoiceFromProfile(scope, dependencies as never, makeProfile()), /persist failed/);
  assert.deepEqual(calls.release, ['res-1']);
  assert.deepEqual(calls.finalize, []);
});

test('processRecurringRun generates due profiles, deactivates at endDate, and isolates profile errors', async () => {
  const profiles = [
    makeProfile({ id: 'due-ok', name: 'Due OK', interval: 'weekly' }),
    makeProfile({ id: 'deactivate', name: 'Deactivate', endDate: '2026-05-15' }),
    makeProfile({ id: 'continues', name: 'Continues', endDate: '2026-12-31' }),
    makeProfile({ id: 'error', name: 'Error profile', clientId: 'missing-client', nextRun: '2026-05-09' }),
    makeProfile({ id: 'future', name: 'Future', nextRun: '2026-05-11' }),
    makeProfile({ id: 'inactive', name: 'Inactive', active: false }),
    makeProfile({ id: 'ended', name: 'Ended same day', endDate: '2026-05-10' }),
  ];
  const { dependencies, saves } = setup({ profiles });

  const result = await processRecurringRun(scope, dependencies);

  assert.deepEqual(result, {
    generated: 3,
    deactivated: 1,
    errors: [{ profileName: 'Error profile', error: 'Der Kunde missing-client wurde nicht gefunden.' }],
  });
  assert.deepEqual(saves.map((entry) => entry.id), ['due-ok', 'deactivate', 'continues']);
  const byId = (id: string) => saves.find((entry) => entry.id === id);
  assert.equal(byId('due-ok')?.active, true);
  assert.equal(byId('due-ok')?.lastRun, '2026-05-10');
  assert.equal(byId('due-ok')?.nextRun, '2026-05-17');
  assert.equal(byId('deactivate')?.active, false);
  assert.equal(byId('deactivate')?.lastRun, '2026-05-10');
  assert.equal(byId('deactivate')?.nextRun, '2026-05-15');
  assert.equal(byId('continues')?.active, true);
  assert.equal(byId('continues')?.nextRun, '2026-06-10');
});

test('calculateNextRun advances each interval and clamps to the last day of shorter months', () => {
  assert.equal(calculateNextRun('2026-12-31', 'daily'), '2027-01-01');
  assert.equal(calculateNextRun('2026-05-10', 'weekly'), '2026-05-17');
  assert.equal(calculateNextRun('2026-01-31', 'monthly'), '2026-02-28');
  assert.equal(calculateNextRun('2026-12-15', 'monthly'), '2027-01-15');
  assert.equal(calculateNextRun('2026-11-30', 'quarterly'), '2027-02-28');
  assert.equal(calculateNextRun('2028-02-29', 'yearly'), '2029-02-28');
});

test('calculateNextRun rejects an unsupported interval', () => {
  assert.throws(() => calculateNextRun('2026-01-01', 'hourly' as never), /Unsupported interval/);
});
