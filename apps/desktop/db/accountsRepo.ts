import type Database from 'better-sqlite3';
import { asc, desc, eq } from 'drizzle-orm';
import { createDrizzle, schema } from '@billme/desktop-data/drizzle';
import type { Account, Transaction } from '../types';

type AccountRow = {
  id: string;
  name: string;
  iban: string;
  balance: number;
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

export const listAccounts = (db: Database.Database): Account[] => {
  const drizzle = createDrizzle(db);
  const accountRows = drizzle.select({
    id: schema.accounts.id,
    name: schema.accounts.name,
    iban: schema.accounts.iban,
    balance: schema.accounts.balance,
    type: schema.accounts.type,
    color: schema.accounts.color,
  }).from(schema.accounts).orderBy(asc(schema.accounts.name)).all() as AccountRow[];
  const txRows = drizzle.select({
    id: schema.transactions.id,
    account_id: schema.transactions.accountId,
    date: schema.transactions.date,
    amount: schema.transactions.amount,
    type: schema.transactions.type,
    counterparty: schema.transactions.counterparty,
    purpose: schema.transactions.purpose,
    linked_invoice_id: schema.transactions.linkedInvoiceId,
    status: schema.transactions.status,
  }).from(schema.transactions).orderBy(asc(schema.transactions.accountId), desc(schema.transactions.date)).all() as TransactionRow[];

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
      status: t.status as 'open' | 'matched',
    });
    txByAccount.set(t.account_id, list);
  }

  return accountRows.map((a) => ({
    id: a.id,
    name: a.name,
    iban: a.iban,
    balance: a.balance,
    type: a.type as 'checking' | 'savings' | 'credit' | 'other',
    color: a.color,
    transactions: txByAccount.get(a.id) ?? [],
  }));
};

export const upsertAccount = (db: Database.Database, account: Account): Account => {
  const tx = db.transaction(() => {
    const drizzle = createDrizzle(db);
    const exists = drizzle.select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();

    if (!exists) {
      drizzle.insert(schema.accounts).values({
        id: account.id,
        name: account.name,
        iban: account.iban,
        balance: account.balance,
        type: account.type,
        color: account.color,
      }).run();
    } else {
      drizzle.update(schema.accounts).set({
        name: account.name,
        iban: account.iban,
        balance: account.balance,
        type: account.type,
        color: account.color,
      }).where(eq(schema.accounts.id, account.id)).run();
    }

    drizzle.delete(schema.transactions).where(eq(schema.transactions.accountId, account.id)).run();
    for (const t of account.transactions ?? []) {
      drizzle.insert(schema.transactions).values({
        id: t.id,
        accountId: account.id,
        date: t.date,
        amount: t.amount,
        type: t.type,
        counterparty: t.counterparty,
        purpose: t.purpose,
        linkedInvoiceId: t.linkedInvoiceId ?? null,
        status: t.status,
      }).run();
    }

    return account;
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
