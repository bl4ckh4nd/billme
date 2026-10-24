import { randomUUID } from 'node:crypto';
import { fiscalYearForDate, type AccountingMutationContext } from '@billme/accounting-shared';
import type { TenantScope } from '@billme/server-core';
import { appendWithClient } from './audit.js';
import { runInTransaction, type PostgresQueryable } from './connection.js';

/**
 * Pro accounting periods (calendar months). `soft_locked` needs an override
 * with a written reason for every posting and can be reopened with a reason.
 * `closed` is the Festschreibung: final, and cumulative — closing a month
 * closes every earlier month as well ("festgeschrieben bis einschließlich"),
 * so a backdated posting can never land before a festgeschriebener month.
 */
export type AccountingPeriodStatus = 'open' | 'soft_locked' | 'closed';
export interface AccountingPeriodRecord {
  period: string;
  status: AccountingPeriodStatus;
  fiscalYear?: number;
  entryCount: number;
  updatedAt?: string;
}
export interface AccountingPeriodStatusChange {
  period: string;
  status: AccountingPeriodStatus;
  changedPeriods: string[];
}

const PERIOD_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;
const q = async <T = any>(db: PostgresQueryable, text: string, values: unknown[] = []): Promise<T[]> => (await db.query(text, values)).rows as T[];
const now = (): string => new Date().toISOString();
const parse = <T>(value: unknown, fallback: T): T => { if (value == null) return fallback; try { return typeof value === 'string' ? JSON.parse(value) as T : (value as T); } catch { return fallback; } };
const monthEnd = (period: string): string => new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10);

export const reportingFiscalYearStart = async (db: PostgresQueryable, t: string): Promise<string> => {
  const rows = await q<any>(db, `SELECT settings_json FROM server_settings WHERE tenant_id=$1 LIMIT 1`, [t]);
  const settings = parse<Record<string, unknown>>(rows[0]?.settings_json, {});
  const profile = parse<Record<string, unknown>>(settings.businessReportingProfile ?? settings.business_reporting_profile ?? settings.reportingProfile ?? settings, {});
  if (profile.profitDetermination === 'eur') return '01-01';
  const fiscalYearStart = profile.fiscalYearStart;
  return typeof fiscalYearStart === 'string' && /^\d{2}-\d{2}$/.test(fiscalYearStart) ? fiscalYearStart : '01-01';
};

export const reportingFiscalYear = async (db: PostgresQueryable, t: string, postingDate: string): Promise<number> =>
  fiscalYearForDate(postingDate, await reportingFiscalYearStart(db, t));

/** Months from `from` to `to` (both YYYY-MM), inclusive. */
export const periodsBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let year = Number(from.slice(0, 4)), month = Number(from.slice(5, 7)); `${year}-${String(month).padStart(2, '0')}` <= to; month === 12 ? (year += 1, month = 1) : (month += 1)) {
    out.push(`${year}-${String(month).padStart(2, '0')}`);
  }
  return out;
};

const latestClosedPeriod = async (db: PostgresQueryable, t: string): Promise<string | undefined> =>
  (await q<any>(db, `SELECT MAX(period) AS period FROM accounting_periods WHERE tenant_id=$1 AND status='closed'`, [t]))[0]?.period ?? undefined;

/**
 * Locks the period row for a posting (creates it when missing) and returns its
 * effective status. Every posting path reads the status here.
 */
export const lockPeriodRow = async (db: PostgresQueryable, t: string, period: string, fiscalYear: number): Promise<{ status: AccountingPeriodStatus; fiscalYear: number }> => {
  if (!PERIOD_KEY.test(period)) throw new Error('INVALID_PERIOD');
  const select = () => q<any>(db, `SELECT status,fiscal_year FROM accounting_periods WHERE tenant_id=$1 AND period=$2 FOR UPDATE`, [t, period]);
  let row = (await select())[0];
  const closedLater = ((await latestClosedPeriod(db, t)) ?? '') >= period;
  if (!row) {
    const stamp = now();
    await q(db, `INSERT INTO accounting_periods (id,tenant_id,period,fiscal_year,status,starts_at,ends_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT (tenant_id,period) DO NOTHING`, [randomUUID(), t, period, fiscalYear, closedLater ? 'closed' : 'open', `${period}-01`, monthEnd(period), stamp]);
    row = (await select())[0];
  }
  const status: AccountingPeriodStatus = closedLater || row.status === 'closed' ? 'closed' : row.status === 'soft_locked' ? 'soft_locked' : 'open';
  return { status, fiscalYear: Number(row.fiscal_year) };
};

export const listAccountingPeriods = async (db: PostgresQueryable, scope: TenantScope, year: number): Promise<AccountingPeriodRecord[]> => {
  const t = scope.tenantId;
  const rows = await q<any>(db, `SELECT period,status,fiscal_year,updated_at FROM accounting_periods WHERE tenant_id=$1 AND period LIKE $2`, [t, `${year}-%`]);
  const counts = await q<any>(db, `SELECT period,COUNT(*)::int AS c FROM journal_entries WHERE tenant_id=$1 AND period LIKE $2 GROUP BY period`, [t, `${year}-%`]);
  const latestClosed = (await latestClosedPeriod(db, t)) ?? '';
  const byPeriod = new Map(rows.map((row) => [String(row.period), row]));
  const entryCounts = new Map(counts.map((row) => [String(row.period), Number(row.c)]));
  return periodsBetween(`${year}-01`, `${year}-12`).map((period) => {
    const row = byPeriod.get(period);
    const status: AccountingPeriodStatus = latestClosed >= period ? 'closed' : row?.status === 'soft_locked' ? 'soft_locked' : 'open';
    return { period, status, fiscalYear: row ? Number(row.fiscal_year) : undefined, entryCount: entryCounts.get(period) ?? 0, updatedAt: row?.updated_at ?? undefined };
  });
};

const actionFor = (status: AccountingPeriodStatus): string => status === 'closed' ? 'accounting_period.close' : status === 'soft_locked' ? 'accounting_period.soft_lock' : 'accounting_period.reopen';

const writeStatus = async (db: PostgresQueryable, scope: TenantScope, periods: string[], from: AccountingPeriodStatus, status: AccountingPeriodStatus, subject: string, reason: string, mutation?: AccountingMutationContext): Promise<void> => {
  if (!periods.length) return;
  const stamp = now();
  await q(db, `UPDATE accounting_periods SET status=$1,updated_at=$2 WHERE tenant_id=$3 AND period = ANY($4::text[])`, [status, stamp, scope.tenantId, periods]);
  await appendWithClient(db, scope, { occurredAt: stamp, action: actionFor(status), reason, actor: mutation?.actor ?? { type: 'service', displayName: 'server-accounting' }, subject: { entityType: 'accounting_period', entityId: subject, tenantId: scope.tenantId }, change: { before: { status: from, periods }, after: { status, periods } } });
};

/**
 * Soft-lock, reopen or close (festschreiben) one month. A closed month never
 * changes again (PERIOD_CLOSED). Every change needs a written reason and is audited.
 */
export const setAccountingPeriodStatus = (db: PostgresQueryable, scope: TenantScope, input: { period: string; status: AccountingPeriodStatus; mutation: AccountingMutationContext }): Promise<AccountingPeriodStatusChange> =>
  runInTransaction(db, async (tx) => {
    const reason = input.mutation?.reason?.trim();
    if (!reason) throw new Error('ACCOUNTING_AUDIT_REASON_REQUIRED');
    if (!PERIOD_KEY.test(input.period)) throw new Error('INVALID_PERIOD');
    const t = scope.tenantId;
    const current = await lockPeriodRow(tx, t, input.period, await reportingFiscalYear(tx, t, `${input.period}-01`));
    if (current.status === 'closed') throw new Error(`PERIOD_CLOSED: Der Monat ${input.period} ist festgeschrieben und lässt sich nicht mehr ändern.`);
    if (current.status === input.status) return { period: input.period, status: input.status, changedPeriods: [] };
    const changed = input.status === 'closed'
      ? (await q<any>(tx, `SELECT period FROM accounting_periods WHERE tenant_id=$1 AND period <= $2 AND status <> 'closed' ORDER BY period FOR UPDATE`, [t, input.period])).map((row) => String(row.period))
      : [input.period];
    await writeStatus(tx, scope, changed, current.status, input.status, input.period, reason, input.mutation);
    return { period: input.period, status: input.status, changedPeriods: changed };
  }, { serializable: true });

/**
 * Soft-locks the open months among `periods` inside the caller's transaction
 * (UStVA preparation, fiscal-year close). Closed and already locked months stay as they are.
 */
export const softLockPeriods = async (db: PostgresQueryable, scope: TenantScope, periods: string[], reason: string, mutation?: AccountingMutationContext): Promise<string[]> => {
  const t = scope.tenantId;
  const changed: string[] = [];
  for (const period of periods) {
    const row = await lockPeriodRow(db, t, period, await reportingFiscalYear(db, t, `${period}-01`));
    if (row.status === 'open') changed.push(period);
  }
  await writeStatus(db, scope, changed, 'open', 'soft_locked', changed[0] ?? '', reason, mutation);
  return changed;
};
