import type Database from 'better-sqlite3';
import type { InvoiceItem, RecurringProfile } from '../types';
import { safeJsonParse, InvoiceItemsSchema } from './validation-schemas';

type RecurringRow = {
  id: string;
  client_id: string;
  active: number;
  name: string;
  interval: string;
  next_run: string;
  last_run: string | null;
  end_date: string | null;
  amount: number;
  items_json: string;
};

export const listRecurringProfiles = (db: Database.Database): RecurringProfile[] => {
  const rows = db
    .prepare('SELECT * FROM recurring_profiles ORDER BY active DESC, name ASC')
    .all() as RecurringRow[];

  return rows.map((r) => ({
    id: r.id,
    clientId: r.client_id,
    active: Boolean(r.active),
    name: r.name,
    interval: r.interval as 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly',
    nextRun: r.next_run,
    lastRun: r.last_run ?? undefined,
    endDate: r.end_date ?? undefined,
    amount: r.amount,
    items: safeJsonParse(r.items_json, InvoiceItemsSchema, [], `Recurring profile ${r.id} items`),
  }));
};

export const upsertRecurringProfile = (
  db: Database.Database,
  profile: RecurringProfile,
): RecurringProfile => {
  const exists = db.prepare('SELECT 1 FROM recurring_profiles WHERE id = ?').get(profile.id) as
    | { 1: 1 }
    | undefined;

  const payload = {
    id: profile.id,
    clientId: profile.clientId,
    active: profile.active ? 1 : 0,
    name: profile.name,
    interval: profile.interval,
    nextRun: profile.nextRun,
    lastRun: profile.lastRun ?? null,
    endDate: profile.endDate ?? null,
    amount: profile.amount,
    itemsJson: JSON.stringify(profile.items ?? []),
  };

  if (!exists) {
    db.prepare(
      `
        INSERT INTO recurring_profiles (
          id, client_id, active, name, interval, next_run, last_run, end_date, amount, items_json
        ) VALUES (
          @id, @clientId, @active, @name, @interval, @nextRun, @lastRun, @endDate, @amount, @itemsJson
        )
      `,
    ).run(payload);
  } else {
    db.prepare(
      `
        UPDATE recurring_profiles SET
          client_id=@clientId,
          active=@active,
          name=@name,
          interval=@interval,
          next_run=@nextRun,
          last_run=@lastRun,
          end_date=@endDate,
          amount=@amount,
          items_json=@itemsJson
        WHERE id=@id
      `,
    ).run(payload);
  }

  return profile;
};

export const deleteRecurringProfile = (db: Database.Database, id: string): void => {
  db.prepare('DELETE FROM recurring_profiles WHERE id = ?').run(id);
};
