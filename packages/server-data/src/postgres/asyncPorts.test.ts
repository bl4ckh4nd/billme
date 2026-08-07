import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSingleTenantScope,
  type Client,
  type ClientProject,
  type Invoice,
  type RecurringProfile,
} from '@billme/server-core';
import type {
  DefaultProjectPorts,
  DocumentNumberReservation,
  DocumentNumberingPorts,
  RecurringNumberingSettingsShape,
} from '@billme/server-core/ports';
import {
  ensureDefaultProjectForClient,
  generateInvoiceFromProfile,
  processRecurringRun,
  reserveDocumentNumber,
  type RecurringDomainDependencies,
} from '@billme/server-core/services';

const scope = createSingleTenantScope('tenant-1', 'lite');

const createSettings = (): RecurringNumberingSettingsShape => ({
  numbers: {
    invoicePrefix: 'INV-%Y-',
    nextInvoiceNumber: 1,
    numberLength: 3,
    offerPrefix: 'OFF-%Y-',
    nextOfferNumber: 1,
    customerPrefix: 'CUST-',
    nextCustomerNumber: 1,
    customerNumberLength: 3,
  },
  legal: {
    smallBusinessRule: false,
    defaultVatRate: 19,
    paymentTermsDays: 14,
  },
});

const createClient = (): Client => ({
  tenantId: scope.tenantId,
  id: 'client-1',
  customerNumber: 'CUST-001',
  company: 'Acme GmbH',
  contactPerson: 'Ada Lovelace',
  email: 'billing@acme.test',
  phone: '01234',
  address: 'Main Street 1',
  status: 'active',
  tags: [],
  notes: '',
  addresses: [
    {
      id: 'addr-1',
      clientId: 'client-1',
      label: 'Rechnungsadresse',
      kind: 'billing',
      street: 'Main Street 1',
      zip: '10115',
      city: 'Berlin',
      country: 'DE',
      isDefaultBilling: true,
      isDefaultShipping: true,
    },
  ],
  emails: [
    {
      id: 'email-1',
      clientId: 'client-1',
      label: 'Buchhaltung',
      kind: 'billing',
      email: 'billing@acme.test',
      isDefaultBilling: true,
      isDefaultGeneral: true,
    },
  ],
  projects: [],
  activities: [],
});

const createProject = (): ClientProject => ({
  id: 'project-1',
  clientId: 'client-1',
  code: 'PRJ-2026-001',
  name: 'Allgemein',
  status: 'active',
  budget: 0,
  startDate: '2026-04-20',
});

const createProfile = (): RecurringProfile => ({
  tenantId: scope.tenantId,
  id: 'recurring-1',
  clientId: 'client-1',
  active: true,
  name: 'Hosting',
  interval: 'monthly',
  nextRun: '2026-04-20',
  amount: 119,
  taxMode: 'standard_vat',
  items: [
    {
      description: 'Hosting',
      quantity: 1,
      price: 100,
      total: 100,
    },
  ],
});

test('reserveDocumentNumber supports async numbering ports', async () => {
  let settings = createSettings();
  const reservations: DocumentNumberReservation[] = [];

  const ports: DocumentNumberingPorts<typeof settings> = {
    tx: {
      async inTransaction<TResult>(work: () => TResult | Promise<TResult>) {
        return work();
      },
    },
    async getSettings() {
      return structuredClone(settings);
    },
    async saveSettings(nextSettings) {
      settings = structuredClone(nextSettings);
    },
    async createReservation(reservation) {
      reservations.push({ ...reservation });
    },
    async getReservationById() {
      return null;
    },
    async updateReservation() {
      return;
    },
    async isNumberTaken(kind, number) {
      return (
        (kind === 'customer' && number === 'CUST-001') ||
        reservations.some((reservation) => (
          reservation.kind === kind &&
          reservation.number === number &&
          reservation.status !== 'released'
        ))
      );
    },
    async generateReservationId() {
      return 'reservation-1';
    },
  };

  const result = await reserveDocumentNumber(ports, 'customer');

  assert.deepEqual(result, { reservationId: 'reservation-1', number: 'CUST-002' });
  assert.equal(settings.numbers.nextCustomerNumber, 3);
  assert.equal(reservations[0]?.status, 'reserved');
});

test('reserveDocumentNumber skips taken offer numbers', async () => {
  let settings = createSettings();
  const ports: DocumentNumberingPorts<typeof settings> = {
    tx: {
      async inTransaction<TResult>(work: () => TResult | Promise<TResult>) {
        return work();
      },
    },
    async getSettings() {
      return structuredClone(settings);
    },
    async saveSettings(nextSettings) {
      settings = structuredClone(nextSettings);
    },
    async createReservation() {
      return;
    },
    async getReservationById() {
      return null;
    },
    async updateReservation() {
      return;
    },
    async isNumberTaken(kind, number) {
      return kind === 'offer' && number === 'OFF-2026-001';
    },
    async generateReservationId() {
      return 'reservation-2';
    },
  };

  const result = await reserveDocumentNumber(ports, 'offer', new Date('2026-04-20T08:00:00.000Z'));

  assert.deepEqual(result, { reservationId: 'reservation-2', number: 'OFF-2026-002' });
  assert.equal(settings.numbers.nextOfferNumber, 3);
});

test('ensureDefaultProjectForClient supports async project ports', async () => {
  const savedProjects: ClientProject[] = [];
  const ports: DefaultProjectPorts<ClientProject> = {
    tx: {
      async inTransaction<TResult>(work: () => TResult | Promise<TResult>) {
        return work();
      },
    },
    async getActiveDefaultProjectForClient() {
      return null;
    },
    async listProjectCodesByPrefix() {
      return ['PRJ-2026-001', 'PRJ-2026-002'];
    },
    async saveProject(project) {
      savedProjects.push(project);
      return project;
    },
  };

  const result = await ensureDefaultProjectForClient(ports, {
    clientId: 'client-1',
    createProjectId: () => 'project-3',
    now: new Date('2026-04-20T08:00:00.000Z'),
  });

  assert.equal(result.created, true);
  assert.equal(result.project.code, 'PRJ-2026-003');
  assert.equal(savedProjects[0]?.id, 'project-3');
});

test('generateInvoiceFromProfile releases async reservations when persistence fails', async () => {
  const profile = createProfile();
  const client = createClient();
  const project = createProject();
  const releaseCalls: string[] = [];
  const finalizeCalls: Array<{ reservationId: string; documentId: string }> = [];

  const dependencies: RecurringDomainDependencies = {
    tx: {
      async inTransaction<TResult>(work: () => TResult | Promise<TResult>) {
        return work();
      },
    },
    recurringProfileStore: {
      async list() {
        return [];
      },
      async getById() {
        return null;
      },
      async save(_scope, nextProfile) {
        return nextProfile;
      },
      async remove() {
        return;
      },
    },
    clientPort: {
      async getById() {
        return client;
      },
    },
    invoicePort: {
      async save() {
        throw new Error('persist failed');
      },
    },
    numberingPort: {
      async getSettings() {
        return createSettings();
      },
      async reserve() {
        return { reservationId: 'reservation-1', number: 'INV-2026-001' };
      },
      async release(reservationId) {
        releaseCalls.push(reservationId);
        return { ok: true as const };
      },
      async finalize(reservationId, documentId) {
        finalizeCalls.push({ reservationId, documentId });
        return { ok: true as const };
      },
    },
    projectPort: {
      async ensureDefaultProject() {
        return project;
      },
    },
    createInvoiceId: () => 'invoice-1',
  };

  await assert.rejects(
    async () => generateInvoiceFromProfile(scope, dependencies, profile),
    /persist failed/,
  );
  assert.deepEqual(releaseCalls, ['reservation-1']);
  assert.equal(finalizeCalls.length, 0);
});

test('processRecurringRun handles async recurring dependencies end-to-end', async () => {
  const profile = createProfile();
  const client = createClient();
  const project = createProject();
  const invoices: Invoice[] = [];
  const savedProfiles: RecurringProfile[] = [];
  const finalized: Array<{ reservationId: string; documentId: string }> = [];

  const dependencies: RecurringDomainDependencies = {
    tx: {
      async inTransaction<TResult>(work: () => TResult | Promise<TResult>) {
        return work();
      },
    },
    clock: {
      now: () => new Date('2026-04-20T08:00:00.000Z'),
      nowIso: () => '2026-04-20T08:00:00.000Z',
    },
    recurringProfileStore: {
      async list() {
        return [profile];
      },
      async getById() {
        return profile;
      },
      async save(_scope, nextProfile) {
        savedProfiles.push(nextProfile);
        return nextProfile;
      },
      async remove() {
        return;
      },
    },
    clientPort: {
      async getById() {
        return client;
      },
    },
    invoicePort: {
      async save(_scope, params) {
        invoices.push(params.invoice);
        return params.invoice;
      },
    },
    numberingPort: {
      async getSettings() {
        return createSettings();
      },
      async reserve() {
        return { reservationId: 'reservation-2', number: 'INV-2026-001' };
      },
      async release() {
        return { ok: true as const };
      },
      async finalize(reservationId, documentId) {
        finalized.push({ reservationId, documentId });
        return { ok: true as const };
      },
    },
    projectPort: {
      async ensureDefaultProject() {
        return project;
      },
    },
    createInvoiceId: () => 'invoice-2',
  };

  const result = await processRecurringRun(scope, dependencies);

  assert.deepEqual(result, { generated: 1, deactivated: 0, errors: [] });
  assert.equal(invoices[0]?.number, 'INV-2026-001');
  assert.equal(invoices[0]?.projectId, 'project-1');
  assert.deepEqual(finalized, [{ reservationId: 'reservation-2', documentId: 'invoice-2' }]);
  assert.equal(savedProfiles[0]?.lastRun, '2026-04-20');
  assert.equal(savedProfiles[0]?.nextRun, '2026-05-20');
});
