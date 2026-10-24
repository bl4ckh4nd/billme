import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { BillmeApi } from '@billme/desktop-contracts/api';
import { createDefaultTemplateBody, resolveInvoiceTaxMode } from '@billme/server-core';
import { mapArticleCsv, mapClientCsv, parseGermanNumber, readMasterdataCsv } from '@billme/desktop-services/masterdataCsv';
import { PRODUCTS, startProduct, type LiteHarness } from './harness.js';
import { addDays, datevEvidence, draftInvoice, draftOffer, ISSUER, issueInvoice, newClient, today } from './fixtures.js';

/**
 * Master data, settings, document templates and the audit log, end to end
 * through the Lite desktop backend.
 *
 * How this can fail (each one has a test below):
 * - customer numbers: duplicates, gaps or reuse after a delete, a manual number
 *   not skipped by the sequence, the prefix/length/year format ignored, an
 *   update that drops the assigned number, manual numbers stored untrimmed
 * - clients: addresses/e-mails/tax profile (VAT ID) lost on save, the wrong
 *   default address or e-mail taken for a new document, invalid payloads
 *   accepted, a client delete that damages the invoices written for it
 * - contact persons: the list lost on save or restart, two primary contacts
 *   accepted, none primary left without a primary, the legacy contactPerson
 *   not following the primary contact, invalid contacts (no name, bad e-mail,
 *   more than 20) accepted
 * - CSV import: German/English headers or the ";" delimiter and BOM not read,
 *   "1.234,56" misread, an invalid row saved, an existing customer number, the
 *   same name+PLZ or an existing SKU/title imported twice, blank customer
 *   numbers not assigned by the server, the import reason missing in the audit
 * - projects: code collisions, budget/date fields lost, archived projects still
 *   listed, a project moved between clients duplicated, no audit entry
 * - articles: VAT rate/unit lost, garbage (VAT 190 %, no title) accepted
 * - settings: defaults wrong, invalid values (bad IBAN, VAT outside 0-100 %,
 *   nonsense numbering) accepted or half-saved, a number format change touching
 *   numbers already issued, a lowered counter handing out a used number,
 *   the Kleinunternehmer rule not reaching new documents or altering issued
 *   ones, changes missing from the audit log
 * - templates: no new version per save, two defaults per kind, a template of
 *   another kind used for a document, a draft not following template/company
 *   changes, an issued invoice changing its look or sender after the fact,
 *   a forged layout snapshot accepted, dunning letters built from the wrong
 *   level, fee or template
 * - audit: broken hash chain, CSV columns changed, missing reason/actor
 * - access: master data readable without the local token
 * - persistence: any of the above gone after the app restarts
 */

type Settings = NonNullable<Awaited<ReturnType<BillmeApi['settings']['get']>>>;
type TemplateBody = ReturnType<typeof createDefaultTemplateBody>;

const uid = () => randomUUID().slice(0, 8);
const year = new Date().getFullYear();
const sequenceOf = (number: string): number => Number(number.replace(/\D+$/, '').match(/(\d+)$/)![1]);
const pad = (value: number, length: number) => String(value).padStart(length, '0');

/** Minimal RFC 4180 reader for the audit export (quoted cells, doubled quotes, UTF-8 BOM). */
const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
};

const AUDIT_COLUMNS = ['sequence', 'ts', 'entity_type', 'entity_id', 'action', 'reason', 'prev_hash', 'hash', 'actor', 'before_json', 'after_json'];

for (const product of PRODUCTS) describe(`masterdata (${product})`, () => {
  let h: LiteHarness;
  before(async () => { h = await startProduct(product, null, 'masterdata'); });
  after(async () => { await h.close(); });

  const makeClient = (overrides: Record<string, unknown> = {}) => h.api.clients.upsert({ client: newClient(overrides) as never });
  const clientById = async (id: string) => (await h.api.clients.list()).find((client) => client.id === id);
  const getSettings = async (): Promise<Settings> => (await h.api.settings.get())!;
  const setSettings = (settings: Settings) => h.api.settings.set({ settings });

  /**
   * Settings are global to the backend, so a test that changes a section puts it
   * back afterwards. Number counters keep moving on purpose and are never rolled
   * back; only the formats are restored.
   */
  const withSettings = async (patch: (settings: Settings) => Settings, run: () => Promise<void>) => {
    const original = await getSettings();
    await setSettings(patch(structuredClone(original)));
    try {
      await run();
    } finally {
      const latest = await getSettings();
      const restored: Settings = { ...original, numbers: { ...latest.numbers, invoicePrefix: original.numbers.invoicePrefix, offerPrefix: original.numbers.offerPrefix, numberLength: original.numbers.numberLength, customerPrefix: original.numbers.customerPrefix, customerNumberLength: original.numbers.customerNumberLength } };
      await setSettings(restored);
    }
  };

  /** Posts every case to PUT /settings and reports the ones the server took, restoring the stored settings afterwards. */
  const acceptedSettings = async (cases: Array<[string, (settings: Settings) => Settings]>): Promise<string[]> => {
    const original = await getSettings();
    const accepted: string[] = [];
    try {
      for (const [label, patch] of cases) {
        const response = await h.raw('PUT', '/settings', { settings: patch(structuredClone(original)) });
        if (response.status === 200) accepted.push(label);
        else assert.equal(response.status, 400, `${label}: ${response.text}`);
      }
    } finally {
      await setSettings(original);
    }
    return accepted;
  };

  describe('settings', () => {
    test('a fresh install starts with the documented defaults', async () => {
      const s = await getSettings();
      assert.deepEqual(
        { ...s.numbers },
        { invoicePrefix: 'RE-%Y-', nextInvoiceNumber: 1, numberLength: 3, offerPrefix: 'ANG-%Y-', nextOfferNumber: 1, customerPrefix: 'KD-', nextCustomerNumber: 1, customerNumberLength: 4, orderConfirmationPrefix: 'AB-%Y-', nextOrderConfirmationNumber: 1, deliveryNotePrefix: 'LS-%Y-', nextDeliveryNoteNumber: 1 },
      );
      assert.equal(s.legal.smallBusinessRule, false);
      assert.equal(s.legal.defaultVatRate, 19);
      assert.equal(s.legal.paymentTermsDays, 14);
      assert.equal(s.legal.taxAccountingMethod, 'soll');
      assert.equal(s.email.provider, 'none');
      assert.deepEqual(s.automation, { dunningEnabled: false, dunningRunTime: '09:00', recurringEnabled: false, recurringRunTime: '03:00' });
      assert.deepEqual(s.dunning.levels, []);
      assert.equal(s.portal.baseUrl, '');
      assert.equal(s.eInvoice.enabled, false);
      assert.deepEqual(s.businessReportingProfile, { jurisdiction: 'DE', legalForm: 'sole_proprietor', profitDetermination: 'eur', fiscalYearStart: '01-01', vatMethod: 'soll' });
      assert.equal(s.onboardingCompleted, false);
    });

    test('company, bank data, dunning levels, automation and portal URL persist exactly', async () => {
      const levels = [
        { id: 1, name: 'Zahlungserinnerung', enabled: true, daysAfterDueDate: 7, fee: 0, subject: 'Erinnerung %N', text: 'Rechnung %N ist offen.' },
        { id: 2, name: '1. Mahnung', enabled: false, daysAfterDueDate: 14, fee: 5, subject: '1. Mahnung %N', text: 'Bitte zahlen.' },
      ];
      await withSettings((s) => ({
        ...s,
        company: { name: 'Holzwerk Brandt', owner: 'Jana Brandt', street: 'Sägewerkstraße 12', zip: '14482', city: 'Potsdam', email: 'buero@holzwerk.test', phone: '0331 123', website: 'https://holzwerk.test' },
        finance: { bankName: 'Mittelbrandenburgische', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX', taxId: '046/123/45678', vatId: 'DE123456789', registerCourt: 'AG Potsdam HRB 1' },
        legal: { ...s.legal, paymentTermsDays: 30, defaultVatRate: 7, countryCode: 'AT' },
        dunning: { levels },
        automation: { dunningEnabled: true, dunningRunTime: '08:30', recurringEnabled: true, recurringRunTime: '02:15' },
        portal: { baseUrl: 'https://portal.holzwerk.test' },
        email: { ...s.email, provider: 'smtp', smtpHost: 'smtp.holzwerk.test', smtpPort: 465, smtpSecure: true, smtpUser: 'buero', fromName: 'Holzwerk', fromEmail: 'buero@holzwerk.test' },
        eInvoice: { ...s.eInvoice, enabled: true },
        catalog: { categories: [{ id: 'cat-1', name: 'Beratung' }] },
      }), async () => {
        const stored = await getSettings();
        assert.equal(stored.company.name, 'Holzwerk Brandt');
        assert.equal(stored.finance.iban, 'DE89370400440532013000');
        assert.equal(stored.legal.paymentTermsDays, 30);
        assert.equal(stored.legal.countryCode, 'AT');
        assert.deepEqual(stored.dunning.levels, levels);
        assert.deepEqual(stored.automation, { dunningEnabled: true, dunningRunTime: '08:30', recurringEnabled: true, recurringRunTime: '02:15' });
        assert.equal(stored.portal.baseUrl, 'https://portal.holzwerk.test');
        assert.deepEqual({ provider: stored.email.provider, port: stored.email.smtpPort, from: stored.email.fromEmail }, { provider: 'smtp', port: 465, from: 'buero@holzwerk.test' });
        assert.equal(stored.eInvoice.enabled, true);
        assert.deepEqual(stored.catalog.categories, [{ id: 'cat-1', name: 'Beratung' }]);
      });
      const restored = await getSettings();
      assert.equal(restored.company.name, ISSUER.company.name, 'restored to what onboarding stored');
      assert.equal(restored.email.provider, 'none');
    });

    test('invalid settings are rejected with 400 and leave the stored settings untouched', async () => {
      const before = await getSettings();
      const rejected: Array<[string, unknown]> = [
        ['unsupported country', { ...before, legal: { ...before.legal, countryCode: 'FR' } }],
        ['plain-http portal URL', { ...before, portal: { baseUrl: 'http://portal.example.com' } }],
        ['unknown e-mail provider', { ...before, email: { ...before.email, provider: 'sendgrid' } }],
        ['GmbH on cash-basis accounting', { ...before, businessReportingProfile: { jurisdiction: 'DE', legalForm: 'gmbh', profitDetermination: 'eur', fiscalYearStart: '01-01', vatMethod: 'soll' } }],
        ['sole proprietor on double entry', { ...before, businessReportingProfile: { jurisdiction: 'DE', legalForm: 'sole_proprietor', profitDetermination: 'double_entry', fiscalYearStart: '01-01', vatMethod: 'soll' } }],
        ['EÜR with a broken fiscal year', { ...before, businessReportingProfile: { jurisdiction: 'DE', legalForm: 'sole_proprietor', profitDetermination: 'eur', fiscalYearStart: '04-01', vatMethod: 'soll' } }],
        ['impossible fiscal year start', { ...before, businessReportingProfile: { jurisdiction: 'DE', legalForm: 'ek', profitDetermination: 'eur', fiscalYearStart: '02-31', vatMethod: 'soll' } }],
        ['missing sections', { company: before.company }],
        ['numbers as text', { ...before, numbers: { ...before.numbers, nextInvoiceNumber: 'eins' } }],
        ['dunning level without text', { ...before, dunning: { levels: [{ id: 1, name: 'x', enabled: true, daysAfterDueDate: 7, fee: 0 }] } }],
        ['dashboard limit out of range', { ...before, dashboard: { ...before.dashboard, topClientsLimit: 99 } }],
      ];
      for (const [label, settings] of rejected) {
        const response = await h.raw('PUT', '/settings', { settings });
        assert.equal(response.status, 400, `${label}: ${response.text}`);
      }
      assert.equal((await h.raw('PUT', '/settings', {})).status, 400);
      assert.deepEqual(await getSettings(), before);
    });

    test('a valid GmbH profile (double entry, SKR04, fiscal year from April) is accepted and decides the VAT method', async () => {
      const gmbh = { jurisdiction: 'DE', legalForm: 'gmbh', profitDetermination: 'double_entry', hgbSizeClass: 'small', fiscalYearStart: '04-01', chart: 'SKR04', vatMethod: 'ist' } as const;
      await withSettings((s) => ({ ...s, businessReportingProfile: gmbh }), async () => {
        const stored = await getSettings();
        assert.deepEqual(stored.businessReportingProfile, gmbh);
        assert.equal(stored.legal.taxAccountingMethod, 'ist', 'the reporting profile decides the VAT method');
      });
      assert.equal((await getSettings()).businessReportingProfile?.legalForm, 'sole_proprietor');
    });

    test('an empty IBAN (onboarding) and formatted IBANs are accepted', async () => {
      await withSettings((s) => ({ ...s, finance: { ...s.finance, iban: '' } }), async () => {
        assert.equal((await getSettings()).finance.iban, '');
      });
      await withSettings((s) => ({ ...s, finance: { ...s.finance, iban: 'DE89 3704 0044 0532 0130 00' } }), async () => {
        assert.equal((await getSettings()).finance.iban.replaceAll(' ', ''), 'DE89370400440532013000');
      });
    });

    test('settings accept an IBAN only when it is one', async () => {
      const accepted = await acceptedSettings([
        ['text instead of an IBAN', (s) => ({ ...s, finance: { ...s.finance, iban: 'NOT-AN-IBAN' } })],
        ['wrong checksum', (s) => ({ ...s, finance: { ...s.finance, iban: 'DE00370400440532013000' } })],
        ['too short', (s) => ({ ...s, finance: { ...s.finance, iban: 'DE89' } })],
      ]);
      assert.deepEqual(accepted, []);
    });

    test('settings keep VAT rates and payment terms in a sensible range', async () => {
      const accepted = await acceptedSettings([
        ['negative VAT rate', (s) => ({ ...s, legal: { ...s.legal, defaultVatRate: -19 } })],
        ['VAT rate above 100 %', (s) => ({ ...s, legal: { ...s.legal, defaultVatRate: 500 } })],
        ['negative payment terms', (s) => ({ ...s, legal: { ...s.legal, paymentTermsDays: -7 } })],
      ]);
      assert.deepEqual(accepted, []);
    });

    test('settings keep the number ranges usable', async () => {
      const accepted = await acceptedSettings([
        ['negative next invoice number', (s) => ({ ...s, numbers: { ...s.numbers, nextInvoiceNumber: -5 } })],
        ['zero next offer number', (s) => ({ ...s, numbers: { ...s.numbers, nextOfferNumber: 0 } })],
        ['negative number length', (s) => ({ ...s, numbers: { ...s.numbers, numberLength: -2 } })],
        ['absurd number length', (s) => ({ ...s, numbers: { ...s.numbers, numberLength: 5000 } })],
        ['fractional counter', (s) => ({ ...s, numbers: { ...s.numbers, nextCustomerNumber: 1.5 } })],
      ]);
      assert.deepEqual(accepted, []);
    });

    test('dunning levels need non-negative days and fees', async () => {
      const level = { id: 1, name: 'Mahnung', enabled: true, daysAfterDueDate: 7, fee: 0, subject: 's', text: 't' };
      const accepted = await acceptedSettings([
        ['negative fee', (s) => ({ ...s, dunning: { levels: [{ ...level, fee: -10 }] } })],
        ['negative days', (s) => ({ ...s, dunning: { levels: [{ ...level, daysAfterDueDate: -3 }] } })],
      ]);
      assert.deepEqual(accepted, []);
    });

    test('a changed number format applies to the next reserved number only', async () => {
      const issued = await issueInvoice(h.api, { client: `Format vorher ${uid()}` });
      const next = (await getSettings()).numbers.nextInvoiceNumber;
      await withSettings((s) => ({ ...s, numbers: { ...s.numbers, invoicePrefix: 'R-', numberLength: 5 } }), async () => {
        const reservation = await h.api.numbers.reserve({ kind: 'invoice' });
        assert.equal(reservation.number, `R-${pad(next, 5)}`, 'the counter continues, the format changes');
        await h.api.numbers.release({ reservationId: reservation.reservationId });
      });
      await withSettings((s) => ({ ...s, numbers: { ...s.numbers, invoicePrefix: 'INV/%Y/' } }), async () => {
        const reservation = await h.api.numbers.reserve({ kind: 'invoice' });
        assert.equal(reservation.number, `INV/${year}/${pad(next, 3)}`, 'the year placeholder is expanded');
        await h.api.numbers.release({ reservationId: reservation.reservationId });
      });
      const stored = (await h.api.invoices.list()).find((invoice) => invoice.id === issued.id)!;
      assert.equal(stored.number, issued.number, 'an issued invoice keeps its number');
      const again = await h.api.numbers.reserve({ kind: 'invoice' });
      assert.match(again.number, new RegExp(`^RE-${year}-\\d{3}$`), 'restoring the format brings the old one back');
      await h.api.numbers.release({ reservationId: again.reservationId });
    });

    test('a lowered counter never hands out a number that is already used', async () => {
      const issued = await issueInvoice(h.api, { client: `Zähler ${uid()}` });
      const counter = (await getSettings()).numbers.nextInvoiceNumber;
      const used = new Set((await h.api.invoices.list()).map((invoice) => invoice.number));
      await setSettings({ ...(await getSettings()), numbers: { ...(await getSettings()).numbers, nextInvoiceNumber: 1 } });
      try {
        const reservation = await h.api.numbers.reserve({ kind: 'invoice' });
        assert.ok(!used.has(reservation.number), `${reservation.number} is already an invoice number`);
        let expected = 1;
        while (used.has(`RE-${year}-${pad(expected, 3)}`)) expected += 1;
        assert.equal(reservation.number, `RE-${year}-${pad(expected, 3)}`, 'the first free number after the used ones');
        await h.api.numbers.release({ reservationId: reservation.reservationId });
      } finally {
        await setSettings({ ...(await getSettings()), numbers: { ...(await getSettings()).numbers, nextInvoiceNumber: counter } });
      }
      assert.equal((await h.api.invoices.list()).find((invoice) => invoice.id === issued.id)!.number, issued.number);
    });

    test('the Kleinunternehmer rule prices new documents without VAT and never rewrites issued ones', async () => {
      const items = [{ kind: 'item' as const, description: 'Leistung', quantity: 1, price: 500, total: 500, taxRate: 19 }];
      let small: Awaited<ReturnType<typeof issueInvoice>> | undefined;
      await withSettings((s) => ({ ...s, legal: { ...s.legal, smallBusinessRule: true } }), async () => {
        const taxMode = resolveInvoiceTaxMode(undefined, await getSettings());
        assert.equal(taxMode, 'small_business_19_ustg');
        small = await issueInvoice(h.api, { client: `Klein ${uid()}`, taxMode, items, taxMeta: datevEvidence(product) as never });
        assert.equal(small.taxSnapshot!.vatAmount, 0);
        assert.equal(small.taxSnapshot!.grossAmount, 500);
        assert.match(small.taxSnapshot!.taxNotice ?? '', /§\s?19/);
      });
      const standard = await issueInvoice(h.api, { client: `Regel ${uid()}`, items });
      assert.equal(standard.taxSnapshot!.vatAmount, 95);
      assert.equal(standard.amount, 595);
      const kept = (await h.api.invoices.list()).find((invoice) => invoice.id === small!.id)!;
      assert.equal(kept.taxMode, 'small_business_19_ustg');
      assert.equal(kept.taxSnapshot!.vatAmount, 0, 'switching the rule off does not change the issued invoice');
      assert.equal(kept.amount, 500);
    });

    test('a settings change is audited', async () => {
      const before = (await h.api.audit.verify()).count;
      await withSettings((s) => ({ ...s, company: { ...s.company, name: `Prüffirma ${uid()}` } }), async () => {
        assert.ok((await h.api.audit.verify()).count > before, 'no audit entry for the settings change');
      });
    });
  });

  describe('clients and customer numbers', () => {
    test('new clients get consecutive customer numbers in the configured format', async () => {
      const a = await makeClient({ company: `Seq A ${uid()}` });
      const b = await makeClient({ company: `Seq B ${uid()}` });
      const c = await makeClient({ company: `Seq C ${uid()}` });
      for (const created of [a, b, c]) assert.match(created.customerNumber!, /^KD-\d{4}$/);
      assert.equal(sequenceOf(b.customerNumber!), sequenceOf(a.customerNumber!) + 1);
      assert.equal(sequenceOf(c.customerNumber!), sequenceOf(b.customerNumber!) + 1);
      const stored = await h.api.clients.list();
      for (const created of [a, b, c]) assert.equal(stored.find((client) => client.id === created.id)!.customerNumber, created.customerNumber);
      assert.equal((await getSettings()).numbers.nextCustomerNumber, sequenceOf(c.customerNumber!) + 1);
      const reservation = await h.api.numbers.reserve({ kind: 'customer' });
      assert.equal(sequenceOf(reservation.number), sequenceOf(c.customerNumber!) + 1);
      await h.api.numbers.release({ reservationId: reservation.reservationId });
    });

    test('a manual customer number is kept and the sequence skips it', async () => {
      const next = (await getSettings()).numbers.nextCustomerNumber;
      const manualNumber = `KD-${pad(next + 1, 4)}`;
      const manual = await makeClient({ company: `Manuell ${uid()}`, customerNumber: manualNumber });
      assert.equal(manual.customerNumber, manualNumber);
      const first = await makeClient({ company: `Auto 1 ${uid()}` });
      const second = await makeClient({ company: `Auto 2 ${uid()}` });
      assert.equal(first.customerNumber, `KD-${pad(next, 4)}`);
      assert.equal(second.customerNumber, `KD-${pad(next + 2, 4)}`, 'the manually taken number is skipped');
    });

    test('the customer number format follows prefix, length and year placeholder', async () => {
      await withSettings((s) => ({ ...s, numbers: { ...s.numbers, customerPrefix: 'K-%Y-', customerNumberLength: 6 } }), async () => {
        const created = await makeClient({ company: `Format ${uid()}` });
        assert.match(created.customerNumber!, new RegExp(`^K-${year}-\\d{6}$`));
      });
      assert.match((await makeClient({ company: `Zurück ${uid()}` })).customerNumber!, /^KD-\d{4}$/);
    });

    test('updating a client keeps its number and is audited with before and after', async () => {
      const created = await makeClient({ company: `Update ${uid()}` });
      const updated = await h.api.clients.upsert({ client: { ...created, phone: '+49 40 999', notes: 'Stammkunde', tags: ['vip'] } as never });
      assert.equal(updated.customerNumber, created.customerNumber);
      const stored = (await h.api.clients.list()).find((client) => client.id === created.id)!;
      assert.deepEqual({ phone: stored.phone, notes: stored.notes, tags: stored.tags }, { phone: '+49 40 999', notes: 'Stammkunde', tags: ['vip'] });
      const rows = parseCsv(await h.api.audit.exportCsv()).filter((row) => row[3] === created.id);
      assert.deepEqual(rows.map((row) => row[4]), ['client.create', 'client.update']);
      assert.equal(JSON.parse(rows[1]![9]!).phone, newClient().phone);
      assert.equal(JSON.parse(rows[1]![10]!).phone, '+49 40 999');
    });

    test('an update that omits or blanks the customer number keeps the assigned one', async () => {
      const created = await makeClient({ company: `Nummer ${uid()}` });
      const { customerNumber: _dropped, ...withoutNumber } = created;
      const omitted = await h.raw('POST', '/clients', { reason: 'ohne Nummer', client: { ...withoutNumber, notes: 'ohne' } });
      const blank = await h.raw('POST', '/clients', { reason: 'leere Nummer', client: { ...created, customerNumber: '', notes: 'leer' } });
      assert.deepEqual([omitted.status, blank.status], [200, 200]);
      assert.deepEqual(
        { omitted: omitted.body.customerNumber, blank: blank.body.customerNumber },
        { omitted: created.customerNumber, blank: created.customerNumber },
      );
    });

    test('a duplicate customer number is refused with a clean 409', async () => {
      const original = await makeClient({ company: `Original ${uid()}` });
      const before = (await h.api.clients.list()).length;
      const duplicate = await h.raw('POST', '/clients', { reason: 'doppelt', client: newClient({ company: `Doppelt ${uid()}`, customerNumber: original.customerNumber }) });
      assert.equal(duplicate.status, 409, duplicate.text);
      assert.doesNotMatch(duplicate.text, /insert into|Failed query/i, 'no SQL in the error message');
      assert.equal((await h.api.clients.list()).length, before, 'nothing was created');
    });

    test('a manual customer number is stored trimmed', async () => {
      const created = await makeClient({ company: `Trim ${uid()}`, customerNumber: `  KD-T${uid()}  ` });
      assert.equal(created.customerNumber, created.customerNumber!.trim());
    });

    test('a deleted client keeps its number reserved: it is never handed out again', async () => {
      const gone = await makeClient({ company: `Weg ${uid()}` });
      await h.api.clients.delete({ id: gone.id });
      const successors = [await makeClient({ company: `Neu 1 ${uid()}` }), await makeClient({ company: `Neu 2 ${uid()}` })];
      for (const created of successors) {
        assert.notEqual(created.customerNumber, gone.customerNumber);
        assert.ok(sequenceOf(created.customerNumber!) > sequenceOf(gone.customerNumber!));
      }
    });

    test('a number reservation is finalized once for one document; a finalized number is never released into the pool again', async () => {
      const reservation = await h.api.numbers.reserve({ kind: 'customer' });
      const documentId = randomUUID();
      await h.api.numbers.finalize({ reservationId: reservation.reservationId, documentId });
      await h.api.numbers.finalize({ reservationId: reservation.reservationId, documentId });
      const stolen = await h.raw('POST', '/numbers/finalize', { reservationId: reservation.reservationId, documentId: randomUUID() });
      assert.equal(stolen.status, 409, stolen.text);
      const unknown = await h.raw('POST', '/numbers/finalize', { reservationId: randomUUID(), documentId });
      assert.deepEqual([unknown.status, unknown.body], [200, { ok: true }], 'an unknown reservation is a no-op');
      await h.api.numbers.release({ reservationId: reservation.reservationId });
      const next = await h.api.numbers.reserve({ kind: 'customer' });
      assert.ok(sequenceOf(next.number) > sequenceOf(reservation.number), 'releasing a finalized reservation does not hand its number out again');
      await h.api.numbers.release({ reservationId: next.reservationId });
      assert.equal((await h.raw('POST', '/numbers/reserve', { kind: 'receipt' })).status, 400);
      assert.equal((await h.raw('POST', '/numbers/finalize', { reservationId: '', documentId })).status, 400);
    });

    test('addresses, e-mails and the tax profile round-trip, including the VAT ID fields', async () => {
      const id = randomUUID();
      const created = await makeClient({
        id,
        company: `Alpen GmbH ${uid()}`,
        addresses: [
          { id: 'a-1', clientId: id, label: 'Rechnung', kind: 'billing', company: 'Alpen GmbH', contactPerson: 'Ada', street: 'Ringstraße 1', line2: 'Hinterhaus', zip: '1010', city: 'Wien', country: 'AT', isDefaultBilling: true, isDefaultShipping: false },
          { id: 'a-2', clientId: id, label: 'Lager', kind: 'shipping', street: 'Hafenweg 9', zip: '20457', city: 'Hamburg', country: 'DE', isDefaultBilling: false, isDefaultShipping: true },
          { id: 'a-3', clientId: id, label: 'Sonstige', kind: 'other', street: 'Nebenstr. 3', zip: '80331', city: 'München', country: 'DE', isDefaultBilling: false, isDefaultShipping: false },
        ],
        emails: [
          { id: 'm-1', clientId: id, label: 'Allgemein', kind: 'general', email: 'info@alpen.example', isDefaultGeneral: true, isDefaultBilling: false },
          { id: 'm-2', clientId: id, label: 'Buchhaltung', kind: 'billing', email: 'buchhaltung@alpen.example', isDefaultGeneral: false, isDefaultBilling: true },
        ],
        taxProfile: { type: 'business', countryCode: 'AT', vatId: 'ATU12345678', vatIdValidation: 'manual_override', vatIdValidationAt: '2026-10-01T10:00:00.000Z' },
      });
      const stored = (await h.api.clients.list()).find((client) => client.id === id)!;
      assert.deepEqual(stored.addresses, created.addresses);
      assert.deepEqual(stored.emails, created.emails);
      assert.equal(stored.addresses!.filter((address) => address.isDefaultBilling).length, 1);
      assert.equal(stored.addresses!.find((address) => address.isDefaultShipping)!.id, 'a-2');
      assert.deepEqual(stored.taxProfile, { type: 'business', countryCode: 'AT', vatId: 'ATU12345678', vatIdValidation: 'manual_override', vatIdValidationAt: '2026-10-01T10:00:00.000Z' });

      const changed = await h.api.clients.upsert({ client: { ...stored, taxProfile: { type: 'business', countryCode: 'DE', vatId: 'DE123456789' }, addresses: stored.addresses!.map((address) => ({ ...address, isDefaultBilling: address.id === 'a-3' })) } as never });
      assert.equal(changed.taxProfile!.vatId, 'DE123456789');
      assert.equal(changed.taxProfile!.vatIdValidation, undefined, 'a changed VAT ID drops the old validation unless the caller sends one');
      assert.equal(changed.addresses!.find((address) => address.isDefaultBilling)!.id, 'a-3');

      const consumer = await makeClient({ company: `Privat ${uid()}`, taxProfile: { type: 'consumer' } });
      assert.deepEqual((await h.api.clients.list()).find((client) => client.id === consumer.id)!.taxProfile, { type: 'consumer' });
    });

    test('a new document takes the default billing address, billing e-mail and client number', async () => {
      const id = randomUUID();
      const created = await makeClient({
        id, company: `Entwurf ${uid()}`, address: 'veraltet', email: 'veraltet@example.com',
        addresses: [
          { id: 'b', clientId: id, label: 'Rechnung', kind: 'billing', street: 'Billing 1', zip: '10115', city: 'Berlin', country: 'DE', isDefaultBilling: true, isDefaultShipping: false },
          { id: 's', clientId: id, label: 'Lager', kind: 'shipping', street: 'Ship 2', zip: '20095', city: 'Hamburg', country: 'DE', isDefaultBilling: false, isDefaultShipping: true },
        ],
        emails: [
          { id: 'g', clientId: id, label: 'Allgemein', kind: 'general', email: 'general@example.com', isDefaultGeneral: true, isDefaultBilling: false },
          { id: 'x', clientId: id, label: 'Buchhaltung', kind: 'billing', email: 'buchhaltung@example.com', isDefaultGeneral: false, isDefaultBilling: true },
        ],
      });
      const paymentTerms = (await getSettings()).legal.paymentTermsDays;
      const invoice = await h.api.documents.createFromClient({ kind: 'invoice', clientId: id });
      assert.equal(invoice.client, created.company);
      assert.equal(invoice.clientNumber, created.customerNumber);
      assert.equal(invoice.clientEmail, 'buchhaltung@example.com');
      assert.equal(invoice.clientAddress, 'Billing 1\n10115 Berlin\nDE');
      assert.equal((invoice.billingAddressJson as { id: string }).id, 'b');
      assert.equal((invoice.shippingAddressJson as { id: string }).id, 's');
      assert.equal(invoice.status, 'draft');
      assert.equal(invoice.date, today());
      assert.equal(invoice.dueDate, addDays(today(), paymentTerms));
      assert.match(invoice.number, new RegExp(`^RE-${year}-\\d{3}$`));
      const offer = await h.api.documents.createFromClient({ kind: 'offer', clientId: id });
      assert.match(offer.number, new RegExp(`^ANG-${year}-\\d{3}$`));
      assert.equal(offer.dueDate, today(), 'an offer has no payment term');
      await h.api.numbers.release({ reservationId: invoice.numberReservationId! });
      await h.api.numbers.release({ reservationId: offer.numberReservationId! });

      const legacy = await makeClient({ company: `Alt ${uid()}`, address: 'Altstraße 5\n50667 Köln', email: 'alt@example.com' });
      const fromLegacy = await h.api.documents.createFromClient({ kind: 'invoice', clientId: legacy.id });
      assert.equal(fromLegacy.clientEmail, 'alt@example.com');
      assert.equal(fromLegacy.clientAddress, 'Altstraße 5\n50667 Köln');
      await h.api.numbers.release({ reservationId: fromLegacy.numberReservationId! });

      await assert.rejects(h.api.documents.createFromClient({ kind: 'invoice', clientId: randomUUID() }), /nicht gefunden/);
    });

    test('invalid client payloads are rejected with 400', async () => {
      const post = (client: unknown, reason = 'test') => h.raw('POST', '/clients', { reason, client });
      const cases: Array<[string, Awaited<ReturnType<typeof post>>]> = [
        ['empty company', await post(newClient({ company: '' }))],
        ['malformed contact e-mail', await post(newClient({ emails: [{ id: 'e', clientId: 'c', label: 'x', kind: 'billing', email: 'kein-mail' }] }))],
        ['three-letter country code', await post(newClient({ taxProfile: { type: 'business', countryCode: 'AUT' } }))],
        ['unknown tax profile type', await post(newClient({ taxProfile: { type: 'company' } }))],
        ['unknown VAT validation state', await post(newClient({ taxProfile: { type: 'business', vatIdValidation: 'maybe' } }))],
        ['unknown address kind', await post(newClient({ addresses: [{ id: 'a', clientId: 'c', label: 'x', kind: 'home', street: 's', zip: 'z', city: 'c' }] }))],
        ['unknown status', await post(newClient({ status: 'archived' }))],
        ['missing reason', await post(newClient(), '')],
      ];
      for (const [label, response] of cases) assert.equal(response.status, 400, `${label}: ${response.text}`);
      assert.equal((await h.raw('POST', '/clients', { reason: 'x' })).status, 400, 'missing client');
    });

    test('contact persons round-trip, keep one primary and mirror it into contactPerson', async () => {
      const id = randomUUID();
      const created = await makeClient({
        id, company: `Kontakte ${uid()}`, contactPerson: 'veraltet',
        contacts: [
          { id: 'k-1', name: 'Anna Einkauf', role: 'Einkauf', email: 'anna@kontakte.example', phone: '030 1', isPrimary: false },
          { id: 'k-2', name: 'Bernd Buchhaltung', role: 'Buchhaltung', isPrimary: true },
        ],
      });
      assert.equal(created.contactPerson, 'Bernd Buchhaltung', 'contactPerson mirrors the primary contact');
      const stored = (await clientById(id))!;
      assert.deepEqual(stored.contacts, [
        { id: 'k-1', name: 'Anna Einkauf', role: 'Einkauf', email: 'anna@kontakte.example', phone: '030 1', isPrimary: false },
        { id: 'k-2', name: 'Bernd Buchhaltung', role: 'Buchhaltung', isPrimary: true },
      ]);

      // Switching the primary contact moves the legacy name along.
      const switched = await h.api.clients.upsert({ client: { ...stored, contacts: stored.contacts!.map((contact) => ({ ...contact, isPrimary: contact.id === 'k-1' })) } as never });
      assert.equal(switched.contactPerson, 'Anna Einkauf');
      assert.deepEqual((await clientById(id))!.contacts!.map((contact) => [contact.id, contact.isPrimary]), [['k-1', true], ['k-2', false]]);

      // None marked: the first one becomes primary.
      const unmarked = await makeClient({ company: `Ohne Primär ${uid()}`, contacts: [{ id: 'u-1', name: 'Erste', isPrimary: false }, { id: 'u-2', name: 'Zweite', isPrimary: false }] });
      assert.deepEqual(unmarked.contacts!.map((contact) => contact.isPrimary), [true, false]);
      assert.equal(unmarked.contactPerson, 'Erste');

      // Without contacts the legacy field stays as sent; an old row reads as no contacts.
      const legacy = await makeClient({ company: `Ohne Kontakte ${uid()}`, contactPerson: 'Nur Legacy' });
      assert.equal(legacy.contactPerson, 'Nur Legacy');
      assert.deepEqual((await clientById(legacy.id))!.contacts, []);
    });

    test('invalid contact lists are rejected with 400 and nothing is saved', async () => {
      const post = (contacts: unknown) => h.raw('POST', '/clients', { reason: 'test', client: newClient({ company: `Ungültig ${uid()}`, contacts }) });
      const before = (await h.api.clients.list()).length;
      const cases: Array<[string, Awaited<ReturnType<typeof post>>]> = [
        ['two primary contacts', await post([{ id: 'a', name: 'A', isPrimary: true }, { id: 'b', name: 'B', isPrimary: true }])],
        ['contact without name', await post([{ id: 'a', name: ' ', isPrimary: true }])],
        ['malformed contact e-mail', await post([{ id: 'a', name: 'A', email: 'kein-mail', isPrimary: true }])],
        ['more than 20 contacts', await post(Array.from({ length: 21 }, (_, index) => ({ id: `c-${index}`, name: `K ${index}`, isPrimary: index === 0 })))],
      ];
      for (const [label, response] of cases) assert.equal(response.status, 400, `${label}: ${response.text}`);
      assert.equal((await h.api.clients.list()).length, before);
    });

    test('a CSV import maps German headers, assigns customer numbers, skips duplicates and invalid rows', async () => {
      const tag = uid();
      const existing = await makeClient({ company: `Bestand ${tag}`, customerNumber: `KD-CSV-${tag}` });
      const csv = '\uFEFFFirma;Kundennummer;Ansprechpartner;E-Mail;Telefon;Straße;PLZ;Ort;Land;USt-IdNr\r\n'
        + `Neu Eins ${tag};;Clara Import;clara@import.example;030 5;Importweg 1;10115;Berlin;DE;de123456789\r\n`
        + `Doppelt ${tag};KD-CSV-${tag};;;;;;;;\r\n`
        + `Kaputt ${tag};;;keine-mail;;;;;;\r\n`
        + `Neu Eins ${tag};;;;;Anderer Weg 2;10115;Berlin;DE;\r\n`
        + ';;;;;;;;;\r\n'
        + `Neu Zwei ${tag};;;;;;;;;\r\n`;
      const table = readMasterdataCsv(csv);
      assert.equal(table.delimiter, ';');
      const rows = mapClientCsv(table, await h.api.clients.list(), randomUUID);
      assert.deepEqual(rows.map((row) => row.status), ['ok', 'duplicate', 'error', 'duplicate', 'ok'], 'the empty line is skipped, same name+PLZ inside the file is a duplicate');
      assert.match(rows[2]!.errors.join(), /Ungültige E-Mail/);

      const imported = [];
      for (const row of rows) if (row.record) imported.push(await h.api.clients.upsert({ client: row.record as never, reason: 'CSV-Import kunden.csv' }));
      assert.equal(imported.length, 2);
      const [first, second] = imported;
      assert.ok(first!.customerNumber && second!.customerNumber && first!.customerNumber !== second!.customerNumber, 'blank numbers are assigned by the server');
      assert.equal(sequenceOf(second!.customerNumber!), sequenceOf(first!.customerNumber!) + 1);
      assert.equal(first!.contactPerson, 'Clara Import');
      assert.deepEqual(first!.contacts!.map((contact) => [contact.name, contact.isPrimary]), [['Clara Import', true]]);
      assert.equal(first!.emails![0]!.email, 'clara@import.example');
      assert.deepEqual([first!.addresses![0]!.street, first!.addresses![0]!.zip, first!.addresses![0]!.city], ['Importweg 1', '10115', 'Berlin']);
      assert.equal(first!.taxProfile!.vatId, 'DE123456789');
      const stored = await h.api.clients.list();
      assert.equal(stored.filter((client) => client.customerNumber === existing.customerNumber).length, 1, 'the existing client is not imported twice');
      assert.equal(stored.filter((client) => client.company === `Neu Eins ${tag}`).length, 1);
      assert.equal(stored.some((client) => client.company === `Kaputt ${tag}`), false);

      // Re-running the same file imports nothing: every row is a duplicate or invalid now.
      assert.deepEqual(mapClientCsv(table, stored, randomUUID).map((row) => row.status), ['duplicate', 'duplicate', 'error', 'duplicate', 'duplicate']);

      const audit = parseCsv(await h.api.audit.exportCsv()).filter((row) => row[3] === first!.id);
      assert.deepEqual(audit.map((row) => [row[4], row[5]]), [['client.create', 'CSV-Import kunden.csv']]);
    });

    test('a CSV import of articles reads "1.234,56", English headers and the "," delimiter, and skips SKU/title duplicates', async () => {
      assert.deepEqual(['1.234,56', '1234,5', '1234.56', '1.234', '€ 12', 'zwölf', ''].map(parseGermanNumber), [1234.56, 1234.5, 1234.56, 1234, 12, null, null]);
      const tag = uid();
      await h.api.articles.upsert({ article: { id: randomUUID(), sku: `SKU-${tag}`, title: `Bestand ${tag}`, description: '', price: 1, unit: 'Stk', category: 'x', taxRate: 19 } });
      const semicolon = readMasterdataCsv(`Artikelnummer;Bezeichnung;Preis;USt;Einheit;Kategorie\nA-${tag};Beratung ${tag};1.234,56;19;Std;Dienstleistung\nsku-${tag};Anders ${tag};5;7;;\nB-${tag};Ermäßigt ${tag};"12,50";7 %;;\nC-${tag};Falsch ${tag};abc;16;;\nD-${tag};;10;19;;\nE-${tag};bestand ${tag};3;0;;`);
      const rows = mapArticleCsv(semicolon, await h.api.articles.list(), randomUUID);
      assert.deepEqual(rows.map((row) => row.status), ['ok', 'duplicate', 'ok', 'error', 'error', 'duplicate'], 'SKU and title compare case-insensitively');
      assert.match(rows[3]!.errors.join(' | '), /Preis ist keine Zahl.*USt-Satz muss 0, 7 oder 19 sein/);
      assert.match(rows[4]!.errors.join(), /Bezeichnung fehlt/);
      for (const row of rows) if (row.record) await h.api.articles.upsert({ article: row.record });
      const stored = await h.api.articles.list();
      const beratung = stored.find((article) => article.sku === `A-${tag}`)!;
      assert.deepEqual([beratung.price, beratung.taxRate, beratung.unit, beratung.category], [1234.56, 19, 'Std', 'Dienstleistung']);
      assert.deepEqual([stored.find((article) => article.sku === `B-${tag}`)!.price, stored.find((article) => article.sku === `B-${tag}`)!.taxRate], [12.5, 7]);
      assert.equal(stored.some((article) => article.sku === `C-${tag}`), false);

      const comma = readMasterdataCsv(`SKU,Title,Description,Price,Unit,VAT\nF-${tag},English ${tag},"Zeile, mit Komma",99.90,h,19`);
      assert.equal(comma.delimiter, ',');
      const [english] = mapArticleCsv(comma, stored, randomUUID);
      assert.deepEqual([english!.status, english!.record?.description, english!.record?.price, english!.record?.unit], ['ok', 'Zeile, mit Komma', 99.9, 'h']);
    });

    test('a client can be fetched by id and an unknown id gives null', async () => {
      const created = await makeClient({ company: `Abruf ${uid()}` });
      const found = await h.raw('GET', `/clients/${created.id}`);
      assert.equal(found.status, 200);
      assert.equal(found.body.company, created.company);
      const missing = await h.raw('GET', `/clients/${randomUUID()}`);
      assert.deepEqual([missing.status, missing.body], [200, null]);
    });

    test('deleting a client leaves its invoices intact and is audited; unknown ids and missing reasons are refused', async () => {
      const owner = await makeClient({ company: `Löschkunde ${uid()}` });
      const invoice = await issueInvoice(h.api, { client: owner.company, clientId: owner.id });
      const deleted = await h.raw('DELETE', `/clients/${owner.id}`, { reason: 'Kunde gelöscht' });
      assert.equal(deleted.status, 200, deleted.text);
      assert.ok(!(await h.api.clients.list()).some((client) => client.id === owner.id));

      const kept = (await h.api.invoices.list()).find((candidate) => candidate.id === invoice.id)!;
      assert.equal(kept.client, owner.company, 'the invoice keeps its own copy of the client name');
      assert.equal(kept.clientAddress, invoice.clientAddress);
      assert.equal(kept.clientEmail, invoice.clientEmail);
      assert.equal(kept.status, 'open');
      assert.equal(kept.amount, invoice.amount);
      const context = await h.api.documents.renderContext({ kind: 'invoice', id: invoice.id });
      assert.equal(context.document.client, owner.company, 'the invoice still renders');

      const entry = parseCsv(await h.api.audit.exportCsv()).find((row) => row[3] === owner.id && row[4] === 'client.delete')!;
      assert.equal(entry[5], 'Kunde gelöscht');
      assert.equal(JSON.parse(entry[9]!).company, owner.company, 'the deleted client is preserved in the audit trail');

      assert.equal((await h.raw('DELETE', `/clients/${randomUUID()}`, { reason: 'x' })).status, 404);
      const other = await makeClient({ company: `Bleibt ${uid()}` });
      assert.equal((await h.raw('DELETE', `/clients/${other.id}`, {})).status, 400);
      assert.ok((await h.api.clients.list()).some((client) => client.id === other.id));
    });
  });

  describe('projects', () => {
    const projectInput = (clientId: string, overrides: Record<string, unknown> = {}) => ({
      id: randomUUID(), clientId, name: `Projekt ${uid()}`, status: 'active', budget: 1000, startDate: '2026-02-01', ...overrides,
    });
    const upsertProject = (project: ReturnType<typeof projectInput>, reason = 'Projekt gespeichert') =>
      h.api.projects.upsert({ reason, project: project as never });

    test('projects get a code, keep budget and dates, move between clients and are archived instead of deleted', async () => {
      const owner = await makeClient({ company: `Projekte ${uid()}` });
      const other = await makeClient({ company: `Anderer ${uid()}` });
      const general = await upsertProject(projectInput(owner.id, { name: 'Allgemein', budget: 0, startDate: '2026-01-01' }));
      const web = await upsertProject(projectInput(owner.id, { name: 'Website', budget: 5000.5, startDate: '2026-03-01', endDate: '2026-06-30', description: 'Relaunch' }));
      assert.match(general.code!, /^PRJ-2026-\d{3}$/);
      assert.match(web.code!, /^PRJ-2026-\d{3}$/);
      assert.notEqual(general.code, web.code);
      assert.deepEqual({ budget: web.budget, startDate: web.startDate, endDate: web.endDate, description: web.description, status: web.status }, { budget: 5000.5, startDate: '2026-03-01', endDate: '2026-06-30', description: 'Relaunch', status: 'active' });

      assert.deepEqual((await h.api.projects.list({ clientId: owner.id })).map((project) => project.id), [web.id, general.id], 'newest start date first');
      assert.deepEqual(await h.api.projects.list({ clientId: other.id }), []);
      assert.equal((await h.api.projects.get({ id: web.id }))!.name, 'Website');
      assert.equal(await h.api.projects.get({ id: randomUUID() }), null);

      const updated = await upsertProject({ ...web, budget: 7500.25, status: 'on_hold' } as never, 'Budget erhöht');
      assert.deepEqual({ code: updated.code, createdAt: updated.createdAt, budget: updated.budget, status: updated.status }, { code: web.code, createdAt: web.createdAt, budget: 7500.25, status: 'on_hold' });
      const embedded = (await h.api.clients.list()).find((client) => client.id === owner.id)!.projects;
      assert.deepEqual(embedded.map((project) => project.id).sort(), [general.id, web.id].sort(), 'the client carries its projects');

      const moved = await upsertProject({ ...updated, clientId: other.id } as never, 'Projekt verschoben');
      assert.equal(moved.clientId, other.id);
      assert.equal(moved.code, web.code);
      assert.deepEqual((await h.api.projects.list({ clientId: owner.id })).map((project) => project.id), [general.id]);
      assert.deepEqual((await h.api.projects.list({ clientId: other.id })).map((project) => project.id), [web.id]);
      assert.equal((await h.api.projects.list({})).filter((project) => project.id === web.id).length, 1, 'exactly one copy of the moved project');

      const archived = await h.api.projects.archive({ id: web.id, reason: 'abgeschlossen' });
      assert.ok(archived.archivedAt);
      assert.equal(archived.budget, 7500.25);
      assert.ok(!(await h.api.projects.list({ clientId: other.id })).some((project) => project.id === web.id), 'archived projects drop out of the default list');
      assert.ok((await h.api.projects.list({ clientId: other.id, includeArchived: true })).some((project) => project.id === web.id));
      assert.equal((await h.api.projects.get({ id: web.id }))!.archivedAt, archived.archivedAt, 'an archived project can still be fetched');
    });

    test('a new document is assigned to the default project "Allgemein", else to an active project', async () => {
      const withGeneral = await makeClient({ company: `Mit Allgemein ${uid()}` });
      const specific = await upsertProject(projectInput(withGeneral.id, { name: 'Sonderprojekt' }));
      const general = await upsertProject(projectInput(withGeneral.id, { name: 'Allgemein', startDate: '2026-01-01' }));
      const draft = await h.api.documents.createFromClient({ kind: 'invoice', clientId: withGeneral.id });
      assert.equal(draft.projectId, general.id);
      await h.api.numbers.release({ reservationId: draft.numberReservationId! });

      const onlySpecific = await makeClient({ company: `Nur Sonder ${uid()}` });
      const relaunch = await upsertProject(projectInput(onlySpecific.id, { name: 'Relaunch' }));
      const second = await h.api.documents.createFromClient({ kind: 'invoice', clientId: onlySpecific.id });
      assert.equal(second.projectId, relaunch.id);
      await h.api.numbers.release({ reservationId: second.numberReservationId! });
      assert.notEqual(specific.id, general.id);
    });

    test('include-archived=false hides archived projects', async () => {
      const owner = await makeClient({ company: `Archiv ${uid()}` });
      const live = await upsertProject(projectInput(owner.id));
      const gone = await upsertProject(projectInput(owner.id));
      await h.api.projects.archive({ id: gone.id, reason: 'fertig' });
      assert.deepEqual((await h.api.projects.list({ clientId: owner.id, includeArchived: false })).map((project) => project.id), [live.id]);
    });

    test('unknown ids and clashing codes give 404/409 instead of 500', async () => {
      const owner = await makeClient({ company: `Fehler ${uid()}` });
      const existing = await upsertProject(projectInput(owner.id));
      const status = async (label: string, request: Promise<{ status: number }>) => [label, (await request).status] as const;
      const results = await Promise.all([
        status('unknown client -> 404', h.raw('POST', '/projects', { reason: 'x', project: projectInput(randomUUID()) })),
        status('archive unknown -> 404', h.raw('POST', `/projects/${randomUUID()}/archive`, { reason: 'x' })),
        status('duplicate code -> 409', h.raw('POST', '/projects', { reason: 'x', project: projectInput(owner.id, { code: existing.code }) })),
      ]);
      assert.deepEqual(results, [['unknown client -> 404', 404], ['archive unknown -> 404', 404], ['duplicate code -> 409', 409]]);
    });

    test('invalid project payloads are rejected with 400', async () => {
      const owner = await makeClient({ company: `Validierung ${uid()}` });
      const post = (project: unknown, reason = 'x') => h.raw('POST', '/projects', { reason, project });
      const cases: Array<[string, Awaited<ReturnType<typeof post>>]> = [
        ['missing client', await post({ ...projectInput(owner.id), clientId: undefined })],
        ['unknown status', await post(projectInput(owner.id, { status: 'wip' }))],
        ['missing reason', await post(projectInput(owner.id), '')],
        ['missing name', await post({ ...projectInput(owner.id), name: undefined })],
        ['budget as text', await post(projectInput(owner.id, { budget: 'viel' }))],
      ];
      for (const [label, response] of cases) assert.equal(response.status, 400, `${label}: ${response.text}`);
      assert.equal((await h.raw('POST', `/projects/${randomUUID()}/archive`, { reason: '' })).status, 400);
    });

    test('projects reject a negative budget, a non-date start and an end before the start', async () => {
      const owner = await makeClient({ company: `Projektdaten ${uid()}` });
      const cases: Array<[string, Record<string, unknown>]> = [
        ['negative budget', { budget: -100 }],
        ['start date is not a date', { startDate: 'morgen' }],
        ['end before start', { startDate: '2026-05-01', endDate: '2026-01-01' }],
      ];
      const accepted: string[] = [];
      for (const [label, patch] of cases) {
        const response = await h.raw('POST', '/projects', { reason: 'x', project: projectInput(owner.id, patch) });
        if (response.status === 200) accepted.push(label);
      }
      assert.deepEqual(accepted, []);
    });

    test('project changes are audited with their reason', async () => {
      const owner = await makeClient({ company: `Audit ${uid()}` });
      const reason = `Budget geprüft ${uid()}`;
      const project = await upsertProject(projectInput(owner.id), reason);
      await h.api.projects.archive({ id: project.id, reason: `${reason} archiviert` });
      const rows = parseCsv(await h.api.audit.exportCsv()).filter((row) => row[3] === project.id);
      assert.equal(rows.length, 2, 'one audit entry per project change');
      assert.deepEqual(rows.map((row) => row[5]), [reason, `${reason} archiviert`]);
    });

    test('a client form saved from stale data does not wipe projects created in the meantime', async () => {
      const owner = await makeClient({ company: `Stale ${uid()}` });
      const stale = (await h.api.clients.list()).find((client) => client.id === owner.id)!;
      const project = await upsertProject(projectInput(owner.id));
      await h.api.clients.upsert({ client: { ...stale, notes: 'bearbeitet' } as never });
      assert.ok((await h.api.projects.list({ clientId: owner.id })).some((candidate) => candidate.id === project.id));
    });
  });

  describe('articles', () => {
    test('articles keep price, unit, category and VAT rate through create, update and delete', async () => {
      const id = randomUUID();
      const created = await h.api.articles.upsert({ article: { id, sku: `SKU-${uid()}`, title: 'Beratung', description: 'pro Stunde', price: 99.5, unit: 'Std.', category: 'Dienstleistung', taxRate: 19 } });
      assert.deepEqual({ price: created.price, unit: created.unit, taxRate: created.taxRate, category: created.category }, { price: 99.5, unit: 'Std.', taxRate: 19, category: 'Dienstleistung' });
      const reduced = await h.api.articles.upsert({ article: { ...created, price: 24.9, unit: 'Stk.', taxRate: 7, title: 'Buch' } });
      assert.deepEqual({ price: reduced.price, unit: reduced.unit, taxRate: reduced.taxRate }, { price: 24.9, unit: 'Stk.', taxRate: 7 });
      const matches = (await h.api.articles.list()).filter((article) => article.id === id);
      assert.equal(matches.length, 1, 'an update replaces, it does not add');
      assert.equal(matches[0]!.title, 'Buch');
      await h.api.articles.delete({ id });
      assert.ok(!(await h.api.articles.list()).some((article) => article.id === id));
      await h.api.articles.delete({ id });
    });

    test('malformed article payloads are rejected with 400', async () => {
      const valid = { id: randomUUID(), title: 'x', description: '', price: 1, unit: 'Stk.', category: '', taxRate: 19 };
      for (const [label, article] of [['price as text', { ...valid, price: 'teuer' }], ['missing unit', { ...valid, unit: undefined }], ['missing id', { ...valid, id: undefined }]] as const) {
        const response = await h.raw('POST', '/articles', { article });
        assert.equal(response.status, 400, `${label}: ${response.text}`);
      }
      assert.equal((await h.raw('POST', '/articles', {})).status, 400);
    });

    test('articles reject a VAT rate outside 0-100 % and an empty title', async () => {
      const base = { description: '', price: 5, unit: 'Stk.', category: '', taxRate: 19 };
      const cases: Array<[string, Record<string, unknown>]> = [
        ['VAT 190 %', { taxRate: 190 }],
        ['negative VAT', { taxRate: -1 }],
        ['empty title', { title: '' }],
      ];
      const accepted: string[] = [];
      for (const [label, patch] of cases) {
        const response = await h.raw('POST', '/articles', { article: { id: randomUUID(), title: 'Prüfartikel', ...base, ...patch } });
        if (response.status === 200) accepted.push(label);
      }
      assert.deepEqual(accepted, []);
    });
  });

  describe('document templates', () => {
    const klassisch = (accentColor?: string): TemplateBody => ({ ...createDefaultTemplateBody('invoice', 'klassisch'), ...(accentColor ? { accentColor } : {}) });
    const saveTemplate = (kind: 'invoice' | 'offer' | 'dunning' | 'credit_note', name: string, body: TemplateBody, id?: string) =>
      h.api.documentTemplates.upsert({ template: { ...(id ? { id } : {}), kind, name, body } as never });
    const resetDefaults = async () => {
      for (const kind of ['invoice', 'offer', 'dunning', 'credit_note'] as const) await h.api.documentTemplates.setDefault({ kind, templateId: null });
    };

    test('every save appends a version; kind and body are validated', async () => {
      const v1 = await saveTemplate('invoice', `Klassisch ${uid()}`, klassisch());
      assert.equal(v1.version, 1);
      const v2 = await saveTemplate('invoice', v1.name, klassisch('#aa0000'), v1.id);
      const v3 = await saveTemplate('invoice', 'Umbenannt', klassisch('#00aa00'), v1.id);
      assert.deepEqual([v2.version, v3.version], [2, 3]);
      assert.equal(v3.createdAt, v1.createdAt);
      assert.equal(v3.name, 'Umbenannt');
      assert.equal(v3.body.accentColor, '#00aa00');
      const listed = (await h.api.documentTemplates.list({})).filter((template) => template.id === v1.id);
      assert.equal(listed.length, 1, 'the list shows the current version only');
      assert.equal(listed[0]!.version, 3);

      const body = klassisch();
      const post = (template: unknown) => h.raw('POST', '/document-templates', { template });
      assert.equal((await post({ id: v1.id, kind: 'offer', name: 'x', body })).status, 409, 'the kind of a template cannot change');
      assert.equal((await post({ kind: 'invoice', name: 'x', body: { ...body, accentColor: 'red' } })).status, 400);
      assert.equal((await post({ kind: 'invoice', name: '   ', body })).status, 400);
      assert.equal((await post({ kind: 'invoice', name: 'x'.repeat(121), body })).status, 400);
      assert.equal((await post({ kind: 'receipt', name: 'x', body })).status, 400);
      assert.equal((await post({ kind: 'invoice', name: 'x', body: { ...body, presetId: 'bunt' } })).status, 400);
      assert.equal((await post({ kind: 'invoice', name: 'x', body: { ...body, logo: { dataUrl: 'http://x/logo.png', position: 'left', widthMm: 30 } } })).status, 400);
      assert.equal((await h.api.documentTemplates.list({})).find((template) => template.id === v1.id)!.version, 3, 'rejected saves add no version');

      const offerTemplate = await saveTemplate('offer', `Angebot ${uid()}`, createDefaultTemplateBody('offer'));
      const invoiceOnly = await h.api.documentTemplates.list({ kind: 'invoice' });
      assert.ok(invoiceOnly.every((template) => template.kind === 'invoice'));
      assert.ok(!invoiceOnly.some((template) => template.id === offerTemplate.id));
    });

    test('there is one default per kind: a new default replaces the old one, deleting the template clears it', async () => {
      await resetDefaults();
      const first = await saveTemplate('invoice', `Standard ${uid()}`, klassisch());
      const second = await saveTemplate('invoice', `Zweite ${uid()}`, klassisch('#123456'));
      const offer = await saveTemplate('offer', `Angebot ${uid()}`, createDefaultTemplateBody('offer'));
      assert.deepEqual(await h.api.documentTemplates.getDefaults(), {});

      await h.api.documentTemplates.setDefault({ kind: 'invoice', templateId: first.id });
      await h.api.documentTemplates.setDefault({ kind: 'offer', templateId: offer.id });
      assert.deepEqual(await h.api.documentTemplates.getDefaults(), { invoice: first.id, offer: offer.id });
      await h.api.documentTemplates.setDefault({ kind: 'invoice', templateId: second.id });
      assert.deepEqual(await h.api.documentTemplates.getDefaults(), { invoice: second.id, offer: offer.id }, 'still one default per kind');

      assert.equal((await h.raw('PUT', '/document-templates/defaults', { kind: 'invoice', templateId: offer.id })).status, 404, 'a template of another kind cannot become the default');
      assert.equal((await h.raw('PUT', '/document-templates/defaults', { kind: 'invoice', templateId: 'gibt-es-nicht' })).status, 404);
      assert.equal((await h.raw('PUT', '/document-templates/defaults', { kind: 'brief', templateId: first.id })).status, 400);
      assert.deepEqual(await h.api.documentTemplates.getDefaults(), { invoice: second.id, offer: offer.id }, 'refused changes leave the defaults alone');

      await h.api.documentTemplates.delete({ id: second.id });
      assert.deepEqual(await h.api.documentTemplates.getDefaults(), { offer: offer.id }, 'deleting the default template clears it');
      await h.api.documentTemplates.setDefault({ kind: 'offer', templateId: null });
      assert.deepEqual(await h.api.documentTemplates.getDefaults(), {});
      await h.api.documentTemplates.delete({ id: first.id });
      await h.api.documentTemplates.delete({ id: offer.id });
      await h.api.documentTemplates.delete({ id: randomUUID() });
    });

    test('a template of another kind is never used, and the document layout round-trips on a draft', async () => {
      await resetDefaults();
      const offerTemplate = await saveTemplate('offer', `Nur Angebot ${uid()}`, { ...createDefaultTemplateBody('offer'), accentColor: '#ff0000' });
      const invoiceTemplate = await saveTemplate('invoice', `Rechnung ${uid()}`, klassisch('#112233'));
      try {
        const draft = await draftInvoice(h.api, { client: `Layout ${uid()}` });
        const withLayout = await h.api.invoices.upsert({ reason: 'Layout', invoice: { ...draft, layout: { templateId: offerTemplate.id, texts: { intro: 'Hallo Intro', closing: 'Tschüss' } } } });
        assert.deepEqual(withLayout.layout, { templateId: offerTemplate.id, texts: { intro: 'Hallo Intro', closing: 'Tschüss' } });
        assert.deepEqual((await h.api.invoices.list()).find((invoice) => invoice.id === draft.id)!.layout, withLayout.layout);

        const wrongKind = await h.api.documents.renderContext({ kind: 'invoice', id: draft.id });
        assert.equal(wrongKind.templateKind, 'invoice');
        assert.equal(wrongKind.template.id, undefined, 'the offer template named by the layout is ignored');
        assert.deepEqual(wrongKind.template.body, createDefaultTemplateBody('invoice'), 'without an invoice default the preset renders');
        assert.deepEqual(wrongKind.texts, { intro: 'Hallo Intro', closing: 'Tschüss' }, 'the text overrides still apply');

        await h.api.documentTemplates.setDefault({ kind: 'invoice', templateId: invoiceTemplate.id });
        const withDefault = await h.api.documents.renderContext({ kind: 'invoice', id: draft.id });
        assert.equal(withDefault.template.id, invoiceTemplate.id);
        assert.equal(withDefault.template.body.accentColor, '#112233');

        const own = await h.api.invoices.upsert({ reason: 'eigene Vorlage', invoice: { ...withLayout, layout: { templateId: invoiceTemplate.id } } });
        assert.equal((await h.api.documents.renderContext({ kind: 'invoice', id: own.id })).template.id, invoiceTemplate.id, 'a per-document choice of the right kind is honoured');

        const offer = await draftOffer(h.api, { client: `Angebot ${uid()}` });
        await h.api.documentTemplates.setDefault({ kind: 'offer', templateId: offerTemplate.id });
        const offerContext = await h.api.documents.renderContext({ kind: 'offer', id: offer.id });
        assert.equal(offerContext.templateKind, 'offer');
        assert.equal(offerContext.template.id, offerTemplate.id);

        const issued = await issueInvoice(h.api, { client: `Storno ${uid()}` });
        const credit = await h.api.documents.chainIssue({ operation: 'correction', id: randomUUID(), invoiceId: issued.id, kind: 'credit_note', amount: 10, date: today(), dueDate: today(), reason: 'Teilgutschrift' } as never);
        await h.api.invoices.upsert({ reason: 'Layout', invoice: { ...credit, layout: { templateId: invoiceTemplate.id } } }).catch(() => undefined);
        const creditContext = await h.api.documents.renderContext({ kind: 'invoice', id: credit.id });
        assert.equal(creditContext.templateKind, 'credit_note');
        assert.notEqual(creditContext.template.id, invoiceTemplate.id, 'an invoice template is never used for a credit note');
        assert.deepEqual(creditContext.source, { number: issued.number, date: issued.date, documentKind: 'invoice' });
      } finally {
        await resetDefaults();
      }
    });

    test('a draft follows template and company changes, an issued invoice freezes both', async () => {
      await resetDefaults();
      const template = await saveTemplate('invoice', `Frieren ${uid()}`, klassisch('#aa0000'));
      await h.api.documentTemplates.setDefault({ kind: 'invoice', templateId: template.id });
      try {
        await withSettings((s) => ({
          ...s,
          company: { ...s.company, name: 'Firma Alt' },
          finance: { ...s.finance, iban: 'DE89370400440532013000', bankName: 'Bank Alt' },
        }), async () => {
          const draft = await draftInvoice(h.api, { client: `Entwurf ${uid()}` });
          const issued = await issueInvoice(h.api, { client: `Gestellt ${uid()}` });
          assert.equal(issued.layout!.snapshot!.templateId, template.id);
          assert.equal(issued.layout!.snapshot!.templateVersion, 1);

          const draftBefore = await h.api.documents.renderContext({ kind: 'invoice', id: draft.id });
          const issuedBefore = await h.api.documents.renderContext({ kind: 'invoice', id: issued.id });
          assert.equal(draftBefore.settings!.company.name, 'Firma Alt');
          assert.equal(issuedBefore.settings!.finance.iban, 'DE89370400440532013000');
          assert.equal(draft.layout?.snapshot, undefined, 'a draft carries no snapshot');

          await setSettings({
            ...(await getSettings()),
            company: { ...(await getSettings()).company, name: 'Firma Neu' },
            finance: { ...(await getSettings()).finance, iban: 'DE02120300000000202051', bankName: 'Bank Neu' },
          });
          await saveTemplate('invoice', template.name, klassisch('#00aa00'), template.id);

          const draftAfter = await h.api.documents.renderContext({ kind: 'invoice', id: draft.id });
          assert.equal(draftAfter.settings!.company.name, 'Firma Neu', 'a draft follows the company data');
          assert.equal(draftAfter.settings!.finance.iban, 'DE02120300000000202051');
          assert.equal(draftAfter.template.version, 2, 'a draft follows the template');
          assert.equal(draftAfter.template.body.accentColor, '#00aa00');

          const issuedAfter = await h.api.documents.renderContext({ kind: 'invoice', id: issued.id });
          assert.equal(issuedAfter.settings!.company.name, 'Firma Alt', 'the issued invoice keeps its sender');
          assert.equal(issuedAfter.settings!.finance.iban, 'DE89370400440532013000');
          assert.equal(issuedAfter.settings!.finance.bankName, 'Bank Alt');
          assert.equal(issuedAfter.template.version, 1, 'the issued invoice keeps its template version');
          assert.equal(issuedAfter.template.body.accentColor, '#aa0000');
          assert.deepEqual(issuedAfter.template.body, issuedBefore.template.body);

          const laterIssued = await h.api.invoices.upsert({ reason: 'stellen', invoice: { ...draft, status: 'open' } });
          assert.equal(laterIssued.layout!.snapshot!.templateVersion, 2, 'a draft freezes the template as it is when it is issued');
          assert.equal(laterIssued.layout!.snapshot!.sender.company && (laterIssued.layout!.snapshot!.sender.company as { name: string }).name, 'Firma Neu');

          await h.api.documentTemplates.delete({ id: template.id });
          const afterDelete = await h.api.documents.renderContext({ kind: 'invoice', id: issued.id });
          assert.equal(afterDelete.template.version, 1, 'deleting the template does not change an issued invoice');
          assert.equal(afterDelete.template.body.accentColor, '#aa0000');
        });
      } finally {
        await resetDefaults();
      }
    });

    test('a layout snapshot sent by a client is ignored and an issued invoice keeps its own', async () => {
      await resetDefaults();
      const template = await saveTemplate('invoice', `Echt ${uid()}`, klassisch('#123456'));
      await h.api.documentTemplates.setDefault({ kind: 'invoice', templateId: template.id });
      try {
        const draft = await draftInvoice(h.api, { client: `Fälschung ${uid()}` });
        const forgedSnapshot = { templateId: 'gefälscht', templateVersion: 9, sender: { company: { name: 'Gefälscht' } }, frozenAt: new Date().toISOString() };
        const issued = await h.api.invoices.upsert({ reason: 'stellen', invoice: { ...draft, status: 'open', layout: { snapshot: forgedSnapshot } as never } });
        assert.equal(issued.layout!.snapshot!.templateId, template.id, 'the sent snapshot is replaced by the server one');
        assert.notEqual((issued.layout!.snapshot!.sender.company as { name: string }).name, 'Gefälscht');

        const again = await h.api.invoices.upsert({ reason: 'noch einmal', invoice: { ...issued, layout: { snapshot: { ...forgedSnapshot, templateId: 'noch-eine-fälschung' } } as never } });
        assert.deepEqual(again.layout!.snapshot, issued.layout!.snapshot, 'a frozen snapshot is never replaced');
        const rewritten = await h.api.invoices.upsert({ reason: 'ohne Layout', invoice: { ...issued, layout: undefined } });
        assert.deepEqual(rewritten.layout!.snapshot, issued.layout!.snapshot, 'a writer without layout cannot drop it either');
      } finally {
        await resetDefaults();
      }
    });

    test('an issued invoice without any template is frozen on the shipped preset, which never appears in the template list', async () => {
      await resetDefaults();
      const issued = await issueInvoice(h.api, { client: `Preset ${uid()}` });
      assert.match(issued.layout!.snapshot!.templateId, /^preset-.*-invoice$/);
      assert.equal(issued.layout!.snapshot!.templateVersion, 1);
      const context = await h.api.documents.renderContext({ kind: 'invoice', id: issued.id });
      assert.deepEqual(context.template.body, createDefaultTemplateBody('invoice'));
      assert.ok(!(await h.api.documentTemplates.list({})).some((template) => template.id.startsWith('preset-')));
      const second = await issueInvoice(h.api, { client: `Preset 2 ${uid()}` });
      assert.equal(second.layout!.snapshot!.templateVersion, 1, 'the unchanged preset body keeps its version');
    });

    test('the dunning letter claims Verzugszinsen and, from a business, the 40 € Pauschale (§288 BGB)', async () => {
      const levels = [
        { id: 1, name: 'Zahlungserinnerung', enabled: true, daysAfterDueDate: 7, fee: 0, subject: 'Erinnerung %N', text: '' },
        { id: 2, name: '1. Mahnung', enabled: true, daysAfterDueDate: 14, fee: 5, subject: '1. Mahnung %N', text: '', chargeInterest: true, chargeFlatFee: true },
      ];
      await withSettings((s) => ({ ...s, dunning: { levels, baseInterestRatePercent: 1.27 } }), async () => {
        const business = await issueInvoice(h.api, { client: `Zins GmbH ${uid()}`, date: addDays(today(), -40), dueDate: addDays(today(), -20), taxMeta: { buyerType: 'business' } as never });
        await h.api.invoices.savePayment({ invoiceId: business.id, payment: { id: randomUUID(), date: today(), amount: 50, method: 'bank' }, reason: 'Teilzahlung' });
        const letter = (await h.api.documents.renderContext({ kind: 'dunning', id: business.id, level: 2 })).dunning!;
        const open = business.amount - 50;
        assert.deepEqual(
          { fee: letter.fee, flatFee: letter.flatFee, rate: letter.interestRatePercent, days: letter.interestDays, interest: letter.interest },
          { fee: 40, flatFee: true, rate: 10.27, days: 20, interest: Math.round(open * 0.1027 * 20 / 365 * 100) / 100 },
          'business: base + 9 points from the day after the due date, Pauschale instead of the 5 € fee',
        );

        const consumer = await issueInvoice(h.api, { client: `Zins Privat ${uid()}`, date: addDays(today(), -40), dueDate: addDays(today(), -20) });
        const private_ = (await h.api.documents.renderContext({ kind: 'dunning', id: consumer.id, level: 2 })).dunning!;
        assert.deepEqual({ fee: private_.fee, flatFee: private_.flatFee, rate: private_.interestRatePercent, days: private_.interestDays }, { fee: 5, flatFee: undefined, rate: 6.27, days: 0 },
          'a consumer: base + 5 points, and only from a first reminder — without one there is no default yet');
      });
    });

    test('the dunning letter is built from the level, its fee, the payments so far and the dunning template', async () => {
      await resetDefaults();
      const levels = [
        { id: 1, name: 'Zahlungserinnerung', enabled: true, daysAfterDueDate: 7, fee: 0, subject: 'Erinnerung %N', text: 'Die Rechnung %N vom %D ist noch offen.' },
        { id: 2, name: '1. Mahnung', enabled: true, daysAfterDueDate: 14, fee: 5, subject: '1. Mahnung %N', text: 'Erste Mahnung zur Rechnung %N.' },
        { id: 3, name: '2. Mahnung', enabled: true, daysAfterDueDate: 21, fee: 10, subject: '2. Mahnung %N', text: '' },
      ];
      const dunningTemplate = await saveTemplate('dunning', `Mahnung ${uid()}`, { ...createDefaultTemplateBody('dunning'), accentColor: '#abcdef' });
      await h.api.documentTemplates.setDefault({ kind: 'dunning', templateId: dunningTemplate.id });
      try {
        await withSettings((s) => ({ ...s, dunning: { levels } }), async () => {
          const invoice = await issueInvoice(h.api, { client: `Mahnung ${uid()}`, date: addDays(today(), -40), dueDate: addDays(today(), -20) });
          await h.api.invoices.savePayment({ invoiceId: invoice.id, payment: { id: randomUUID(), date: today(), amount: 50, method: 'bank' }, reason: 'Teilzahlung' });
          // A partial credit note reduces what the letter demands, like a payment.
          await h.api.documents.chainIssue({ operation: 'correction', id: randomUUID(), invoiceId: invoice.id, kind: 'credit_note', amount: 23.8, date: today(), dueDate: today(), reason: 'Teilgutschrift' } as never);

          const first = await h.api.documents.renderContext({ kind: 'dunning', id: invoice.id });
          assert.equal(first.templateKind, 'dunning');
          assert.equal(first.template.id, dunningTemplate.id);
          assert.equal(first.template.body.accentColor, '#abcdef');
          assert.deepEqual(first.dunning, { level: 1, levelName: 'Zahlungserinnerung', date: today(), payUntil: addDays(today(), 7), fee: 0, originalAmount: invoice.amount, paidAmount: 50, creditedAmount: 23.8, daysOverdue: 20 });
          assert.equal(first.texts!.intro, 'Sehr geehrte Damen und Herren,\n\nDie Rechnung {{invoice.number}} vom {{invoice.date}} ist noch offen.\n\nBitte überweisen Sie den offenen Betrag bis zum {{dunning.payUntil}}.');
          assert.equal(first.document.id, invoice.id);

          const second = await h.api.documents.renderContext({ kind: 'dunning', id: invoice.id, level: 2 });
          assert.equal(second.dunning!.level, 2);
          assert.equal(second.dunning!.levelName, '1. Mahnung');
          assert.equal(second.dunning!.fee, 5, 'a preview of a level not yet run shows that level\'s fee');
          assert.equal(second.dunning!.originalAmount, invoice.amount);
          assert.match(second.texts!.intro!, /Erste Mahnung zur Rechnung \{\{invoice\.number\}\}/);

          const third = await h.api.documents.renderContext({ kind: 'dunning', id: invoice.id, level: 3 });
          assert.equal(third.dunning!.fee, 10);
          assert.equal(third.texts, undefined, 'a level without text prints no intro override');
        });
        const offer = await draftOffer(h.api, { client: `Kein Mahnbeleg ${uid()}` });
        assert.equal((await h.raw('GET', `/documents/dunning/${offer.id}/render-context`)).status, 404, 'only invoices can be dunned');
      } finally {
        await resetDefaults();
      }
    });

    test('render-context refuses unknown documents, wrong kinds and bad levels', async () => {
      const invoice = await issueInvoice(h.api, { client: `Kontext ${uid()}` });
      const offer = await draftOffer(h.api, { client: `Kontext Angebot ${uid()}` });
      assert.equal((await h.raw('GET', `/documents/invoice/${randomUUID()}/render-context`)).status, 404);
      assert.equal((await h.raw('GET', `/documents/invoice/${offer.id}/render-context`)).status, 404, 'an offer id is not an invoice');
      assert.equal((await h.raw('GET', `/documents/offer/${invoice.id}/render-context`)).status, 404, 'an invoice id is not an offer');
      assert.equal((await h.raw('GET', `/documents/receipt/${invoice.id}/render-context`)).status, 400);
      assert.equal((await h.raw('GET', `/documents/dunning/${invoice.id}/render-context?level=0`)).status, 400);
      assert.equal((await h.raw('GET', `/documents/dunning/${invoice.id}/render-context?level=eins`)).status, 400);
      assert.equal((await h.raw('GET', `/documents/invoice/${invoice.id}/render-context`)).status, 200);
    });
  });

  describe('audit log', () => {
    test('the chain verifies and the CSV has the documented columns, hash links and actor', async () => {
      const created = await makeClient({ company: `Protokoll ${uid()}` });
      await issueInvoice(h.api, { client: created.company, clientId: created.id });
      const verification = await h.api.audit.verify();
      assert.equal(verification.ok, true, JSON.stringify(verification));
      assert.deepEqual(verification.errors, []);
      assert.match(verification.headHash ?? '', /^[0-9a-f]{64}$/);

      const response = await fetch(`${h.connection.baseUrl}/api/v1/${product}/audit/export.csv`, { headers: { 'x-billme-local-token': h.connection.token } });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^text\/csv/);
      assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename="audit\.csv"/);
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM for spreadsheet tools');
      const text = new TextDecoder().decode(bytes);

      const [header, ...rows] = parseCsv(text);
      assert.deepEqual(header, AUDIT_COLUMNS);
      assert.equal(rows.length, verification.count, 'every audited change is exported');
      rows.forEach((row, index) => {
        assert.equal(row.length, AUDIT_COLUMNS.length);
        assert.equal(Number(row[0]), index + 1, 'sequence is gap-free');
        assert.match(row[7]!, /^[0-9a-f]{64}$/);
        assert.equal(row[6], index === 0 ? '' : rows[index - 1]![7], 'each row points at the hash of the one before');
        assert.ok(row[5], `row ${index + 1} has a reason`);
        assert.equal(JSON.parse(row[8]!).type, 'user');
      });
      assert.equal(rows.at(-1)![7], verification.headHash);

      const creation = rows.find((row) => row[3] === created.id && row[4] === 'client.create')!;
      assert.equal(creation[2], 'client');
      assert.equal(creation[9], 'null', 'a creation has no before state');
      assert.equal(JSON.parse(creation[10]!).company, created.company);
      assert.ok(rows.some((row) => row[2] === 'invoice' && row[4] === 'invoice.create'));
    });
  });

  describe('access', () => {
    test('master data and the audit log are not readable without the local token', async () => {
      const paths = ['/clients', '/projects', '/articles', '/settings', '/document-templates', '/document-templates/defaults', '/audit/verify', '/audit/export.csv', '/recurring'];
      for (const path of paths) {
        const anonymous = await fetch(`${h.connection.baseUrl}/api/v1/${product}${path}`);
        assert.equal(anonymous.status, 401, path);
        const forged = await fetch(`${h.connection.baseUrl}/api/v1/${product}${path}`, { headers: { 'x-billme-local-token': 'falsch' } });
        assert.equal(forged.status, 401, `${path} with a wrong token`);
      }
      const write = await fetch(`${h.connection.baseUrl}/api/v1/${product}/clients`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'x', client: newClient() }) });
      assert.equal(write.status, 401);
      const put = await fetch(`${h.connection.baseUrl}/api/v1/${product}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: await getSettings() }) });
      assert.equal(put.status, 401);
      assert.equal((await fetch(`${h.connection.baseUrl}/health`)).status, 200, 'only /health is open');
    });
  });
});

for (const product of PRODUCTS) test(`master data, templates, frozen layouts and counters survive an app restart (${product})`, async (t) => {
  const first = await startProduct(product, null, 'masterdata-restart');
  const owner = await first.api.clients.upsert({ client: newClient({ company: 'Neustart GmbH', taxProfile: { type: 'business', countryCode: 'DE', vatId: 'DE123456789' }, contacts: [{ id: 'r-1', name: 'Rita Rückruf', isPrimary: false }, { id: 'r-2', name: 'Paul Primär', role: 'GF', isPrimary: true }] }) as never });
  await first.api.clients.upsert({ client: newClient({ company: 'Manuell', customerNumber: 'KD-0007' }) as never });
  const project = await first.api.projects.upsert({ reason: 'neu', project: { id: randomUUID(), clientId: owner.id, name: 'Vor Neustart', status: 'active', budget: 123.45, startDate: '2026-04-01' } as never });
  const article = await first.api.articles.upsert({ article: { id: randomUUID(), title: 'Neustart-Artikel', description: '', price: 12.5, unit: 'Std.', category: 'x', taxRate: 7 } });
  const settings = (await first.api.settings.get())!;
  await first.api.settings.set({ settings: { ...settings, company: { ...settings.company, name: 'Neustart Firma' }, finance: { ...settings.finance, iban: 'DE89370400440532013000' } } });
  const body = createDefaultTemplateBody('invoice', 'klassisch');
  const template = await first.api.documentTemplates.upsert({ template: { kind: 'invoice', name: 'Neustart-Vorlage', body } });
  await first.api.documentTemplates.upsert({ template: { id: template.id, kind: 'invoice', name: 'Neustart-Vorlage', body: { ...body, accentColor: '#654321' } } });
  await first.api.documentTemplates.setDefault({ kind: 'invoice', templateId: template.id });
  const issued = await issueInvoice(first.api, { client: owner.company, clientId: owner.id });
  const frozenBefore = await first.api.documents.renderContext({ kind: 'invoice', id: issued.id });
  const auditBefore = await first.api.audit.verify();
  await first.close({ keepData: true });

  const second = await startProduct(product, t, 'masterdata-restart', first.userDataPath);
  const clients = await second.api.clients.list();
  assert.equal(clients.find((client) => client.id === owner.id)!.customerNumber, owner.customerNumber);
  assert.deepEqual(clients.find((client) => client.id === owner.id)!.taxProfile, { type: 'business', countryCode: 'DE', vatId: 'DE123456789' });
  assert.deepEqual(clients.find((client) => client.id === owner.id)!.contacts, [{ id: 'r-1', name: 'Rita Rückruf', isPrimary: false }, { id: 'r-2', name: 'Paul Primär', role: 'GF', isPrimary: true }]);
  assert.equal(clients.find((client) => client.id === owner.id)!.contactPerson, 'Paul Primär');
  assert.equal(clients.find((client) => client.company === 'Manuell')!.customerNumber, 'KD-0007');
  assert.deepEqual((await second.api.projects.get({ id: project.id }))!.budget, 123.45);
  assert.equal((await second.api.articles.list()).find((candidate) => candidate.id === article.id)!.taxRate, 7);
  const restored = (await second.api.settings.get())!;
  assert.equal(restored.company.name, 'Neustart Firma');
  assert.equal(restored.finance.iban, 'DE89370400440532013000');

  const templates = await second.api.documentTemplates.list({});
  assert.equal(templates.find((candidate) => candidate.id === template.id)!.version, 2);
  assert.deepEqual(await second.api.documentTemplates.getDefaults(), { invoice: template.id });
  const frozenAfter = await second.api.documents.renderContext({ kind: 'invoice', id: issued.id });
  assert.deepEqual(frozenAfter.template, frozenBefore.template, 'the frozen template survives the restart');
  assert.deepEqual(frozenAfter.settings, frozenBefore.settings, 'and so does the frozen sender');
  assert.equal(frozenAfter.template.version, 2, 'frozen at the version that was current when the invoice was issued');

  const next = await second.api.clients.upsert({ client: newClient({ company: 'Nach Neustart' }) as never });
  assert.notEqual(next.customerNumber, owner.customerNumber);
  assert.ok(sequenceOf(next.customerNumber!) > sequenceOf(owner.customerNumber!), 'numbering continues after the restart');
  const verification = await second.api.audit.verify();
  assert.equal(verification.ok, true);
  assert.ok(verification.count > auditBefore.count - 1);
});
