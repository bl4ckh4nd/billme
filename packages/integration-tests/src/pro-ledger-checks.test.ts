import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPro } from './harness.js';
import { get } from './pro-fixtures.js';

/**
 * Checks on the journal and business partners (GET /pro/accounting/analytics/checks, /partners), through the HTTP
 * surface of the embedded backend, on an imported SKR03 journal with one case per check.
 *
 * How this can fail:
 * - a check that misses its case, or reports a correct entry (a 19 % expense of a German supplier, a refund that
 *   lowers the expense, a transfer that is balanced in its month)
 * - a finding marked OK that still counts as open, or that cannot be opened again; a dismissal without a reason
 * - partners: an own transfer listed as a partner, two bookings of one payee as two partners
 */

type Checks = { openErrors: number; openWarnings: number; checks: Array<{ key: string; openCount: number; dismissedCount: number; findings: Array<{ subjectKey: string; reference?: string; dismissed?: { reason: string } }> }> };
type Partners = { partners: Array<{ name: string; income: number; expense: number; count: number }> };

test('every check finds its case, a finding can be marked OK and opened again, partners group the money movements', async (t) => {
  const h = await startPro(t, 'pro-ledger-checks');
  const csv = [
    'Buchung;Datum;Belegnr;Buchungstext;Konto;Soll;Haben;Steuerfall',
    '1;05.01.2026;ER-AWS;AWS Emea aws.amazon USD;4920;119,00;;VSt19',
    '1;;;;1200;;119,00;',
    '2;06.01.2026;ER-VST;Papier Beispiel;4930;100,00;;',
    '2;;;;1576;19,00;;',
    '2;;;;1200;;119,00;',
    '3;07.01.2026;AR-OHNE;Kunde Beispiel GmbH, Umsatzart: Gutschrift;1200;500,00;;',
    '3;;;;8400;;500,00;',
    '4;08.01.2026;GS-ERL;Erstattung Beispiel Versand;1200;119,00;;',
    '4;;;;8400;;119,00;USt19',
    '5;10.01.2026;D-1;Strom Beispiel Energie;4210;80,00;;',
    '5;;;;1200;;80,00;',
    '6;12.01.2026;D-2;Strom Beispiel Energie;4210;80,00;;',
    '6;;;;1200;;80,00;',
    '7;15.01.2026;UB-1;Kreditkarte;1360;300,00;;',
    '7;;;;1200;;300,00;',
    '8;20.01.2026;OK-1;Bürobedarf Beispiel GmbH;4930;119,00;;VSt19',
    '8;;;;1200;;119,00;',
    '9;21.01.2026;PE-1;Privatentnahme;1800;50,00;;',
    '9;;;;1200;;50,00;',
  ].join('\n');
  const imported = await h.raw('POST', '/accounting/journal/import', { reason: 'Übernahme', format: 'journal_csv', contentBase64: Buffer.from(csv).toString('base64'), dryRun: false });
  assert.equal(imported.status, 200, imported.text);
  assert.equal(imported.body.postedCount, 9, JSON.stringify(imported.body.issues));
  const settings = await get<{ businessReportingProfile?: { legalForm?: string } }>(h, '/settings');
  const corporation = ['gmbh', 'ug'].includes(settings.businessReportingProfile?.legalForm ?? '');

  const checks = await get<Checks>(h, '/accounting/analytics/checks?from=2026-01-01&to=2026-01-31');
  const refs = (key: string) => checks.checks.find((check) => check.key === key)!.findings.map((finding) => finding.reference ?? finding.subjectKey);
  assert.deepEqual(refs('foreign_vat'), ['ER-AWS'], 'the German supplier with 19 % is no finding');
  assert.deepEqual(refs('vat_without_case'), ['ER-VST']);
  assert.deepEqual(refs('revenue_without_vat'), ['AR-OHNE']);
  assert.deepEqual(refs('refund_as_revenue'), ['GS-ERL'], 'the bank\'s "Umsatzart: Gutschrift" of an incoming payment is no refund');
  assert.deepEqual(refs('duplicate'), ['D-2'], 'the second of two equal payments');
  assert.deepEqual(refs('transit_open'), ['2026-01']);
  assert.deepEqual(refs('private_on_corporation'), corporation ? ['PE-1'] : []);
  assert.equal(checks.openErrors, 1 + (corporation ? 1 : 0));
  assert.equal(checks.openWarnings, 5);

  const subject = checks.checks.find((check) => check.key === 'foreign_vat')!.findings[0]!.subjectKey;
  assert.equal((await h.raw('POST', '/accounting/analytics/checks/dismissal', { checkKey: 'foreign_vat', subjectKey: subject, dismissed: true, reason: ' ' })).status, 400, 'a reason is required');
  const dismissed = await h.raw('POST', '/accounting/analytics/checks/dismissal', { checkKey: 'foreign_vat', subjectKey: subject, dismissed: true, reason: 'Rechnung mit deutscher USt-IdNr., kein § 13b' });
  assert.equal(dismissed.status, 200, dismissed.text);
  const after = (await get<Checks>(h, '/accounting/analytics/checks?from=2026-01-01&to=2026-01-31')).checks.find((check) => check.key === 'foreign_vat')!;
  assert.deepEqual([after.openCount, after.dismissedCount, after.findings[0]!.dismissed?.reason], [0, 1, 'Rechnung mit deutscher USt-IdNr., kein § 13b']);
  assert.equal((await h.raw('POST', '/accounting/analytics/checks/dismissal', { checkKey: 'foreign_vat', subjectKey: subject, dismissed: false, reason: 'Doch prüfen' })).status, 200);
  const reopened = (await get<Checks>(h, '/accounting/analytics/checks?from=2026-01-01&to=2026-01-31')).checks.find((check) => check.key === 'foreign_vat')!;
  assert.deepEqual([reopened.openCount, reopened.dismissedCount], [1, 0]);

  const partners = await get<Partners>(h, '/accounting/analytics/partners?from=2026-01-01&to=2026-01-31');
  const energy = partners.partners.find((partner) => partner.name === 'Strom Beispiel Energie');
  assert.deepEqual([energy?.expense, energy?.count], [160, 2], 'two payments, one partner');
  assert.ok(!partners.partners.some((partner) => partner.name === 'Kreditkarte'), 'an own transfer has no partner');
  assert.deepEqual(partners.partners.find((partner) => partner.name === 'Kunde Beispiel GmbH')?.income, 500, 'the payee ends before the bank\'s Umsatzart');
  const detail = await get<{ months: Array<{ period: string; expense: number }>; entries: Array<{ reference?: string }> }>(h, `/accounting/analytics/partners/detail?name=${encodeURIComponent('Strom Beispiel Energie')}`);
  assert.deepEqual(detail.months, [{ period: '2026-01', income: 0, expense: 160 }]);
  assert.deepEqual(detail.entries.map((entry) => entry.reference), ['D-2', 'D-1']);
});
