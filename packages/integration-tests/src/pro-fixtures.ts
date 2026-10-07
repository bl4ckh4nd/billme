import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PgliteServerDatabase } from '@billme/server-data';
import type { ProHarness } from './harness.js';
import { draftInvoice, issueInvoice, today, type DocumentInput } from './fixtures.js';

/**
 * Helpers for the Pro accounting suites. They go through the same HTTP surface
 * the Pro renderer uses; the only back door is `withDatabase`, for the one
 * state no route can produce (a closed accounting period).
 */
export type JournalLine = {
  id: string;
  accountNumber: string;
  debitAmount: number;
  creditAmount: number;
  taxCaseKey?: string;
  taxRate?: number;
  netAmount?: number;
  taxAmount?: number;
  grossAmount?: number;
  memo?: string;
  evidenceType?: string;
  evidenceReference?: string;
};
export type JournalEntry = {
  id: string;
  entryNumber: number;
  postingDate: string;
  documentDate?: string;
  bookingText: string;
  reference?: string;
  period: string;
  fiscalYear: number;
  status: 'posted' | 'reversed' | 'draft';
  sourceType?: string;
  sourceKey?: string;
  sourceDraftId?: string;
  reversedEntryId?: string;
  lines: JournalLine[];
};
export type OpenItem = {
  id: string;
  partyType: 'debtor' | 'creditor';
  partyId: string;
  sourceType: string;
  sourceId: string;
  documentNumber: string;
  documentDate: string;
  dueDate: string;
  originalAmount: number;
  allocatedAmount: number;
  residualAmount: number;
  status: 'open' | 'partially_paid' | 'paid' | 'overpaid' | 'unresolved';
  journalEntryId?: string;
};
export type Draft = {
  id: string;
  transactionId: string;
  workflowStatus: string;
  postingDate?: string;
  documentDate?: string;
  bookingText: string;
  period: string;
  fiscalYear: number;
  lines: Array<{ id: string; accountNumber: string; debitAmount: number; creditAmount: number; [key: string]: unknown }>;
  validationIssues: Array<{ code: string; blocking: boolean }>;
};

export const cents = (value: number): number => Math.round(value * 100);
export const money = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

/** Pro invoices take the Lite helper's input; only the client type differs. */
export const issue = (h: ProHarness, input: DocumentInput = {}) => issueInvoice(h.api as never, input);
export const draft = (h: ProHarness, input: DocumentInput = {}) => draftInvoice(h.api as never, input);

export const get = async <T = any>(h: ProHarness, path: string): Promise<T> => {
  const response = await h.raw('GET', path);
  assert.equal(response.status, 200, `${path}: ${response.text}`);
  return response.body as T;
};

export const journal = (h: ProHarness): Promise<JournalEntry[]> => get(h, '/accounting/journal?limit=5000');
export const openItems = (h: ProHarness): Promise<OpenItem[]> => get(h, '/accounting/open-items');

export const sumSides = (entry: Pick<JournalEntry, 'lines'>) => ({
  debit: entry.lines.reduce((sum, line) => sum + cents(line.debitAmount), 0),
  credit: entry.lines.reduce((sum, line) => sum + cents(line.creditAmount), 0),
});

/** The invariant of double-entry bookkeeping: every entry balances to the cent. */
export const assertBalanced = (entries: JournalEntry[], label = 'journal'): void => {
  for (const entry of entries) {
    const { debit, credit } = sumSides(entry);
    assert.equal(debit, credit, `${label}: entry ${entry.entryNumber} (${entry.bookingText}) is unbalanced (${debit} vs ${credit})`);
    assert.ok(debit > 0, `${label}: entry ${entry.entryNumber} is empty`);
  }
};

/** The ledger as a whole nets to zero and agrees with the journal it is built from. */
export const assertLedgerConsistent = async (h: ProHarness): Promise<void> => {
  const entries = await journal(h);
  assertBalanced(entries);
  const balances = await get<Array<{ accountNumber: string; closingBalance: number; debitTurnover: number; creditTurnover: number }>>(h, '/accounting/balances');
  assert.equal(balances.reduce((sum, row) => sum + cents(row.closingBalance), 0), 0, 'closing balances must net to zero');
  const expected = new Map<string, number>();
  for (const entry of entries) for (const line of entry.lines) expected.set(line.accountNumber, (expected.get(line.accountNumber) ?? 0) + cents(line.debitAmount) - cents(line.creditAmount));
  for (const row of balances) assert.equal(cents(row.closingBalance), expected.get(row.accountNumber) ?? 0, `balance of ${row.accountNumber} disagrees with the journal`);
};

export const entryFor = async (h: ProHarness, sourceKey: string): Promise<JournalEntry | undefined> =>
  (await journal(h)).find((entry) => entry.sourceKey === sourceKey);

export const invoiceEntry = (h: ProHarness, invoiceId: string) => entryFor(h, `outgoing-invoice:${invoiceId}`);

export const shape = (entry: JournalEntry): Array<[string, number, number]> =>
  entry.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]);

/** A fresh bank account in the Pro product (Pro accounts carry a default SKR account). */
export const addBankAccount = async (h: ProHarness, id: string = `bank-${randomUUID().slice(0, 8)}`, skr = '1200'): Promise<string> => {
  await h.api.accounts.upsert({ account: { id, name: `Konto ${id}`, iban: 'DE02120300000000202051', balance: 0, transactions: [], type: 'bank', color: '#000000', defaultSkrAccountNumber: skr } } as never);
  return id;
};

export type CsvRow = { date: string; amount: number; counterparty: string; purpose: string };
export const bankCsv = (rows: CsvRow[]): string =>
  ['Datum;Betrag;Empfänger;Verwendungszweck', ...rows.map((row) => `${row.date};${row.amount.toFixed(2).replace('.', ',')};${row.counterparty};${row.purpose}`)].join('\n');

/** Upload + commit exactly as the import dialog does. */
export const importCsv = async (h: ProHarness, accountId: string, rows: CsvRow[], fileName = `bank-${randomUUID().slice(0, 6)}.csv`) => {
  const preview = await h.raw('POST', '/finance/import/preview', { fileName, contentBase64: Buffer.from(bankCsv(rows), 'utf8').toString('base64'), profile: 'generic' });
  assert.equal(preview.status, 200, preview.text);
  const commit = await h.raw('POST', '/finance/import/commit', { path: preview.body.path, accountId, profile: 'generic', mapping: preview.body.suggestedMapping });
  assert.equal(commit.status, 200, commit.text);
  return { preview: preview.body, commit: commit.body as { batchId: string; imported: number; skipped: number; errors: unknown[]; fileSha256: string } };
};

export type BankTx = { id: string; date: string; amount: number; type: 'income' | 'expense'; counterparty: string; purpose: string; status: 'pending' | 'booked'; accountId: string; linkedInvoiceId?: string; suggestedAccountNumber?: string; suggestionLayer?: string; suggestionReason?: string };
/** The Pro bank workbench list (ids differ from the legacy `/transactions` list). Never index it, it is sorted by date. */
export const bankTransactions = (h: ProHarness): Promise<BankTx[]> => get(h, '/accounting/transactions');
export const bankTx = async (h: ProHarness, counterparty: string): Promise<BankTx> => {
  const found = (await bankTransactions(h)).find((tx) => tx.counterparty === counterparty);
  assert.ok(found, `bank transaction for ${counterparty} not found`);
  return found;
};

export const getDraft = (h: ProHarness, transactionId: string): Promise<Draft> => get(h, `/accounting/drafts/${transactionId}`);

export const saveDraft = (h: ProHarness, value: Draft, lines: Draft['lines'], overrides: Record<string, unknown> = {}) =>
  h.raw('POST', '/accounting/drafts', { reason: 'Buchung bearbeitet', draft: { ...value, workflowStatus: 'suggested', lines, ...overrides } });

export const draftAction = (h: ProHarness, transactionId: string, action: string, reason = 'Workflow') =>
  h.raw('POST', `/accounting/drafts/${transactionId}/action`, { reason, action });

/** imported → saved → pending_approval → approved, the way the workbench walks it. */
export const approveDraft = async (h: ProHarness, value: Draft, lines: Draft['lines'], overrides: Record<string, unknown> = {}): Promise<Draft> => {
  const saved = await saveDraft(h, value, lines, overrides);
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.body.validationIssues, [], `draft not clean: ${saved.text}`);
  const submitted = await draftAction(h, value.transactionId, 'submit_for_review');
  assert.equal(submitted.status, 200, submitted.text);
  const approved = await draftAction(h, value.transactionId, 'approve');
  assert.equal(approved.status, 200, approved.text);
  return approved.body;
};

export const postDraft = (h: ProHarness, draftId: string, body: Record<string, unknown> = {}) =>
  h.raw('POST', `/accounting/drafts/${draftId}/post`, { reason: 'Buchen', ...body });

export const payOpenItem = (h: ProHarness, item: Pick<OpenItem, 'id' | 'partyId' | 'partyType'>, amount: number, extra: Record<string, unknown> = {}, allocate: number = amount) =>
  h.raw('POST', '/accounting/open-items/payments', {
    reason: 'Zahlungseingang',
    payment: {
      sourceType: 'manual',
      sourceId: `pay-${randomUUID()}`,
      partyType: item.partyType,
      paymentDate: today(),
      amount,
      bankAccountNumber: '1200',
      allocations: [{ openItemId: item.id, amount: allocate }],
      allocationEventId: `event-${randomUUID()}`,
      ...extra,
    },
  });

/** Opens the Pro data directory directly. Only for state with no HTTP route (closed periods). Stop the backend first. */
export const withDatabase = async <T>(userDataPath: string, work: (database: PgliteServerDatabase) => Promise<T>): Promise<T> => {
  const database = await PgliteServerDatabase.open(join(userDataPath, 'billme-pro-pglite'));
  try { return await work(database); } finally { await database.close(); }
};

export const setPeriodStatus = (database: PgliteServerDatabase, tenantId: string, period: string, status: 'open' | 'soft_locked' | 'closed') => {
  const stamp = new Date().toISOString();
  const end = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10);
  return database.query(
    `INSERT INTO accounting_periods (id,tenant_id,period,fiscal_year,status,starts_at,ends_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
     ON CONFLICT (tenant_id,period) DO UPDATE SET status=EXCLUDED.status,updated_at=EXCLUDED.updated_at`,
    [randomUUID(), tenantId, period, Number(period.slice(0, 4)), status, `${period}-01`, end, stamp],
  );
};

/** Raw bytes of a download. `raw()` decodes as UTF-8, which would corrupt a cp1252 DATEV file. */
export const download = async (h: ProHarness, path: string) => {
  const response = await fetch(`${h.connection.baseUrl}${path}`, { headers: { 'x-billme-local-token': h.connection.token } });
  return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
};

export const PRO_TENANT = 'billme-pro-local-tenant';
