import type Database from 'better-sqlite3';
import { and, asc, desc, eq, like, or } from 'drizzle-orm';
import {
  buildAccountSuggestionContextFrom,
  normalizeSuggestionText as normalize,
  type AccountSuggestionContext,
} from '@billme/finance-intelligence';
import type { AccountSuggestionRule } from '@billme/accounting-shared';
import { createDrizzle, schema } from '@billme/desktop-data/drizzle';

// The scoring is shared with the server repository; this module only loads
// its inputs from the desktop SQLite store.
export {
  suggestAccountForTransaction,
  type AccountSuggestion,
  type AccountSuggestionContext,
  type AccountSuggestionLayer,
} from '@billme/finance-intelligence';

interface AccountKeywordRow {
  account_number: string;
  keyword: string;
}

const loadKeywords = (
  db: Database.Database,
  chart: 'SKR03' | 'SKR04',
  tenantId: string,
): Map<string, string[]> => {
  const rows = createDrizzle(db).select({ account_number: schema.accountKeywords.accountNumber, keyword: schema.accountKeywords.keyword })
    .from(schema.accountKeywords).where(and(
      eq(schema.accountKeywords.tenantId, tenantId),
      eq(schema.accountKeywords.chart, chart),
      eq(schema.accountKeywords.active, 1),
    )).all() as AccountKeywordRow[];

  const out = new Map<string, string[]>();
  for (const row of rows) {
    const key = normalize(row.keyword);
    if (!key) continue;
    const list = out.get(key) ?? [];
    if (!list.includes(row.account_number)) {
      list.push(row.account_number);
    }
    out.set(key, list);
  }
  return out;
};

const loadCounterpartyMemory = (
  db: Database.Database,
  chart: 'SKR03' | 'SKR04',
  tenantId: string,
): Map<string, string> => {
  const rows = createDrizzle(db).select({
    counterparty: schema.bankTransactions.counterparty,
    account_number: schema.journalLines.accountNumber,
    latest_at: schema.journalEntries.createdAt,
  }).from(schema.journalEntries)
    .innerJoin(schema.journalLines, and(eq(schema.journalLines.entryId, schema.journalEntries.id), eq(schema.journalLines.tenantId, schema.journalEntries.tenantId)))
    .innerJoin(schema.bookingDrafts, and(eq(schema.bookingDrafts.id, schema.journalEntries.sourceDraftId), eq(schema.bookingDrafts.tenantId, schema.journalEntries.tenantId)))
    .innerJoin(schema.bankTransactions, and(eq(schema.bankTransactions.id, schema.bookingDrafts.transactionId), eq(schema.bankTransactions.tenantId, schema.bookingDrafts.tenantId)))
    .innerJoin(schema.ledgerAccounts, and(eq(schema.ledgerAccounts.chart, chart), eq(schema.ledgerAccounts.accountNumber, schema.journalLines.accountNumber)))
    .where(and(
      eq(schema.journalEntries.tenantId, tenantId),
      eq(schema.journalEntries.status, 'posted'),
      or(like(schema.journalLines.accountNumber, '4%'), like(schema.journalLines.accountNumber, '8%')),
    ))
    .orderBy(desc(schema.journalEntries.createdAt)).all() as Array<{ counterparty: string; account_number: string }>;

  const out = new Map<string, string>();
  for (const row of rows) {
    const key = normalize(row.counterparty);
    if (!key || out.has(key)) continue;
    out.set(key, row.account_number);
  }
  return out;
};

const loadBayesTraining = (
  db: Database.Database,
  chart: 'SKR03' | 'SKR04',
  tenantId: string,
): Array<{ text: string; classId: string }> => {
  const rows = createDrizzle(db).select({
    counterparty: schema.bankTransactions.counterparty,
    purpose: schema.bankTransactions.purpose,
    account_number: schema.journalLines.accountNumber,
  }).from(schema.journalEntries)
    .innerJoin(schema.journalLines, and(eq(schema.journalLines.entryId, schema.journalEntries.id), eq(schema.journalLines.tenantId, schema.journalEntries.tenantId)))
    .innerJoin(schema.bookingDrafts, and(eq(schema.bookingDrafts.id, schema.journalEntries.sourceDraftId), eq(schema.bookingDrafts.tenantId, schema.journalEntries.tenantId)))
    .innerJoin(schema.bankTransactions, and(eq(schema.bankTransactions.id, schema.bookingDrafts.transactionId), eq(schema.bankTransactions.tenantId, schema.bookingDrafts.tenantId)))
    .innerJoin(schema.ledgerAccounts, and(eq(schema.ledgerAccounts.chart, chart), eq(schema.ledgerAccounts.accountNumber, schema.journalLines.accountNumber)))
    .where(and(
      eq(schema.journalEntries.tenantId, tenantId),
      eq(schema.journalEntries.status, 'posted'),
      or(like(schema.journalLines.accountNumber, '4%'), like(schema.journalLines.accountNumber, '8%')),
    )).all() as Array<{ counterparty: string; purpose: string; account_number: string }>;

  return rows.map((row) => ({
    text: `${row.counterparty || ''} ${row.purpose || ''}`.trim(),
    classId: row.account_number,
  }));
};

export const buildAccountSuggestionContext = (
  db: Database.Database,
  args: {
    chart: 'SKR03' | 'SKR04';
    rules: AccountSuggestionRule[];
    tenantId?: string;
  },
): AccountSuggestionContext => {
  const tenantId = args.tenantId ?? 'default';
  const keywords = [...loadKeywords(db, args.chart, tenantId).entries()].flatMap(([keyword, accounts]) =>
    accounts.map((accountNumber) => ({ keyword, accountNumber })),
  );
  const training = loadBayesTraining(db, args.chart, tenantId);
  const memory = loadCounterpartyMemory(db, args.chart, tenantId);
  const chartAccountNumbers = (createDrizzle(db).select({ account_number: schema.ledgerAccounts.accountNumber })
    .from(schema.ledgerAccounts).where(eq(schema.ledgerAccounts.chart, args.chart))
    .orderBy(asc(schema.ledgerAccounts.accountNumber)).all() as Array<{ account_number: string }>).map((row) => row.account_number);
  const context = buildAccountSuggestionContextFrom({
    chart: args.chart,
    rules: args.rules,
    keywords,
    postedBankBookings: training.map((row) => ({ counterparty: row.text, purpose: '', accountNumber: row.classId })),
    chartAccountNumbers,
  });
  // SQLite keeps its newest-first memory query; the training texts above already combine counterparty and purpose.
  return { ...context, counterpartyMemory: memory };
};
