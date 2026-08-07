import type Database from 'better-sqlite3';
import { and, asc, count, desc, eq } from 'drizzle-orm';
import { createDrizzle, schema } from '@billme/desktop-data/drizzle';
import type { Account, Transaction } from '../types';

type AccountRow = {
  id: string;
  name: string;
  iban: string;
  balance: number;
  default_skr_account_number: string | null;
  type: string;
  color: string;
};

type TransactionRow = {
  id: string;
  account_id: string;
  date: string;
  amount: number;
  type: string;
  counterparty: string;
  purpose: string;
  linked_invoice_id: string | null;
  status: string;
};

const DEFAULT_BANK_ACCOUNT_BY_CHART: Record<'SKR03' | 'SKR04', string> = {
  SKR03: '1200',
  SKR04: '1800',
};

const getActiveChart = (db: Database.Database): 'SKR03' | 'SKR04' => {
  const rows = createDrizzle(db).select({ chart: schema.ledgerAccounts.chart, c: count() })
    .from(schema.ledgerAccounts).groupBy(schema.ledgerAccounts.chart).all() as Array<{ chart: string; c: number }>;

  const byChart = rows.reduce(
    (acc, row) => {
      if (row.chart === 'SKR03') acc.SKR03 = row.c;
      if (row.chart === 'SKR04') acc.SKR04 = row.c;
      return acc;
    },
    { SKR03: 0, SKR04: 0 },
  );

  return byChart.SKR03 >= byChart.SKR04 ? 'SKR03' : 'SKR04';
};

const countLedgerAccounts = (db: Database.Database): number => {
  const row = createDrizzle(db).select({ c: count() }).from(schema.ledgerAccounts).get();
  return Number(row?.c ?? 0);
};

const ledgerAccountExists = (db: Database.Database, accountNumber: string): boolean => {
  const row = createDrizzle(db).select({ id: schema.ledgerAccounts.id }).from(schema.ledgerAccounts)
    .where(eq(schema.ledgerAccounts.accountNumber, accountNumber)).limit(1).get();
  return Boolean(row);
};

const findFirstLedgerAccountByChart = (
  db: Database.Database,
  chart: 'SKR03' | 'SKR04',
): string | undefined => {
  const row = createDrizzle(db).select({ account_number: schema.ledgerAccounts.accountNumber }).from(schema.ledgerAccounts)
    .where(eq(schema.ledgerAccounts.chart, chart)).orderBy(asc(schema.ledgerAccounts.accountNumber)).limit(1).get();
  return row?.account_number;
};

const findFirstLedgerAccountAny = (db: Database.Database): string | undefined => {
  const row = createDrizzle(db).select({ account_number: schema.ledgerAccounts.accountNumber }).from(schema.ledgerAccounts)
    .orderBy(asc(schema.ledgerAccounts.chart), asc(schema.ledgerAccounts.accountNumber)).limit(1).get();
  return row?.account_number;
};

const fallbackSkrAccountNumber = (
  db: Database.Database,
  preferredChart: 'SKR03' | 'SKR04',
): string => {
  const preferred = DEFAULT_BANK_ACCOUNT_BY_CHART[preferredChart];
  const byChart = createDrizzle(db).select({ account_number: schema.ledgerAccounts.accountNumber }).from(schema.ledgerAccounts)
    .where(and(eq(schema.ledgerAccounts.chart, preferredChart), eq(schema.ledgerAccounts.accountNumber, preferred))).limit(1).get();
  if (byChart?.account_number) return byChart.account_number;

  const firstByChart = findFirstLedgerAccountByChart(db, preferredChart);
  if (firstByChart) return firstByChart;

  const firstAny = findFirstLedgerAccountAny(db);
  if (firstAny) return firstAny;

  return preferred;
};

const resolveDefaultSkrAccountNumber = (
  db: Database.Database,
  candidate: string | undefined | null,
  preferredChart: 'SKR03' | 'SKR04',
): string => {
  const normalized = String(candidate ?? '').trim();
  if (!normalized) {
    return fallbackSkrAccountNumber(db, preferredChart);
  }

  if (countLedgerAccounts(db) === 0) {
    return normalized;
  }

  return ledgerAccountExists(db, normalized)
    ? normalized
    : fallbackSkrAccountNumber(db, preferredChart);
};

export const listAccounts = (db: Database.Database): Account[] => {
  const activeChart = getActiveChart(db);
  const drizzle = createDrizzle(db);
  const accountRows = drizzle.select({ id: schema.accounts.id, name: schema.accounts.name, iban: schema.accounts.iban, balance: schema.accounts.balance, default_skr_account_number: schema.accounts.defaultSkrAccountNumber, type: schema.accounts.type, color: schema.accounts.color })
    .from(schema.accounts).orderBy(asc(schema.accounts.name)).all() as AccountRow[];
  const txRows = drizzle.select({ id: schema.transactions.id, account_id: schema.transactions.accountId, date: schema.transactions.date, amount: schema.transactions.amount, type: schema.transactions.type, counterparty: schema.transactions.counterparty, purpose: schema.transactions.purpose, linked_invoice_id: schema.transactions.linkedInvoiceId, status: schema.transactions.status })
    .from(schema.transactions).orderBy(asc(schema.transactions.accountId), desc(schema.transactions.date)).all() as TransactionRow[];

  const txByAccount = new Map<string, Transaction[]>();
  for (const t of txRows) {
    const list = txByAccount.get(t.account_id) ?? [];
    list.push({
      id: t.id,
      date: t.date,
      amount: t.amount,
      type: t.type as 'income' | 'expense',
      counterparty: t.counterparty,
      purpose: t.purpose,
      linkedInvoiceId: t.linked_invoice_id ?? undefined,
      status: t.status as 'pending' | 'booked' | 'open' | 'matched',
    });
    txByAccount.set(t.account_id, list);
  }

  return accountRows.map((a) => ({
    id: a.id,
    name: a.name,
    iban: a.iban,
    balance: a.balance,
    defaultSkrAccountNumber: resolveDefaultSkrAccountNumber(
      db,
      a.default_skr_account_number,
      activeChart,
    ),
    type: a.type as Account['type'],
    color: a.color,
    transactions: txByAccount.get(a.id) ?? [],
  }));
};

export const upsertAccount = (db: Database.Database, account: Account): Account => {
  const tx = db.transaction(() => {
    const activeChart = getActiveChart(db);
    const defaultSkrAccountNumber = resolveDefaultSkrAccountNumber(
      db,
      account.defaultSkrAccountNumber,
      activeChart,
    );
    const nextAccount: Account = { ...account, defaultSkrAccountNumber };

    const drizzle = createDrizzle(db);
    const exists = drizzle.select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();

    if (!exists) {
      drizzle.insert(schema.accounts).values({
        id: nextAccount.id,
        name: nextAccount.name,
        iban: nextAccount.iban,
        balance: nextAccount.balance,
        defaultSkrAccountNumber: nextAccount.defaultSkrAccountNumber,
        type: nextAccount.type,
        color: nextAccount.color,
      }).run();
    } else {
      drizzle.update(schema.accounts).set({
        name: nextAccount.name,
        iban: nextAccount.iban,
        balance: nextAccount.balance,
        defaultSkrAccountNumber: nextAccount.defaultSkrAccountNumber,
        type: nextAccount.type,
        color: nextAccount.color,
      }).where(eq(schema.accounts.id, nextAccount.id)).run();
    }

    drizzle.delete(schema.transactions).where(eq(schema.transactions.accountId, nextAccount.id)).run();
    for (const t of nextAccount.transactions ?? []) {
      drizzle.insert(schema.transactions).values({
        id: t.id,
        accountId: nextAccount.id,
        date: t.date,
        amount: t.amount,
        type: t.type,
        counterparty: t.counterparty,
        purpose: t.purpose,
        linkedInvoiceId: t.linkedInvoiceId ?? null,
        status: t.status,
      }).run();
    }

    return nextAccount;
  });

  return tx();
};

export const deleteAccount = (db: Database.Database, id: string): void => {
  const tx = db.transaction(() => {
    const drizzle = createDrizzle(db);
    drizzle.delete(schema.transactions).where(eq(schema.transactions.accountId, id)).run();
    drizzle.delete(schema.accounts).where(eq(schema.accounts.id, id)).run();
  });
  tx();
};

export const ensureAccountDefaultSkrMappings = (db: Database.Database): void => {
  const activeChart = getActiveChart(db);
  const drizzle = createDrizzle(db);
  const rows = drizzle.select({ id: schema.accounts.id, default_skr_account_number: schema.accounts.defaultSkrAccountNumber })
    .from(schema.accounts).orderBy(asc(schema.accounts.id)).all() as Array<{ id: string; default_skr_account_number: string | null }>;
  if (!rows.length) return;

  const tx = db.transaction(() => {
    for (const row of rows) {
      const resolved = resolveDefaultSkrAccountNumber(
        db,
        row.default_skr_account_number,
        activeChart,
      );
      if ((row.default_skr_account_number ?? '').trim() === resolved) {
        continue;
      }
      drizzle.update(schema.accounts).set({ defaultSkrAccountNumber: resolved }).where(eq(schema.accounts.id, row.id)).run();
    }
  });

  tx();
};
