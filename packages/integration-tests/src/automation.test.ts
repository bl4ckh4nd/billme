import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import type { BillmeApi } from '@billme/desktop-contracts/api';
import { createLiteHttpBillmeApi } from '@billme/desktop-services/liteHttpApi';
import { createProHttpBillmeApi } from '@billme/desktop-services/proHttpApi';
import { PRODUCTS, startProduct, type LiteHarness, type Product } from './harness.js';
import { localIsoDate } from '@billme/server-core';
import { addDays, asSmallBusiness, draftInvoice, issueInvoice, newClient, today } from './fixtures.js';

/**
 * Automation end to end through the Lite desktop backend: recurring invoices,
 * dunning, the e-mail outbox and the backup/restore of the database.
 *
 * How this can fail (each one has a test below):
 * - recurring profiles: empty, zero-value or malformed profiles saved, a
 *   profile for a client that does not exist, changes and deletions not audited
 * - recurring runs: wrong number, date, due date, amount, tax mode, recipient
 *   or project on the generated invoice; a service date instead of the billed
 *   period, a catch-up run billing the run day twice instead of each missed
 *   period, VAT on a Kleinunternehmer's subscription invoice; the next run wrong for an interval
 *   (month ends, leap years); the billing day drifting after a short month;
 *   an end date ignored or a profile never switched off; a second or a
 *   concurrent run creating the invoice twice; inactive profiles or inactive
 *   and unknown clients run, or one broken profile stopping the others; a
 *   failed profile burning an invoice number; generated invoices untraceable
 * - dunning: invoices dunned that are not overdue, paid, still a draft, not
 *   receivables or already settled by a Stornorechnung/full credit note; the wrong level; a fee charged twice or for a mail that was
 *   never sent, or added to the issued invoice's amount (it is the customer's own debt, not taxable
 *   revenue); a reminder whose %A demands what was already paid or credited; the
 *   40 € Pauschale charged to a consumer or on top of fees it replaces; one level mailed twice; the same invoice escalated twice in
 *   one day; a rejected mail recorded as sent; a run that silently does
 *   nothing when automation, levels or the mail provider are missing
 * - e-mail: a mail reported as queued when no provider can deliver it, the
 *   same request queued twice, unknown documents or bad recipients accepted
 * - backup: an archive that does not bring the data back as it was, a corrupt
 *   archive that damages the running database, a restored chain that fails
 *   verification
 * - persistence: profile progress, dunning history and last-run markers gone
 *   after the app restarts (or run again, so everything repeats)
 *
 * Not reachable over HTTP in this composition (native Electron only): the
 * `db:backup`/`db:restore` IPC routes (the backend functions behind them are
 * exercised directly), the scheduler tick `/automation/tick` (needs the desktop
 * integration), and mail delivery by the worker (the harness has no worker, so
 * `email:send` queues).
 */

type Settings = NonNullable<Awaited<ReturnType<BillmeApi['settings']['get']>>>;

const uid = () => randomUUID().slice(0, 8);
const sequenceOf = (number: string): number => Number(number.match(/(\d+)$/)![1]);

/** Minimal SMTP server that accepts AUTH and keeps every message; `reject` makes it refuse recipients. */
const startSmtpSink = async () => {
  const messages: string[] = [];
  const state = { reject: false };
  const sockets = new Set<Socket>();
  const server = createServer((socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    let data: string[] | null = null;
    let authStep = 0;
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply('220 sink ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (data) {
          if (line === '.') { messages.push(data.join('\n')); data = null; reply('250 queued'); } else data.push(line);
          continue;
        }
        if (authStep > 0) { authStep = authStep === 1 ? 2 : 0; reply(authStep === 2 ? '334 UGFzc3dvcmQ6' : '235 ok'); continue; }
        const command = line.split(' ')[0]!.toUpperCase();
        if (command === 'EHLO' || command === 'HELO') socket.write('250-sink\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
        else if (command === 'AUTH') { if (/^AUTH LOGIN$/i.test(line)) { authStep = 1; reply('334 VXNlcm5hbWU6'); } else reply('235 ok'); }
        else if (command === 'RCPT' && state.reject) reply('550 mailbox unavailable');
        else if (command === 'DATA') { data = []; reply('354 go ahead'); }
        else if (command === 'QUIT') { reply('221 bye'); socket.end(); }
        else reply('250 ok');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    messages,
    state,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); sockets.forEach((socket) => socket.destroy()); }),
  };
};

/** Undoes quoted-printable soft breaks and escapes so a mail body can be matched as text. */
const mailText = (message: string): string =>
  message.replace(/=\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

const parseCsv = (text: string): string[][] => text.replace(/^﻿/, '').split('\n').slice(1).filter(Boolean).map((line) => {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') { cell += '"'; i += 1; } else if (char === '"') quoted = false; else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { cells.push(cell); cell = ''; } else cell += char;
  }
  cells.push(cell);
  return cells;
});

/**
 * The Mahngebühr is recorded in the dunning history for both products and never changes the issued
 * invoice. ponytail: Pro does not book it in the journal yet; that needs its own Mahngebühr entry and open item.
 */
const chargedFee = (_product: Product, fee: number) => fee;

/** Last day of the month-long period starting on `start` (local calendar, like the recurring run). */
const monthEnd = (start: string) => {
  const end = new Date(`${start}T12:00:00`);
  end.setMonth(end.getMonth() + 1);
  end.setDate(end.getDate() - 1);
  return localIsoDate(end);
};

const level = (id: number, daysAfterDueDate: number, fee: number, text = `Invoice %N for %K is %T days late, fee %F.`) => ({
  id, name: id === 1 ? 'Zahlungserinnerung' : `${id - 1}. Mahnung`, enabled: true, daysAfterDueDate, fee, subject: `Level ${id} %N`, text,
});

for (const product of PRODUCTS) describe(`automation (${product})`, () => {
  const charged = (fee: number) => chargedFee(product, fee);
  let h: LiteHarness;
  let sink: Awaited<ReturnType<typeof startSmtpSink>>;
  before(async () => {
    process.env.SMTP_PASSWORD = 'integration-secret';
    sink = await startSmtpSink();
    h = await startProduct(product, null, 'automation');
  });
  after(async () => {
    await h.close();
    await sink.close();
    delete process.env.SMTP_PASSWORD;
  });

  const getSettings = async (): Promise<Settings> => (await h.api.settings.get())!;
  const setSettings = (settings: Settings) => h.api.settings.set({ settings });
  /** Changes settings for one test; number counters keep moving and are never rolled back. */
  const withSettings = async (patch: (settings: Settings) => Settings, run: () => Promise<void>) => {
    const original = await getSettings();
    await setSettings(patch(structuredClone(original)));
    try {
      await run();
    } finally {
      await setSettings({ ...original, numbers: (await getSettings()).numbers });
    }
  };
  const smtp = (settings: Settings): Settings => ({
    ...settings,
    email: { ...settings.email, provider: 'smtp', smtpHost: '127.0.0.1', smtpPort: sink.port, smtpSecure: false, smtpUser: 'integration', fromName: 'Holzwerk', fromEmail: 'buero@holzwerk.test' },
  });
  const dunningSetup = (levels: ReturnType<typeof level>[]) => (settings: Settings): Settings => ({
    ...smtp(settings),
    dunning: { levels },
    automation: { ...settings.automation, dunningEnabled: true },
  });

  const makeClient = (overrides: Record<string, unknown> = {}) => h.api.clients.upsert({ client: newClient(overrides) as never });
  const auditRows = async () => parseCsv(await h.api.audit.exportCsv());

  describe('recurring invoices', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const profileBody = (clientId: string, overrides: Record<string, unknown> = {}): Record<string, any> => ({
      id: randomUUID(), clientId, active: true, name: `Abo ${uid()}`, interval: 'monthly', nextRun: today(), amount: 100,
      items: [{ kind: 'item', description: 'Wartung', quantity: 1, price: 100, total: 100 }], ...overrides,
    });
    const saveProfile = (profile: Record<string, unknown>, reason = 'Abo gespeichert') => h.raw('POST', '/recurring', { reason, profile });
    const profileOf = async (id: string) => (await h.raw('GET', '/recurring')).body.find((profile: { id: string }) => profile.id === id);
    const invoicesOf = async (clientId: string) => (await h.api.invoices.list()).filter((invoice) => invoice.clientId === clientId);
    const billingClient = (company = `Abo-Kunde ${uid()}`) => {
      const id = randomUUID();
      return makeClient({
        id, company, email: 'alt@example.com', address: 'Altstraße 1',
        addresses: [{ id: 'a-1', clientId: id, label: 'Rechnung', kind: 'billing', company, street: 'Rechnungsweg 1', zip: '10115', city: 'Berlin', country: 'DE', isDefaultBilling: true, isDefaultShipping: true }],
        emails: [{ id: 'm-1', clientId: id, label: 'Buchhaltung', kind: 'billing', email: 'buchhaltung@abo.example', isDefaultGeneral: true, isDefaultBilling: true }],
      });
    };

    /** A run processes every due profile of the tenant, so each test starts and ends without profiles. */
    afterEach(async () => {
      for (const profile of await h.api.recurring.list()) await h.api.recurring.delete({ id: profile.id });
    });

    test('a single profile reads back by id; an unknown id is null, never another tenant\'s profile', async () => {
      const owner = await billingClient();
      const body = profileBody(owner.id, { name: 'Einzelabruf' });
      assert.equal((await saveProfile(body)).status, 200);
      const read = await h.raw('GET', `/recurring/${body.id}`);
      assert.equal(read.status, 200, read.text);
      assert.deepEqual([read.body.id, read.body.name, read.body.clientId], [body.id, 'Einzelabruf', owner.id]);
      assert.equal((await h.raw('GET', '/recurring/gibt-es-nicht')).body, null);
      assert.equal((await fetch(`${h.connection.baseUrl}/api/v1/${product}/recurring/${body.id}`)).status, 401);
    });

    test('profiles can be created, changed, listed and deleted, and every change is audited with its reason', async () => {
      const owner = await billingClient();
      const body = profileBody(owner.id, { name: 'Wartungsvertrag' });
      const created = await saveProfile(body, 'Abo angelegt');
      assert.equal(created.status, 200, created.text);
      assert.deepEqual({ name: created.body.name, interval: created.body.interval, nextRun: created.body.nextRun, active: created.body.active, amount: created.body.amount }, { name: 'Wartungsvertrag', interval: 'monthly', nextRun: today(), active: true, amount: 100 });
      assert.equal(created.body.taxMode, 'standard_vat', 'a profile without a tax mode defaults to standard VAT');
      assert.ok((await h.api.recurring.list()).some((profile) => profile.id === body.id));

      const changed = await saveProfile({ ...body, name: 'Wartung Premium', interval: 'quarterly', amount: 250, items: [{ kind: 'item', description: 'Premium', quantity: 2, price: 125, total: 250 }], active: false }, 'Abo geändert');
      assert.equal(changed.status, 200, changed.text);
      const stored = (await h.api.recurring.list()).filter((profile) => profile.id === body.id);
      assert.equal(stored.length, 1, 'an update replaces the profile');
      assert.deepEqual({ name: stored[0]!.name, interval: stored[0]!.interval, active: stored[0]!.active, amount: stored[0]!.amount, items: stored[0]!.items }, { name: 'Wartung Premium', interval: 'quarterly', active: false, amount: 250, items: [{ kind: 'item', description: 'Premium', quantity: 2, price: 125, total: 250 }] });

      const deleted = await h.raw('DELETE', `/recurring/${body.id}`, { reason: 'Abo gekündigt' });
      assert.equal(deleted.status, 200, deleted.text);
      assert.ok(!(await h.api.recurring.list()).some((profile) => profile.id === body.id));
      assert.equal((await h.raw('DELETE', `/recurring/${body.id}`, { reason: 'noch einmal' })).status, 404);
      assert.equal((await h.raw('DELETE', `/recurring/${randomUUID()}`, { reason: 'x' })).status, 404);
      assert.equal((await h.raw('DELETE', `/recurring/${randomUUID()}`, {})).status, 400, 'a reason is required');

      const rows = (await auditRows()).filter((row) => row[3] === body.id);
      assert.deepEqual(rows.map((row) => [row[2], row[4], row[5]]), [
        ['recurring-profile', 'recurring.create', 'Abo angelegt'],
        ['recurring-profile', 'recurring.update', 'Abo geändert'],
        ['recurring-profile', 'recurring.delete', 'Abo gekündigt'],
      ]);
      assert.equal(JSON.parse(rows[1]![9]!).name, 'Wartungsvertrag', 'the audit entry keeps the state before the change');
      assert.equal(JSON.parse(rows[1]![10]!).name, 'Wartung Premium');
    });

    test('profiles without a billable position, with a bad amount, interval or name are rejected with 400', async () => {
      const owner = await billingClient();
      const item = { kind: 'item', description: 'Wartung', quantity: 1, price: 100, total: 100 };
      const cases: Array<[string, Record<string, unknown>]> = [
        ['no items', { items: [] }],
        ['only a text line', { items: [{ kind: 'text', description: 'Hinweis', quantity: 0, price: 0, total: 0 }] }],
        ['zero value', { items: [{ ...item, price: 0, total: 0 }] }],
        ['quantity 0 with a total', { items: [{ ...item, quantity: 0 }] }],
        ['blank description', { items: [{ ...item, description: ' ' }] }],
        ['one bad line among good ones', { items: [item, { ...item, description: '' }] }],
        ['negative amount', { amount: -1 }],
        ['unknown interval', { interval: 'hourly' }],
        ['blank name', { name: '  ' }],
        ['missing client id', { clientId: undefined }],
      ];
      const before = (await h.api.recurring.list()).length;
      for (const [label, patch] of cases) {
        const response = await saveProfile({ ...profileBody(owner.id), ...patch });
        assert.equal(response.status, 400, `${label}: ${response.text}`);
      }
      assert.equal((await saveProfile(profileBody(owner.id), '')).status, 400, 'missing reason');
      assert.equal((await h.api.recurring.list()).length, before, 'nothing was saved');
    });

    test('a profile needs an existing client and a real next-run date', async () => {
      const owner = await billingClient();
      const accepted: string[] = [];
      for (const [label, patch] of [['unknown client', { clientId: randomUUID() }], ['next run is not a date', { nextRun: 'bald' }], ['end date is not a date', { endDate: 'irgendwann' }]] as const) {
        if ((await saveProfile({ ...profileBody(owner.id), ...patch })).status === 200) accepted.push(label);
      }
      assert.deepEqual(accepted, []);
    });

    test('a manual run drafts one invoice per due profile with the profile\'s items and the client\'s data', async () => {
      const owner = await billingClient();
      const counter = (await getSettings()).numbers.nextInvoiceNumber;
      const paymentTerms = (await getSettings()).legal.paymentTermsDays;
      const body = profileBody(owner.id, { name: 'Monatsabo', items: [{ kind: 'item', description: 'Wartung', quantity: 2, price: 50, total: 100, taxRate: 19 }] });
      await saveProfile(body);

      const run = await h.api.recurring.manualRun();
      assert.deepEqual(run, { success: true, result: { generated: 1, deactivated: 0, errors: [] } });
      const invoices = await invoicesOf(owner.id);
      assert.equal(invoices.length, 1);
      const invoice = invoices[0]!;
      assert.equal(invoice.status, 'draft', 'generated invoices wait for the owner to issue them');
      assert.equal(invoice.number, `RE-${new Date().getFullYear()}-${String(counter).padStart(3, '0')}`);
      assert.equal(invoice.date, today());
      assert.equal(invoice.dueDate, addDays(today(), paymentTerms));
      assert.equal(invoice.servicePeriod, `${today()} bis ${monthEnd(today())}`, 'a subscription bills its whole period');
      assert.equal(invoice.client, owner.company);
      assert.equal(invoice.clientNumber, owner.customerNumber);
      assert.equal(invoice.clientEmail, 'buchhaltung@abo.example');
      assert.equal(invoice.clientAddress, `${owner.company}\nRechnungsweg 1\n10115 Berlin\nDE`);
      assert.equal(invoice.documentKind, 'invoice');
      assert.deepEqual(invoice.items.map(({ description, quantity, price, total }) => ({ description, quantity, price, total })), [{ description: 'Wartung', quantity: 2, price: 50, total: 100 }]);
      assert.deepEqual({ net: invoice.taxSnapshot!.netAmount, vat: invoice.taxSnapshot!.vatAmount, gross: invoice.taxSnapshot!.grossAmount, mode: invoice.taxMode }, { net: 100, vat: 19, gross: 119, mode: 'standard_vat' });
      assert.equal(invoice.amount, 119);
      assert.equal((await getSettings()).numbers.nextInvoiceNumber, counter + 1, 'exactly one number was used');

      const project = (await h.api.projects.list({ clientId: owner.id }));
      assert.deepEqual(project.map((entry) => entry.name), ['Allgemein'], 'the default project is created once');
      assert.equal(invoice.projectId, project[0]!.id);

      const profile = await profileOf(body.id);
      assert.deepEqual({ lastRun: profile.lastRun, active: profile.active }, { lastRun: today(), active: true });
      const summary = (await auditRows()).filter((row) => row[4] === 'recurring.manual_run').at(-1)!;
      assert.equal(summary[5], 'manual');
      assert.deepEqual(JSON.parse(summary[10]!), { generated: 1, deactivated: 0, errors: [] });
    });

    test('a generated invoice takes addresses and e-mail by default flag, then by kind, then from the legacy contact fields', async () => {
      const byKind = await makeClient({
        company: `Nach Art ${uid()}`, address: 'veraltet', email: 'veraltet@example.com',
        addresses: [
          { id: 's', clientId: 'x', label: 'Lager', kind: 'shipping', street: 'Shipping St. 8', zip: '20095', city: 'Hamburg', country: 'DE', isDefaultBilling: false, isDefaultShipping: false },
          { id: 'b', clientId: 'x', label: 'Rechnung', kind: 'billing', street: 'Billing St. 7', zip: '10115', city: 'Berlin', country: 'DE', isDefaultBilling: false, isDefaultShipping: false },
        ],
        emails: [{ id: 'g', clientId: 'x', label: 'Allgemein', kind: 'general', email: 'general@abo.example', isDefaultGeneral: true, isDefaultBilling: false }],
      });
      const legacy = await makeClient({ company: `Alt ${uid()}`, address: 'Fallback Str. 1', email: 'fallback@abo.example' });
      const flagged = await billingClient();
      for (const owner of [byKind, legacy, flagged]) assert.equal((await saveProfile(profileBody(owner.id))).status, 200);
      assert.equal((await h.api.recurring.manualRun()).result!.generated, 3);

      const [kindInvoice] = await invoicesOf(byKind.id);
      assert.ok(kindInvoice!.clientAddress!.includes('Billing St. 7'));
      assert.equal(kindInvoice!.clientEmail, 'general@abo.example');
      assert.equal((kindInvoice!.billingAddressJson as { street: string }).street, 'Billing St. 7');
      assert.equal((kindInvoice!.shippingAddressJson as { street: string }).street, 'Shipping St. 8', 'a shipping address is found by kind');

      const [legacyInvoice] = await invoicesOf(legacy.id);
      assert.equal(legacyInvoice!.clientAddress, 'Fallback Str. 1');
      assert.equal(legacyInvoice!.clientEmail, 'fallback@abo.example');
      assert.ok(!legacyInvoice!.billingAddressJson && !legacyInvoice!.shippingAddressJson);

      const [flaggedInvoice] = await invoicesOf(flagged.id);
      assert.equal((flaggedInvoice!.shippingAddressJson as { street: string }).street, 'Rechnungsweg 1', 'the flagged default doubles as shipping address');
    });

    test('the next run follows the interval, clamps to short months and handles leap years', async () => {
      const owner = await billingClient();
      // Start dates lie in the past so every profile is due; the expected dates are one interval later.
      const cases: Array<[string, string, string]> = [
        ['daily', '2025-12-31', '2026-01-01'],
        ['weekly', '2025-05-10', '2025-05-17'],
        ['monthly', '2025-01-31', '2025-02-28'],
        ['monthly', '2024-01-31', '2024-02-29'],
        ['monthly', '2025-12-15', '2026-01-15'],
        ['quarterly', '2025-11-30', '2026-02-28'],
        ['quarterly', '2025-01-31', '2025-04-30'],
        ['yearly', '2024-02-29', '2025-02-28'],
      ];
      const ids = new Map<string, string>();
      for (const [interval, nextRun] of cases) {
        const body = profileBody(owner.id, { interval, nextRun, name: `${interval} ${nextRun}` });
        assert.equal((await saveProfile(body)).status, 200);
        ids.set(`${interval} ${nextRun}`, body.id);
      }
      const counter = (await getSettings()).numbers.nextInvoiceNumber;
      assert.deepEqual(await h.api.recurring.manualRun(), { success: true, result: { generated: cases.length, deactivated: 0, errors: [] } });
      for (const [interval, nextRun, expected] of cases) {
        const profile = await profileOf(ids.get(`${interval} ${nextRun}`)!);
        assert.equal(profile.nextRun, expected, `${interval} from ${nextRun}`);
        assert.equal(profile.lastRun, today());
        assert.equal(profile.active, true);
      }
      const numbers = (await invoicesOf(owner.id)).map((invoice) => sequenceOf(invoice.number)).sort((a, b) => a - b);
      assert.deepEqual(numbers, cases.map((_, index) => counter + index), 'one consecutive number per generated invoice');
    });

    test('a monthly profile keeps its billing day after a short month', async () => {
      const owner = await billingClient();
      const body = profileBody(owner.id, { nextRun: '2025-01-31', name: 'Monatsende' });
      await saveProfile(body);
      const sequence: string[] = [];
      for (let run = 0; run < 3; run += 1) {
        await h.api.recurring.manualRun();
        sequence.push((await profileOf(body.id)).nextRun);
      }
      assert.deepEqual(sequence, ['2025-02-28', '2025-03-31', '2025-04-30']);
    });

    test('a profile ends at its end date: the last run switches it off, an expired profile never runs', async () => {
      const owner = await billingClient();
      const ending = profileBody(owner.id, { name: 'Endet', endDate: addDays(today(), 10) });
      const continuing = profileBody(owner.id, { name: 'Läuft weiter', endDate: '2099-12-31' });
      const unlimited = profileBody(owner.id, { name: 'Unbefristet' });
      const expired = profileBody(owner.id, { name: 'Abgelaufen', nextRun: addDays(today(), -40), endDate: addDays(today(), -10) });
      const endsToday = profileBody(owner.id, { name: 'Endet heute', endDate: today() });
      for (const body of [ending, continuing, unlimited, expired, endsToday]) assert.equal((await saveProfile(body)).status, 200);

      assert.deepEqual(await h.api.recurring.manualRun(), { success: true, result: { generated: 3, deactivated: 1, errors: [] } });
      const endingAfter = await profileOf(ending.id);
      assert.deepEqual({ active: endingAfter.active, nextRun: endingAfter.nextRun, lastRun: endingAfter.lastRun }, { active: false, nextRun: ending.endDate, lastRun: today() });
      assert.equal((await profileOf(continuing.id)).active, true);
      assert.equal((await profileOf(unlimited.id)).active, true);
      const expiredAfter = await profileOf(expired.id);
      assert.deepEqual({ nextRun: expiredAfter.nextRun, lastRun: expiredAfter.lastRun }, { nextRun: expired.nextRun, lastRun: undefined }, 'an expired profile is not touched');
      assert.equal((await profileOf(endsToday.id)).lastRun, undefined, 'a profile whose end date is today does not run');
      assert.equal((await invoicesOf(owner.id)).length, 3);

      assert.deepEqual(await h.api.recurring.manualRun(), { success: true, result: { generated: 0, deactivated: 0, errors: [] } }, 'the switched-off profile stays off');
    });

    test('inactive and not yet due profiles are skipped; broken profiles are reported one by one and cost no number', async () => {
      const owner = await billingClient();
      const inactiveOwner = await makeClient({ company: `Inaktiv ${uid()}`, status: 'inactive' });
      const good = profileBody(owner.id, { name: 'Gut' });
      const paused = profileBody(owner.id, { name: 'Pausiert', active: false });
      const future = profileBody(owner.id, { name: 'Zukunft', nextRun: addDays(today(), 3) });
      const forInactiveClient = profileBody(inactiveOwner.id, { name: 'Inaktiver Kunde' });
      const deletedOwner = await makeClient({ company: `Gelöscht ${uid()}` });
      const forGhost = profileBody(deletedOwner.id, { name: 'Gelöschter Kunde' });
      for (const body of [good, paused, future, forInactiveClient, forGhost]) assert.equal((await saveProfile(body)).status, 200);
      assert.equal((await h.raw('DELETE', `/clients/${deletedOwner.id}`, { reason: 'Kunde nach Profilanlage gelöscht' })).status, 200);
      const counter = (await getSettings()).numbers.nextInvoiceNumber;

      const run = await h.api.recurring.manualRun();
      assert.equal(run.success, true);
      assert.equal(run.result!.generated, 1);
      assert.equal(run.result!.deactivated, 0);
      assert.deepEqual(run.result!.errors.map((error) => error.profileName).sort(), ['Gelöschter Kunde', 'Inaktiver Kunde']);
      assert.match(run.result!.errors.find((error) => error.profileName === 'Inaktiver Kunde')!.error, /nicht aktiv/);
      assert.match(run.result!.errors.find((error) => error.profileName === 'Gelöschter Kunde')!.error, /nicht gefunden/);

      assert.equal((await invoicesOf(owner.id)).length, 1, 'only the good profile produced an invoice');
      assert.equal((await invoicesOf(inactiveOwner.id)).length, 0);
      for (const body of [paused, future, forInactiveClient, forGhost]) {
        const profile = await profileOf(body.id);
        assert.deepEqual({ nextRun: profile.nextRun, lastRun: profile.lastRun }, { nextRun: body.nextRun, lastRun: undefined }, `${body.name} is untouched`);
      }
      assert.equal((await getSettings()).numbers.nextInvoiceNumber, counter + 1, 'failed profiles reserved no number');
    });

    test('a second run on the same day does not create the invoice again', async () => {
      const owner = await billingClient();
      const body = profileBody(owner.id, { name: 'Einmal täglich' });
      await saveProfile(body);
      assert.equal((await h.api.recurring.manualRun()).result!.generated, 1);
      const after = await profileOf(body.id);
      assert.deepEqual(await h.api.recurring.manualRun(), { success: true, result: { generated: 0, deactivated: 0, errors: [] } });
      assert.deepEqual(await h.api.recurring.manualRun(), { success: true, result: { generated: 0, deactivated: 0, errors: [] } });
      assert.equal((await invoicesOf(owner.id)).length, 1);
      assert.deepEqual(await profileOf(body.id), after, 'the profile did not move again');
    });

    test('a catch-up run bills each missed period once, dated today', async () => {
      const owner = await billingClient();
      // Two periods are due; after two runs the next one lies in the future, so later tests see no due profile.
      const start = addDays(today(), -45);
      const body = profileBody(owner.id, { name: 'Nachholen', nextRun: start });
      await saveProfile(body);
      await h.api.recurring.manualRun();
      const second = (await profileOf(body.id)).nextRun;
      await h.api.recurring.manualRun();
      assert.ok((await profileOf(body.id)).nextRun > today(), 'nothing is due any more');
      const periods = (await invoicesOf(owner.id)).map((invoice) => [invoice.date, invoice.servicePeriod]).sort();
      assert.deepEqual(periods, [[today(), `${start} bis ${monthEnd(start)}`], [today(), `${second} bis ${monthEnd(second)}`]].sort());
    });

    test('a Kleinunternehmer subscription carries no VAT even though the profile says standard', async () => {
      const owner = await billingClient();
      await asSmallBusiness(h.api, async () => {
        await saveProfile(profileBody(owner.id, { name: 'KU-Abo', taxMode: 'standard_vat', items: [{ kind: 'item', description: 'Wartung', quantity: 1, price: 100, total: 100, taxRate: 19 }] }));
        await h.api.recurring.manualRun();
      });
      const [invoice] = await invoicesOf(owner.id);
      assert.deepEqual({ mode: invoice!.taxMode, vat: invoice!.taxSnapshot!.vatAmount, amount: invoice!.amount }, { mode: 'small_business_19_ustg', vat: 0, amount: 100 });
    });

    test('two simultaneous runs claim a due profile exactly once', async () => {
      const owner = await billingClient();
      const body = profileBody(owner.id, { name: 'Gleichzeitig' });
      await saveProfile(body);
      const counter = (await getSettings()).numbers.nextInvoiceNumber;
      const runs = await Promise.all([h.api.recurring.manualRun(), h.api.recurring.manualRun(), h.api.recurring.manualRun()]);
      assert.deepEqual(runs.map((run) => run.success), [true, true, true]);
      assert.equal(runs.reduce((sum, run) => sum + (run.result?.generated ?? 0), 0), 1, 'one invoice for one due date');
      assert.equal((await invoicesOf(owner.id)).length, 1);
      const profile = await profileOf(body.id);
      assert.deepEqual({ lastRun: profile.lastRun, advanced: profile.nextRun > today() && profile.nextRun <= addDays(today(), 31) }, { lastRun: today(), advanced: true }, 'advanced by one interval only');
      assert.equal((await getSettings()).numbers.nextInvoiceNumber, counter + 1, 'one number used');
    });

    test('the Kleinunternehmer rule reaches generated invoices', async () => {
      const owner = await billingClient();
      await saveProfile(profileBody(owner.id, { name: 'Regelbesteuert' }));
      await h.api.recurring.manualRun();
      const [standard] = await invoicesOf(owner.id);
      assert.deepEqual({ mode: standard!.taxMode, amount: standard!.amount }, { mode: 'standard_vat', amount: 119 });

      await withSettings((settings) => ({ ...settings, legal: { ...settings.legal, smallBusinessRule: true } }), async () => {
        const small = await billingClient();
        await saveProfile(profileBody(small.id, { name: 'Klein' }));
        await h.api.recurring.manualRun();
        const [invoice] = await invoicesOf(small.id);
        assert.equal(invoice!.taxMode, 'small_business_19_ustg');
        assert.equal(invoice!.taxSnapshot!.vatAmount, 0);
        assert.equal(invoice!.amount, 100);
        assert.match(invoice!.taxSnapshot!.taxNotice ?? '', /§\s?19/);
      });
    });

    test('the tax mode stored on a profile is used for its invoices', async () => {
      const owner = await billingClient();
      const body = profileBody(owner.id, { name: 'Reverse Charge', taxMode: 'reverse_charge_13b', taxMeta: { buyerVatId: 'ATU12345678' } });
      assert.equal((await saveProfile(body)).status, 200);
      assert.equal((await profileOf(body.id)).taxMode, 'reverse_charge_13b');
      await h.api.recurring.manualRun();
      const [invoice] = await invoicesOf(owner.id);
      assert.equal(invoice!.taxMode, 'reverse_charge_13b');
      assert.equal(invoice!.taxSnapshot!.vatAmount, 0);
      assert.equal(invoice!.taxSnapshot!.einvoiceCategoryCode, 'AE');
    });

    test('a generated draft keeps its number when it is issued and is frozen from then on', async () => {
      const owner = await billingClient();
      await saveProfile(profileBody(owner.id, { name: 'Zum Stellen' }));
      await h.api.recurring.manualRun();
      const [draft] = await invoicesOf(owner.id);
      const issued = await h.api.invoices.upsert({ reason: 'Abo-Rechnung stellen', invoice: { ...draft!, status: 'open' } });
      assert.equal(issued.number, draft!.number, 'the reserved number is kept');
      assert.equal(issued.status, 'open');
      await assert.rejects(h.api.invoices.upsert({ reason: 'nachträglich ändern', invoice: { ...issued, items: [{ ...issued.items[0]!, price: 1, total: 1 }] } }), /unverändert/);
      const numbers = (await h.api.invoices.list()).map((invoice) => invoice.number);
      assert.equal(new Set(numbers).size, numbers.length, 'no number is used twice');
    });

    test('deleting a profile leaves the invoices it generated', async () => {
      const owner = await billingClient();
      const body = profileBody(owner.id, { name: 'Wird gelöscht' });
      await saveProfile(body);
      await h.api.recurring.manualRun();
      await h.api.recurring.delete({ id: body.id });
      assert.equal((await invoicesOf(owner.id)).length, 1);
      assert.deepEqual(await h.api.recurring.manualRun(), { success: true, result: { generated: 0, deactivated: 0, errors: [] } });
    });

    test('every generated invoice is audited', async () => {
      const owner = await billingClient();
      await saveProfile(profileBody(owner.id, { name: 'Nachvollziehbar' }));
      await h.api.recurring.manualRun();
      const [invoice] = await invoicesOf(owner.id);
      const rows = (await auditRows()).filter((row) => row[3] === invoice!.id);
      assert.deepEqual(rows.map((row) => row[4]), ['invoice.create']);
    });
  });

  describe('dunning', () => {
    const overdueInvoice = (daysOverdue: number, clientName: string) => issueInvoice(h.api, {
      client: clientName, clientEmail: `${clientName.replace(/\W+/g, '').toLowerCase()}@example.com`,
      date: addDays(today(), -(daysOverdue + 14)), dueDate: addDays(today(), -daysOverdue),
    });
    const statusOf = (invoiceId: string) => h.api.dunning.getInvoiceStatus({ invoiceId });
    const invoiceOf = async (invoiceId: string) => (await h.api.invoices.list()).find((invoice) => invoice.id === invoiceId)!;
    const deliveries = async () => (await h.raw('GET', '/dunning/deliveries')).body as Array<{ id: string; invoiceId: string; invoiceNumber: string; level: number; state: string }>;
    const mailsTo = (address: string) => sink.messages.map(mailText).filter((message) => message.includes(`<${address}>`));

    /** Every test starts without overdue invoices: settle what earlier tests left open. */
    afterEach(async () => {
      sink.state.reject = false;
      const documents = await h.api.invoices.list();
      for (const invoice of documents) {
        const receivable = ['invoice', 'advance_invoice', 'partial_invoice', 'final_invoice'].includes(invoice.documentKind ?? 'invoice');
        if (receivable && ['open', 'overdue'].includes(invoice.status)) {
          // Pay exactly what is open: a manual payment above that is refused (it would be a credit, not a settlement).
          const credited = documents.filter((doc) => doc.documentKind === 'credit_note' && doc.sourceDocumentId === invoice.id && doc.status !== 'draft').reduce((sum, doc) => sum + Math.abs(doc.amount), 0);
          const open = Math.round((invoice.amount - credited - invoice.payments.reduce((sum, payment) => sum + payment.amount, 0)) * 100) / 100;
          if (open > 0) await h.api.invoices.savePayment({ invoiceId: invoice.id, payment: { id: randomUUID(), date: today(), amount: open, method: 'bank' }, reason: 'Aufräumen' }).catch(() => undefined);
        }
      }
    });

    test('a run explains itself when automation, levels or the mail provider are missing and touches nothing', async () => {
      const invoice = await overdueInvoice(20, 'Ohne Konfiguration');
      const messagesBefore = sink.messages.length;
      const untouched = async () => {
        assert.equal(sink.messages.length, messagesBefore, 'no mail left');
        const stored = await invoiceOf(invoice.id);
        assert.deepEqual({ amount: stored.amount, level: stored.dunningLevel ?? 0 }, { amount: invoice.amount, level: 0 });
        assert.deepEqual((await statusOf(invoice.id)).history, []);
      };

      const disabled = await h.api.dunning.manualRun();
      assert.equal(disabled.success, false);
      assert.match(disabled.error!, /not enabled/i, 'automation switched off');
      await untouched();

      await withSettings((settings) => ({ ...smtp(settings), automation: { ...settings.automation, dunningEnabled: true }, dunning: { levels: [] } }), async () => {
        const noLevels = await h.api.dunning.manualRun();
        assert.equal(noLevels.success, false);
        assert.match(noLevels.error!, /levels/i);
        await untouched();
      });

      await withSettings((settings) => ({ ...settings, automation: { ...settings.automation, dunningEnabled: true }, dunning: { levels: [level(1, 7, 0)] } }), async () => {
        const noProvider = await h.api.dunning.manualRun();
        assert.equal(noProvider.success, false);
        assert.match(noProvider.error!, /provider/i);
        await untouched();
      });

      await withSettings(dunningSetup([level(1, 7, 0)]), async () => {
        delete process.env.SMTP_PASSWORD;
        try {
          const noPassword = await h.api.dunning.manualRun();
          assert.equal(noPassword.success, false);
          assert.match(noPassword.error!, /password/i);
          await untouched();
        } finally {
          process.env.SMTP_PASSWORD = 'integration-secret';
        }
      });
    });

    test('overdue invoices are dunned at the level their age reaches, with fee, mail and history; nothing else is touched', async () => {
      const ids = {
        notYet: await overdueInvoice(3, 'Noch nicht'),
        level1: await overdueInvoice(8, 'Stufe Eins'),
        level2: await overdueInvoice(15, 'Stufe Zwei'),
        level3: await overdueInvoice(22, 'Stufe Drei'),
        dueToday: await overdueInvoice(0, 'Heute fällig'),
        paid: await overdueInvoice(30, 'Bezahlt'),
        draft: await draftInvoice(h.api, { client: 'Entwurf', date: addDays(today(), -44), dueDate: addDays(today(), -30) }),
      };
      await h.api.invoices.savePayment({ invoiceId: ids.paid.id, payment: { id: randomUUID(), date: today(), amount: ids.paid.amount, method: 'bank' }, reason: 'bezahlt' });
      await h.api.invoices.savePayment({ invoiceId: ids.level3.id, payment: { id: randomUUID(), date: today(), amount: 50, method: 'bank' }, reason: 'Teilzahlung' });
      const source = await issueInvoice(h.api, { client: 'Gutschrift-Quelle', dueDate: addDays(today(), 30) });
      const creditNote = await h.api.documents.chainIssue({ operation: 'correction', id: randomUUID(), invoiceId: source.id, kind: 'credit_note', amount: 10, date: addDays(today(), -44), dueDate: addDays(today(), -30), reason: 'Teilgutschrift' } as never);

      const detailed = 'Invoice %N for %K due %D amount %A is %T days late, fee %F.';
      await withSettings(dunningSetup([level(1, 7, 0, detailed), level(2, 14, 5), level(3, 21, 10)]), async () => {
        const messagesBefore = sink.messages.length;
        const run = await h.api.dunning.manualRun();
        assert.deepEqual(run, { success: true, result: { processedInvoices: 3, emailsSent: 3, feesApplied: charged(15), errors: [] } });

        for (const [key, expectedLevel, fee, days] of [['level1', 1, 0, 8], ['level2', 2, 5, 15], ['level3', 3, 10, 22]] as const) {
          const original = ids[key];
          const status = await statusOf(original.id);
          assert.equal(status.currentLevel, expectedLevel, key);
          assert.equal(status.totalFeesApplied, charged(fee), key);
          assert.equal(status.daysOverdue, days, key);
          assert.ok(Date.now() - Date.parse(status.lastReminderSent ?? '') < 120_000, `${key}: the reminder is stamped now`);
          assert.deepEqual(status.history.map((entry) => [entry.dunningLevel, entry.feeApplied, entry.emailSent, entry.daysOverdue]), [[expectedLevel, charged(fee), true, days]], key);

          const stored = await invoiceOf(original.id);
          assert.equal(stored.amount, original.amount, `${key}: the fee is the customer's own debt, the issued invoice is unchanged`);
          assert.equal(stored.dunningLevel, expectedLevel, key);
          assert.equal(stored.taxSnapshot!.grossAmount, original.taxSnapshot!.grossAmount, `${key}: the VAT snapshot of the invoice is not touched`);
          assert.ok(stored.history!.some((entry) => /Mahnstufe|dunning/i.test(entry.action)), `${key}: the reminder shows in the document history`);

          const mails = mailsTo(`${original.client.replace(/\W+/g, '').toLowerCase()}@example.com`);
          assert.equal(mails.length, 1, `${key}: exactly one mail`);
          assert.match(mails[0]!, new RegExp(`Subject: Level ${expectedLevel} ${original.number}`));
          const expectedText = expectedLevel === 1
            ? `Invoice ${original.number} for ${original.client} due ${new Date(original.dueDate).toLocaleDateString('de-DE')} amount ${original.amount.toFixed(2)} is ${days} days late, fee ${fee.toFixed(2)}.`
            : `Invoice ${original.number} for ${original.client} is ${days} days late, fee ${fee.toFixed(2)}.`;
          assert.ok(mails[0]!.includes(expectedText), `${key}: placeholders %N %K %D %A %T %F are replaced in the mail text`);
        }
        assert.equal(sink.messages.length, messagesBefore + 3);
        assert.equal((await invoiceOf(ids.level3.id)).payments.length, 1, 'the partial payment is untouched');

        for (const [key, untouched] of Object.entries({ notYet: ids.notYet, dueToday: ids.dueToday, paid: ids.paid, draft: ids.draft, creditNote })) {
          const status = await statusOf(untouched.id);
          assert.deepEqual({ level: status.currentLevel, history: status.history }, { level: 0, history: [] }, `${key} is not dunned`);
          assert.equal((await invoiceOf(untouched.id)).amount, untouched.amount, `${key} keeps its amount`);
        }
        assert.deepEqual(sink.messages.slice(messagesBefore).map(mailText).filter((message) => /noch ?nicht|heute|bezahlt|entwurf/i.test(message)), [], 'no mail for them');

        const reminders = (await auditRows()).filter((row) => row[4] === 'invoice.dunning_reminder_sent').map((row) => row[3]);
        assert.deepEqual([...reminders].sort(), [ids.level1.id, ids.level2.id, ids.level3.id].sort());
        assert.equal((await h.api.audit.verify()).ok, true);
      });
    });

    if (product === 'pro') test('the dunning fee is recorded for a posted invoice too', async () => {
      const invoice = await overdueInvoice(15, 'Gebuehr Pro');
      await withSettings(dunningSetup([level(1, 7, 0), level(2, 14, 5)]), async () => {
        await h.api.dunning.manualRun();
        assert.equal((await statusOf(invoice.id)).totalFeesApplied, 5);
      });
    });

    test('the reminder demands the open balance: %A subtracts payments and issued credit notes, the invoice keeps its amount', async () => {
      const invoice = await overdueInvoice(10, 'Teilweise beglichen');
      await h.api.invoices.savePayment({ invoiceId: invoice.id, payment: { id: randomUUID(), date: today(), amount: 38, method: 'bank' }, reason: 'Teilzahlung' });
      await h.api.documents.chainIssue({ operation: 'correction', id: randomUUID(), invoiceId: invoice.id, kind: 'credit_note', amount: 50, date: today(), dueDate: today(), reason: 'Teilgutschrift' } as never);
      await withSettings(dunningSetup([level(1, 7, 4, 'Offen sind noch %A EUR zzgl. %F EUR Gebühr.')]), async () => {
        await h.api.dunning.manualRun();
        const [mail] = mailsTo('teilweisebeglichen@example.com');
        assert.ok(mail?.includes(`Offen sind noch ${(invoice.amount - 38 - 50).toFixed(2)} EUR zzgl. 4.00 EUR Geb`), mail);
        assert.equal((await statusOf(invoice.id)).totalFeesApplied, 4);
        assert.equal((await invoiceOf(invoice.id)).amount, invoice.amount);
      });
    });

    test('an invoice settled by a Stornorechnung or a full credit note is not dunned', async () => {
      const cancelled = await overdueInvoice(20, 'Storniert');
      const credited = await overdueInvoice(20, 'Gutgeschrieben');
      const stillOpen = await overdueInvoice(20, 'Noch offen');
      await h.api.documents.chainIssue({ operation: 'correction', id: randomUUID(), invoiceId: cancelled.id, kind: 'cancellation_invoice', date: today(), dueDate: today(), reason: 'Storno' } as never);
      await h.api.documents.chainIssue({ operation: 'correction', id: randomUUID(), invoiceId: credited.id, kind: 'credit_note', amount: credited.amount, date: today(), dueDate: today(), reason: 'volle Gutschrift' } as never);
      await withSettings(dunningSetup([level(1, 7, 0)]), async () => {
        const run = await h.api.dunning.manualRun();
        assert.deepEqual(run.result, { processedInvoices: 1, emailsSent: 1, feesApplied: 0, errors: [] });
        assert.equal(mailsTo('storniert@example.com').length, 0, 'no reminder for a cancelled invoice');
        assert.equal(mailsTo('gutgeschrieben@example.com').length, 0, 'no reminder for a fully credited invoice');
        assert.equal(mailsTo('nochoffen@example.com').length, 1);
        assert.equal((await statusOf(stillOpen.id)).currentLevel, 1);
      });
    });

    test('running twice on the same day neither mails nor charges twice; a later level adds its own fee', async () => {
      const invoice = await overdueInvoice(8, 'Eskalation');
      await withSettings(dunningSetup([level(1, 7, 0), level(2, 14, 5)]), async () => {
        const messagesBefore = sink.messages.length;
        assert.deepEqual((await h.api.dunning.manualRun()).result, { processedInvoices: 1, emailsSent: 1, feesApplied: 0, errors: [] });
        assert.ok(Date.now() - Date.parse((await getSettings()).automation.lastDunningRun ?? '') < 120_000, 'the run is recorded');
        for (let again = 0; again < 2; again += 1) {
          assert.deepEqual((await h.api.dunning.manualRun()).result, { processedInvoices: 0, emailsSent: 0, feesApplied: 0, errors: [] }, 'nothing left to do at level 1');
        }
        assert.equal(sink.messages.length, messagesBefore + 1);
        assert.equal((await statusOf(invoice.id)).currentLevel, 1);

        // Time passes: level 2 now applies to the same invoice.
        await setSettings({ ...(await getSettings()), dunning: { levels: [level(1, 7, 0), level(2, 8, 5)] } });
        assert.deepEqual((await h.api.dunning.manualRun()).result, { processedInvoices: 1, emailsSent: 1, feesApplied: charged(5), errors: [] });
        assert.deepEqual((await h.api.dunning.manualRun()).result, { processedInvoices: 0, emailsSent: 0, feesApplied: 0, errors: [] });
        assert.equal(sink.messages.length, messagesBefore + 2);

        const status = await statusOf(invoice.id);
        assert.equal(status.currentLevel, 2);
        assert.equal(status.totalFeesApplied, charged(5));
        assert.deepEqual(status.history.map((entry) => [entry.dunningLevel, entry.feeApplied]).sort(), [[1, 0], [2, charged(5)]]);
        assert.equal((await invoiceOf(invoice.id)).amount, invoice.amount, 'the invoice amount never carries the fee');
      });
    });

    test('the §288 Abs. 5 Pauschale replaces the fee for a business customer, credited against fees charged before', async () => {
      const business = await issueInvoice(h.api, {
        client: 'Pauschale GmbH', clientEmail: 'pauschalegmbh@example.com', date: addDays(today(), -22), dueDate: addDays(today(), -8),
        taxMeta: { buyerType: 'business' } as never,
      });
      const consumer = await overdueInvoice(8, 'Privatkunde');
      const levels = (second: number) => [level(1, 7, 5), { ...level(2, second, 5), chargeFlatFee: true }];
      await withSettings(dunningSetup(levels(14)), async () => {
        await h.api.dunning.manualRun();
        await setSettings({ ...(await getSettings()), dunning: { levels: levels(8) } });
        await h.api.dunning.manualRun();
        const fees = async (id: string) => (await statusOf(id)).history.map((entry) => [entry.dunningLevel, entry.feeApplied]).sort();
        assert.deepEqual(await fees(business.id), [[1, 5], [2, 35]], 'business: 40 € in total, the earlier 5 € credited');
        assert.deepEqual(await fees(consumer.id), [[1, 5], [2, 5]], 'a consumer owes no Pauschale');
        assert.equal((await invoiceOf(business.id)).amount, business.amount);
      });
    });

    test('an unknown invoice has no dunning status; a fresh one has none either', async () => {
      assert.equal((await h.raw('GET', `/dunning/invoices/${randomUUID()}/status`)).status, 404);
      const fresh = await issueInvoice(h.api, { client: `Frisch ${uid()}` });
      assert.deepEqual(await statusOf(fresh.id), { currentLevel: 0, daysOverdue: 0, totalFeesApplied: 0, history: [] });
      const late = await overdueInvoice(12, `Spät ${uid()}`);
      const lateStatus = await statusOf(late.id);
      assert.deepEqual({ level: lateStatus.currentLevel, days: lateStatus.daysOverdue, history: lateStatus.history }, { level: 0, days: 12, history: [] }, 'overdue but not yet dunned');
    });

    test('a rejected mail is not recorded as sent, charges no fee and can be reconciled', async () => {
      const refused = await overdueInvoice(9, 'Abgelehnt');
      const confirmed = await overdueInvoice(9, 'Bestätigt');
      await withSettings(dunningSetup([level(1, 7, 3)]), async () => {
        sink.state.reject = true;
        const messagesBefore = sink.messages.length;
        const failed = await h.api.dunning.manualRun();
        assert.equal(failed.success, true);
        assert.equal(failed.result!.emailsSent, 0);
        assert.equal(failed.result!.feesApplied, 0);
        assert.deepEqual(failed.result!.errors.map((error) => error.invoiceNumber).sort(), [refused.number, confirmed.number].sort());
        assert.equal(sink.messages.length, messagesBefore, 'the provider took no mail');
        for (const invoice of [refused, confirmed]) {
          const status = await statusOf(invoice.id);
          assert.equal(status.currentLevel, 0, 'no level was recorded');
          assert.ok(!status.history.some((entry) => entry.emailSent), 'no history entry claims the mail was sent');
          assert.equal((await invoiceOf(invoice.id)).amount, invoice.amount, 'no fee for a mail that was not accepted');
        }

        sink.state.reject = false;
        const stuck = await deliveries();
        assert.deepEqual(stuck.map((entry) => entry.invoiceId).sort(), [refused.id, confirmed.id].sort(), 'both deliveries wait for a decision');
        assert.ok(stuck.every((entry) => entry.state === 'unknown' && entry.level === 1));
        const again = await h.api.dunning.manualRun();
        assert.equal(again.result!.emailsSent, 0, 'an unclear delivery is never sent blindly a second time');
        assert.equal(sink.messages.length, messagesBefore);

        const refusedDelivery = stuck.find((entry) => entry.invoiceId === refused.id)!;
        const confirmedDelivery = stuck.find((entry) => entry.invoiceId === confirmed.id)!;
        assert.equal((await h.raw('POST', '/dunning/deliveries/resolve', { id: refusedDelivery.id, accepted: false })).status, 400, 'a decision needs a reason');
        assert.equal((await h.raw('POST', '/dunning/deliveries/resolve', { id: randomUUID(), accepted: false, reason: 'x' })).status, 409, 'unknown delivery');

        // The provider never got the mail: reconcile as "not accepted", the next run sends it.
        assert.equal((await h.raw('POST', '/dunning/deliveries/resolve', { id: refusedDelivery.id, accepted: false, reason: 'Beim Anbieter nicht gefunden' })).status, 200);
        assert.equal((await h.raw('POST', '/dunning/deliveries/resolve', { id: refusedDelivery.id, accepted: false, reason: 'noch einmal' })).status, 409, 'a delivery is reconciled once');
        // The provider did take the mail after all: reconcile as "accepted", fee and level are recorded without a second mail.
        assert.equal((await h.raw('POST', '/dunning/deliveries/resolve', { id: confirmedDelivery.id, accepted: true, reason: 'Beim Anbieter bestätigt' })).status, 200);
        const confirmedStatus = await statusOf(confirmed.id);
        assert.deepEqual({ level: confirmedStatus.currentLevel, fee: confirmedStatus.totalFeesApplied }, { level: 1, fee: charged(3) });
        assert.equal((await invoiceOf(confirmed.id)).amount, confirmed.amount);

        const retry = await h.api.dunning.manualRun();
        assert.equal(retry.result!.emailsSent, 1, 'only the refused invoice is mailed');
        assert.equal(sink.messages.length, messagesBefore + 1);
        assert.match(mailText(sink.messages.at(-1)!), new RegExp(`Subject: Level 1 ${refused.number}`));
        const refusedStatus = await statusOf(refused.id);
        assert.deepEqual({ level: refusedStatus.currentLevel, fee: refusedStatus.totalFeesApplied }, { level: 1, fee: charged(3) });
        assert.equal((await invoiceOf(refused.id)).amount, refused.amount, 'the fee lives in the history, not in the invoice');
        assert.deepEqual(await deliveries(), [], 'nothing is waiting any more');

        const reviewed = (await auditRows()).filter((row) => row[4] === 'invoice.dunning_delivery_reviewed' && row[3] === refused.id);
        assert.equal(reviewed.length, 1);
        assert.match(reviewed[0]![5]!, /nicht gefunden/);
      });
    });
  });

  describe('e-mail outbox', () => {
    const request = async (overrides: Record<string, unknown> = {}) => ({
      documentType: 'invoice' as const,
      documentId: (await issueInvoice(h.api, { client: `Mail ${uid()}` })).id,
      recipientEmail: 'kunde@example.com',
      recipientName: 'Kunde',
      subject: `Rechnung ${uid()}`,
      bodyText: 'Anbei Ihre Rechnung.',
      ...overrides,
    });

    test('without a mail provider email:send says so instead of reporting success', async () => {
      const sent = await h.api.email.send(await request());
      assert.equal(sent.success, false);
      assert.match(sent.error!, /Anbieter/);
      assert.equal(sent.messageId, undefined);
      const again = await h.api.email.send(await request());
      assert.equal(again.success, false, 'every attempt fails the same way');
      const queued = (await auditRows()).filter((row) => row[4] === 'email.queued');
      assert.equal(queued.length, 0, 'nothing was queued');
    });

    test('with a provider the mail is queued once per identical request, and bad requests are refused', async () => {
      await withSettings(smtp, async () => {
        const payload = await request();
        const queued = await h.api.email.send(payload);
        assert.equal(queued.success, true);
        assert.ok(queued.messageId, 'the queue entry id is returned');
        const repeated = await h.api.email.send(payload);
        assert.equal(repeated.messageId, queued.messageId, 'an identical request is queued once');
        const other = await h.api.email.send({ ...payload, subject: `${payload.subject} (neu)` });
        assert.notEqual(other.messageId, queued.messageId);
        assert.ok((await auditRows()).some((row) => row[4] === 'email.queued' && row[3] === payload.documentId));

        assert.equal((await h.raw('POST', '/email/send', { ...payload, documentId: randomUUID() })).status, 404, 'unknown document');
        assert.equal((await h.raw('POST', '/email/send', { ...payload, documentType: 'offer' })).status, 404, 'an invoice id is not an offer');
        for (const [label, patch] of [['bad recipient', { recipientEmail: 'kein-mail' }], ['empty subject', { subject: '' }], ['empty body', { bodyText: '' }], ['no recipient name', { recipientName: '' }], ['unknown type', { documentType: 'receipt' }]] as const) {
          const response = await h.raw('POST', '/email/send', { ...payload, ...patch });
          assert.equal(response.status, 400, `${label}: ${response.text}`);
        }

        delete process.env.SMTP_PASSWORD;
        try {
          const noPassword = await h.api.email.send(await request());
          assert.equal(noPassword.success, false);
          assert.match(noPassword.error!, /Passwort/);
        } finally {
          process.env.SMTP_PASSWORD = 'integration-secret';
        }
      });
    });

    test('the provider configuration can be tested without sending a mail', async () => {
      const smtpConfig = { provider: 'smtp' as const, smtpHost: '127.0.0.1', smtpPort: sink.port, smtpSecure: false, smtpUser: 'integration' };
      const messagesBefore = sink.messages.length;
      assert.deepEqual(await h.api.email.testConfig(smtpConfig), { success: true });
      assert.equal(sink.messages.length, messagesBefore, 'a connection test sends nothing');

      const unreachable = await h.api.email.testConfig({ ...smtpConfig, smtpPort: 1 });
      assert.equal(unreachable.success, false);
      assert.ok(unreachable.error);

      delete process.env.SMTP_PASSWORD;
      try {
        const noPassword = await h.api.email.testConfig(smtpConfig);
        assert.equal(noPassword.success, false);
        assert.match(noPassword.error!, /Passwort/);
      } finally {
        process.env.SMTP_PASSWORD = 'integration-secret';
      }
      const resend = await h.api.email.testConfig({ provider: 'resend' });
      assert.equal(resend.success, false);
      assert.match(resend.error!, /Resend/);
    });
  });

  describe('backup and restore', () => {
    // db:backup / db:restore are native IPC routes; this drives the backend functions behind them (dumpDataDir / restoreDataDir).
    test('the database archive restores the data as it was; a corrupt archive changes nothing', async (t) => {
      const folder = await mkdtemp(join(tmpdir(), 'billme-it-backup-'));
      t.after(() => rm(folder, { recursive: true, force: true }));
      const keeper = await makeClient({ company: `Vor dem Backup ${uid()}` });
      const invoice = await issueInvoice(h.api, { client: keeper.company, clientId: keeper.id });
      const archivePath = join(folder, 'billme.pglite.tar');
      await writeFile(archivePath, Buffer.from(await (await h.backend.dumpDataDir()).arrayBuffer()));
      const clientsAtBackup = (await h.api.clients.list()).map((client) => client.id).sort();
      const auditAtBackup = await h.api.audit.verify();
      assert.ok((await readFile(archivePath)).length > 1024, 'the archive holds the database');

      // A corrupt archive is refused and the running database is unaffected (the server is restarted behind the scenes).
      const garbagePath = join(folder, 'garbage.pglite.tar');
      await writeFile(garbagePath, 'das ist kein Datenbank-Archiv');
      // PGlite's WASM runtime sets process.exitCode when it aborts on a corrupt archive; that must not fail this test run.
      const exitCode = process.exitCode;
      await assert.rejects(h.backend.restoreDataDir(garbagePath));
      process.exitCode = exitCode;
      const connection = h.backend.embeddedConnection()!;
      assert.ok(connection, 'the backend is available again after the refused restore');
      const api = product === 'lite'
        ? createLiteHttpBillmeApi({ baseUrl: connection.baseUrl, auth: { mode: 'embedded', token: connection.token } })
        : createProHttpBillmeApi({ baseUrl: connection.baseUrl, embeddedConnectionResolver: async () => connection }) as unknown as ReturnType<typeof createLiteHttpBillmeApi>;
      assert.deepEqual((await api.clients.list()).map((client) => client.id).sort(), clientsAtBackup);
      assert.equal((await api.audit.verify()).ok, true);

      // Changes after the backup...
      const later = await api.clients.upsert({ client: newClient({ company: `Nach dem Backup ${uid()}` }) as never });
      await api.invoices.savePayment({ invoiceId: invoice.id, payment: { id: randomUUID(), date: today(), amount: invoice.amount, method: 'bank' }, reason: 'nach dem Backup bezahlt' });
      assert.equal((await api.invoices.list()).find((candidate) => candidate.id === invoice.id)!.status, 'paid');

      // ...are gone after the restore.
      const restored = await h.backend.restoreDataDir(archivePath);
      assert.equal(restored.ok, true);
      assert.equal(restored.verification.ok, true);
      assert.equal(h.backend.embeddedConnection(), null, 'the restored data is only served after a restart');
      const userDataPath = h.userDataPath;
      await h.close({ keepData: true });

      // The restore stops the backend for good (the app relaunches). Carry on with the restarted one so the suite still has a live backend.
      h = await startProduct(product, null, 'automation-restore', userDataPath);
      const reopened = h;
      assert.deepEqual((await reopened.api.clients.list()).map((client) => client.id).sort(), clientsAtBackup);
      assert.ok(!(await reopened.api.clients.list()).some((client) => client.id === later.id), 'a change after the backup is gone');
      const back = (await reopened.api.invoices.list()).find((candidate) => candidate.id === invoice.id)!;
      assert.deepEqual({ status: back.status, payments: back.payments.length, number: back.number }, { status: 'open', payments: 0, number: invoice.number });
      const verification = await reopened.api.audit.verify();
      assert.equal(verification.ok, true);
      assert.equal(verification.count, auditAtBackup.count);
      assert.equal(verification.headHash, auditAtBackup.headHash, 'the hash chain is exactly the one that was backed up');
      assert.equal((await readFile(archivePath)).length > 1024, true, 'the archive is kept');
    });
  });
});

for (const product of PRODUCTS) test(`recurring progress, dunning history and last-run markers survive an app restart and are not repeated (${product})`, async (t) => {
  process.env.SMTP_PASSWORD = 'integration-secret';
  const sink = await startSmtpSink();
  t.after(async () => { await sink.close(); delete process.env.SMTP_PASSWORD; });
  const first = await startProduct(product, null, 'automation-restart');
  const settings = (await first.api.settings.get())!;
  await first.api.settings.set({ settings: {
    ...settings,
    email: { ...settings.email, provider: 'smtp', smtpHost: '127.0.0.1', smtpPort: sink.port, smtpSecure: false, smtpUser: 'integration', fromName: 'Holzwerk', fromEmail: 'buero@holzwerk.test' },
    dunning: { levels: [level(1, 7, 4)] },
    automation: { ...settings.automation, dunningEnabled: true },
  } });
  const owner = await first.api.clients.upsert({ client: newClient({ company: 'Neustart Abo GmbH' }) as never });
  const profileId = randomUUID();
  await first.raw('POST', '/recurring', { reason: 'Abo', profile: { id: profileId, clientId: owner.id, active: true, name: 'Neustart-Abo', interval: 'monthly', nextRun: today(), amount: 100, items: [{ kind: 'item', description: 'Wartung', quantity: 1, price: 100, total: 100 }] } });
  const late = await issueInvoice(first.api, { client: 'Neustart Mahnung', clientEmail: 'neustart@example.com', date: addDays(today(), -30), dueDate: addDays(today(), -10) });
  assert.equal((await first.api.recurring.manualRun()).result!.generated, 1);
  assert.equal((await first.api.dunning.manualRun()).result!.emailsSent, 1);
  const profileBefore = (await first.raw('GET', '/recurring')).body.find((profile: { id: string }) => profile.id === profileId);
  const statusBefore = await first.api.dunning.getInvoiceStatus({ invoiceId: late.id });
  const settingsBefore = (await first.api.settings.get())!;
  const invoicesBefore = (await first.api.invoices.list()).length;
  await first.close({ keepData: true });

  const second = await startProduct(product, t, 'automation-restart', first.userDataPath);
  const profileAfter = (await second.raw('GET', '/recurring')).body.find((profile: { id: string }) => profile.id === profileId);
  assert.deepEqual(profileAfter, profileBefore, 'the profile kept its progress');
  assert.deepEqual({ lastRun: profileAfter.lastRun, active: profileAfter.active }, { lastRun: today(), active: true });
  assert.deepEqual(await second.api.dunning.getInvoiceStatus({ invoiceId: late.id }), statusBefore, 'the dunning history is intact');
  assert.equal((await second.api.settings.get())!.automation.lastDunningRun, settingsBefore.automation.lastDunningRun);

  assert.deepEqual(await second.api.recurring.manualRun(), { success: true, result: { generated: 0, deactivated: 0, errors: [] } }, 'the profile does not run again');
  assert.deepEqual((await second.api.dunning.manualRun()).result, { processedInvoices: 0, emailsSent: 0, feesApplied: 0, errors: [] }, 'the level is not mailed again');
  assert.equal(sink.messages.length, 1);
  assert.equal((await second.api.invoices.list()).length, invoicesBefore);
  assert.equal((await second.api.invoices.list()).find((invoice) => invoice.id === late.id)!.amount, late.amount, 'the invoice amount never carries the fee');
  assert.equal((await second.api.audit.verify()).ok, true);
});
