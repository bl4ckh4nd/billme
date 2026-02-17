import type Database from 'better-sqlite3';
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
  const accountRows = db.prepare('SELECT * FROM accounts ORDER BY name ASC').all() as AccountRow[];
  const txRows = db
    .prepare('SELECT * FROM transactions ORDER BY account_id, date DESC')
    .all() as TransactionRow[];

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
    const exists = db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(account.id) as
      | { 1: 1 }
      | undefined;

    if (!exists) {
      db.prepare(
        `
          INSERT INTO accounts (id, name, iban, balance, type, color)
          VALUES (@id, @name, @iban, @balance, @type, @color)
        `,
      ).run({
        id: account.id,
        name: account.name,
        iban: account.iban,
        balance: account.balance,
        type: account.type,
        color: account.color,
      });
    } else {
      db.prepare(
        `
          UPDATE accounts SET
            name=@name,
            iban=@iban,
            balance=@balance,
            type=@type,
            color=@color
          WHERE id=@id
        `,
      ).run({
        id: account.id,
        name: account.name,
        iban: account.iban,
        balance: account.balance,
        type: account.type,
        color: account.color,
      });
    }

    db.prepare('DELETE FROM transactions WHERE account_id = ?').run(account.id);
    const insertTx = db.prepare(
      `
        INSERT INTO transactions (
          id, account_id, date, amount, type, counterparty, purpose, linked_invoice_id, status
        ) VALUES (
          @id, @accountId, @date, @amount, @type, @counterparty, @purpose, @linkedInvoiceId, @status
        )
      `,
    );
    for (const t of account.transactions ?? []) {
      insertTx.run({
        id: t.id,
        accountId: account.id,
        date: t.date,
        amount: t.amount,
        type: t.type,
        counterparty: t.counterparty,
        purpose: t.purpose,
        linkedInvoiceId: t.linkedInvoiceId ?? null,
        status: t.status,
      });
    }

    return account;
  });

  return tx();
};

export const deleteAccount = (db: Database.Database, id: string): void => {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM transactions WHERE account_id = ?').run(id);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  });
  tx();
};
