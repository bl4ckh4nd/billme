import { defaultReportPosition, listReportMappingPositions } from '@billme/accounting-engine';
import { isMoneyLedgerAccount, isProfitAndLossAccount } from '@billme/accounting-shared';
import type { TenantScope } from '@billme/server-core';
import type { PostgresQueryable } from './connection.js';

/**
 * Overview figures straight from the journal, for businesses that book double entry: Erträge and Aufwand per month,
 * the balance of the money accounts and the Aufwand per BWA cost type. Unlike the dashboard's bank-line figures
 * these also cover a ledger that came in by journal import, without bank lines or invoices.
 *
 * Every Erfolgskonto is read through its BWA 01 position (the tenant's own mapping, else the default by account
 * range): Umsatzerlöse, Sonderbetriebserlöse, Zins- and neutrale Erträge count as Ertrag, everything else as
 * Aufwand, Steuern vom Einkommen included. Year-end close and carry-forward entries are not part of it.
 */

export interface LedgerOverviewMonth {
  /** YYYY-MM */
  period: string;
  revenue: number;
  expense: number;
  result: number;
}

export interface LedgerOverviewBreakdownLine {
  key: string;
  label: string;
  value: number;
}

export interface LedgerOverview {
  chart: 'SKR03' | 'SKR04';
  from: string;
  to: string;
  /** Every month of the range, oldest first, zero when nothing was booked. */
  months: LedgerOverviewMonth[];
  /** First and last month with a booking on an Erfolgskonto, over the whole journal. */
  firstPeriod?: string;
  lastPeriod?: string;
  /** Balances of the money accounts (Kasse, Bank, Kreditkarten) at `to`. */
  liquidity: { total: number; accounts: Array<{ accountNumber: string; name?: string; balance: number }> };
  /** Aufwand of the range per BWA position, largest first. */
  expenseBreakdown: LedgerOverviewBreakdownLine[];
  /** Ertrag of the range per BWA position, largest first. */
  revenueBreakdown: LedgerOverviewBreakdownLine[];
}

/** BWA 01 positions on the Ertrag side; the rest of an Erfolgskonto's positions are Aufwand. */
const REVENUE_POSITIONS = new Set(['revenue', 'special-operating-income', 'interest-income', 'other-neutral-income', 'imputed-cost-offset']);
const RUNNING_JOURNAL = `COALESCE(je.source_type,'') NOT IN ('fiscal_close','carry_forward')`;

const q = async <T = any>(db: PostgresQueryable, text: string, values: unknown[] = []): Promise<T[]> => (await db.query(text, values)).rows as T[];
const cents = (value: unknown): number => Math.round(Number(value || 0) * 100);
const euro = (value: number): number => value / 100;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const monthsBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const last = to.slice(0, 7);
  for (let guard = 0; guard < 600; guard += 1) {
    const period = `${year}-${String(month).padStart(2, '0')}`;
    if (period > last) break;
    out.push(period);
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return out;
};

/** BWA position labels: the catalogue of the range's year, else today's (catalogues start in 2025; the labels never changed). */
const bwaPositions = (asOfDate: string) => {
  try {
    return listReportMappingPositions('bwa01', 'small', asOfDate);
  } catch {
    return listReportMappingPositions('bwa01', 'small', new Date().toISOString().slice(0, 10));
  }
};

/** The default range: the twelve months up to and including the current one. */
const defaultRange = (today: Date): { from: string; to: string } => {
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 11, 1));
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
};

export const getLedgerOverview = async (db: PostgresQueryable, scope: TenantScope, args: { from?: string; to?: string } = {}): Promise<LedgerOverview> => {
  const t = scope.tenantId;
  const fallback = defaultRange(new Date());
  const from = args.from ?? fallback.from;
  const to = args.to ?? fallback.to;
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) throw new Error('LEDGER_OVERVIEW_RANGE_INVALID');
  const policy = (await q<{ active_chart: string }>(db, `SELECT active_chart FROM accounting_policies WHERE tenant_id=$1`, [t]))[0];
  const chart: 'SKR03' | 'SKR04' = policy?.active_chart === 'SKR04' ? 'SKR04' : 'SKR03';

  const movements = await q<{ period: string; account_number: string; amount: string }>(db, `SELECT substr(je.posting_date,1,7) AS period, jl.account_number, SUM(jl.debit_amount-jl.credit_amount) AS amount
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id AND je.tenant_id=jl.tenant_id
    WHERE jl.tenant_id=$1 AND je.status IN ('posted','reversed') AND ${RUNNING_JOURNAL} AND je.posting_date >= $2 AND je.posting_date <= $3
    GROUP BY 1,2`, [t, from, to]);
  const explicit = new Map((await q<{ account_number: string; position_key: string }>(db, `SELECT DISTINCT ON (account_number) account_number,position_key FROM report_account_mappings
    WHERE tenant_id=$1 AND chart=$2 AND report_type='bwa01' AND (valid_from IS NULL OR valid_from <= $3) ORDER BY account_number,valid_from DESC NULLS LAST`, [t, chart, to])).map((row) => [String(row.account_number), String(row.position_key)]));
  const labels = new Map(bwaPositions(to).map((position) => [position.key, position.label]));
  const positionOf = (account: string): string => explicit.get(account) ?? defaultReportPosition(chart, account, 'bwa01')?.position ?? 'other-operating-expense';

  const byMonth = new Map(monthsBetween(from, to).map((period) => [period, { revenue: 0, expense: 0 }]));
  const expenseByPosition = new Map<string, number>();
  const revenueByPosition = new Map<string, number>();
  for (const row of movements) {
    const account = String(row.account_number);
    if (!isProfitAndLossAccount(chart, account)) continue;
    const month = byMonth.get(String(row.period));
    if (!month) continue;
    const position = positionOf(account);
    const amount = cents(row.amount);
    if (REVENUE_POSITIONS.has(position)) {
      month.revenue -= amount;
      revenueByPosition.set(position, (revenueByPosition.get(position) ?? 0) - amount);
    } else {
      month.expense += amount;
      expenseByPosition.set(position, (expenseByPosition.get(position) ?? 0) + amount);
    }
  }

  const extent = (await q<{ first: string | null; last: string | null; account_number: string }>(db, `SELECT jl.account_number, MIN(je.posting_date) AS first, MAX(je.posting_date) AS last
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id AND je.tenant_id=jl.tenant_id
    WHERE jl.tenant_id=$1 AND je.status IN ('posted','reversed') AND ${RUNNING_JOURNAL} GROUP BY jl.account_number`, [t]))
    .filter((row) => isProfitAndLossAccount(chart, String(row.account_number)));
  const firstDate = extent.map((row) => row.first).filter((value): value is string => Boolean(value)).sort()[0];
  const lastDate = extent.map((row) => row.last).filter((value): value is string => Boolean(value)).sort().at(-1);

  const balances = await q<{ account_number: string; balance: string; name: string | null }>(db, `SELECT jl.account_number, SUM(jl.debit_amount-jl.credit_amount) AS balance,
      MAX(COALESCE(tla.name, la.name)) AS name
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id AND je.tenant_id=jl.tenant_id
    LEFT JOIN tenant_ledger_accounts tla ON tla.tenant_id=jl.tenant_id AND tla.chart=$3 AND tla.account_number=jl.account_number
    LEFT JOIN ledger_accounts la ON la.chart=$3 AND la.account_number=jl.account_number
    WHERE jl.tenant_id=$1 AND je.status IN ('posted','reversed') AND ${RUNNING_JOURNAL} AND je.posting_date <= $2
    GROUP BY jl.account_number`, [t, to, chart]);
  const money = balances
    .filter((row) => isMoneyLedgerAccount(chart, String(row.account_number)))
    .map((row) => ({ accountNumber: String(row.account_number), name: row.name ?? undefined, cents: cents(row.balance) }))
    .sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));

  const ranked = (byPosition: Map<string, number>): LedgerOverviewBreakdownLine[] => [...byPosition]
    .filter(([, value]) => value !== 0)
    .map(([key, value]) => ({ key, label: labels.get(key) ?? key, value: euro(value) }))
    .sort((a, b) => b.value - a.value);

  return {
    chart, from, to,
    months: [...byMonth].map(([period, month]) => ({ period, revenue: euro(month.revenue), expense: euro(month.expense), result: euro(month.revenue - month.expense) })),
    ...(firstDate ? { firstPeriod: firstDate.slice(0, 7) } : {}),
    ...(lastDate ? { lastPeriod: lastDate.slice(0, 7) } : {}),
    liquidity: {
      total: euro(money.reduce((sum, account) => sum + account.cents, 0)),
      accounts: money.map((account) => ({ accountNumber: account.accountNumber, ...(account.name ? { name: account.name } : {}), balance: euro(account.cents) })),
    },
    expenseBreakdown: ranked(expenseByPosition),
    revenueBreakdown: ranked(revenueByPosition),
  };
};
