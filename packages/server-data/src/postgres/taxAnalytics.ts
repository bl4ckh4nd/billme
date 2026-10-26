import { computeUstva, defaultReportPosition, listReportMappingPositions } from '@billme/accounting-engine';
import { isMoneyLedgerAccount, isProfitAndLossAccount } from '@billme/accounting-shared';
import type { TenantScope } from '@billme/server-core';
import type { PostgresQueryable } from './connection.js';
import { sourceEntries } from './accountingSourceRuns.js';
import { accountRoleMappings } from './taxAccounts.js';

/**
 * Tax and money-account analyses from the journal (Steuer area and Geldkonten of Billme Pro):
 * - the UStVA per month or quarter with its Frist (10th of the following month, a month later with
 *   Dauerfristverlängerung, moved past a weekend) and whether Billme prepared it, plus the largest tax lines;
 * - payments to and from the tax offices per topic (Umsatzsteuer, Lohnsteuer, Ertragsteuern, sonstige Steuern):
 *   the lines on the topic's accounts in entries that move a money account;
 * - one money account over a year: balances, inflow and outflow per month, counter accounts and booking texts.
 */

const RUNNING_JOURNAL = `COALESCE(je.source_type,'') NOT IN ('fiscal_close','carry_forward')`;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const q = async <T = any>(db: PostgresQueryable, text: string, values: unknown[] = []): Promise<T[]> => (await db.query(text, values)).rows as T[];
const cents = (value: unknown): number => Math.round(Number(value || 0) * 100);
const euro = (value: number): number => value / 100;
const pad = (value: number) => String(value).padStart(2, '0');
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

const chartOf = async (db: PostgresQueryable, t: string): Promise<'SKR03' | 'SKR04'> =>
  (await q<{ active_chart: string }>(db, `SELECT active_chart FROM accounting_policies WHERE tenant_id=$1`, [t]))[0]?.active_chart === 'SKR04' ? 'SKR04' : 'SKR03';

const assertRange = (from: string, to: string) => {
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) throw new Error('ANALYTICS_RANGE_INVALID');
};

const accountNames = async (db: PostgresQueryable, t: string, chart: string, accounts: string[]): Promise<Map<string, string>> => {
  if (!accounts.length) return new Map();
  const rows = await q<{ account_number: string; name: string }>(db, `SELECT n.account_number, COALESCE(tla.name, la.name, '') AS name FROM unnest($3::text[]) AS n(account_number)
    LEFT JOIN tenant_ledger_accounts tla ON tla.tenant_id=$1 AND tla.chart=$2 AND tla.account_number=n.account_number
    LEFT JOIN ledger_accounts la ON la.chart=$2 AND la.account_number=n.account_number`, [t, chart, accounts]);
  return new Map(rows.map((row) => [String(row.account_number), String(row.name ?? '')]));
};

// --- Umsatzsteuer ----------------------------------------------------------------------------------------------

export interface VatAnalyticsPeriod {
  /** 2025-03 or 2025-Q1: the key a prepared UStVA of that period carries. */
  key: string;
  from: string;
  to: string;
  outputTax: number;
  inputTax: number;
  payable: number;
  lineCount: number;
  /** Abgabefrist of the Voranmeldung. */
  deadline: string;
  preparedAt?: string;
  /** prepared: Billme froze it; due: deadline ahead; open: deadline passed in the last 90 days, nothing prepared; past: older, not prepared in Billme. */
  status: 'prepared' | 'due' | 'open' | 'past';
}

export interface VatAnalytics {
  from: string;
  to: string;
  granularity: 'month' | 'quarter';
  permanentExtension: boolean;
  periods: VatAnalyticsPeriod[];
  totals: { outputTax: number; inputTax: number; payable: number };
  /** The largest tax amounts of the range, for a check before filing. */
  topLines: Array<{ entryId?: string; entryNumber?: number; postingDate: string; reference?: string; kennziffer: string; direction: string; taxCaseKey: string; netAmount: number; taxAmount: number }>;
}

/** § 108 Abs. 3 AO: a Frist ending on a Saturday or Sunday ends on the next Monday (public holidays not counted here). */
const nextWorkday = (iso: string): string => {
  const date = new Date(`${iso}T00:00:00Z`);
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};
const vatDeadline = (periodEnd: string, extension: boolean): string => {
  const year = Number(periodEnd.slice(0, 4));
  const month = Number(periodEnd.slice(5, 7)) + (extension ? 2 : 1);
  const due = new Date(Date.UTC(year, month - 1, 10));
  return nextWorkday(due.toISOString().slice(0, 10));
};

const vatPeriods = (from: string, to: string, granularity: 'month' | 'quarter') => {
  const out: Array<{ key: string; from: string; to: string }> = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  if (granularity === 'quarter') month = Math.floor((month - 1) / 3) * 3 + 1;
  for (let guard = 0; guard < 1200; guard += 1) {
    const start = `${year}-${pad(month)}-01`;
    if (start > to) break;
    const endMonth = granularity === 'quarter' ? month + 2 : month;
    out.push({
      key: granularity === 'quarter' ? `${year}-Q${(month - 1) / 3 + 1}` : `${year}-${pad(month)}`,
      from: start,
      to: `${year}-${pad(endMonth)}-${pad(lastDay(year, endMonth))}`,
    });
    month = endMonth + 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return out;
};

export const getVatAnalytics = async (db: PostgresQueryable, scope: TenantScope, args: { from: string; to: string; granularity?: 'month' | 'quarter'; today?: string }): Promise<VatAnalytics> => {
  assertRange(args.from, args.to);
  const t = scope.tenantId;
  const granularity = args.granularity ?? 'month';
  const today = args.today ?? new Date().toISOString().slice(0, 10);
  const settings = (await q<{ settings_json: unknown }>(db, `SELECT settings_json FROM server_settings WHERE tenant_id=$1 LIMIT 1`, [t]))[0]?.settings_json;
  const parsed = typeof settings === 'string' ? JSON.parse(settings) : settings;
  const permanentExtension = Boolean((parsed as { legal?: { vatPermanentExtension?: boolean } } | undefined)?.legal?.vatPermanentExtension);
  const entries = await sourceEntries(db, scope);
  const prepared = new Map((await q<{ source_id: string; created_at: string }>(db, `SELECT source_id, MAX(created_at) AS created_at FROM accounting_source_runs WHERE tenant_id=$1 AND source_type='tax_export_ustva' AND status='prepared' GROUP BY source_id`, [t])).map((row) => [String(row.source_id), String(row.created_at)]));
  const recent = new Date(`${today}T00:00:00Z`);
  recent.setUTCDate(recent.getUTCDate() - 90);
  const recentIso = recent.toISOString().slice(0, 10);

  const periods = vatPeriods(args.from, args.to, granularity).map((period): VatAnalyticsPeriod => {
    const computed = computeUstva({ from: period.from, to: period.to, entries });
    const deadline = vatDeadline(period.to, permanentExtension);
    const preparedAt = prepared.get(period.key);
    const status = preparedAt ? 'prepared' : deadline >= today ? 'due' : deadline >= recentIso ? 'open' : 'past';
    return {
      ...period,
      outputTax: computed.outputTaxAmount,
      inputTax: computed.inputTaxAmount,
      payable: computed.payableAmount,
      lineCount: computed.sources.length,
      deadline,
      ...(preparedAt ? { preparedAt } : {}),
      status,
    };
  });
  const whole = computeUstva({ from: args.from, to: args.to, entries });
  const topLines = [...whole.sources]
    .filter((source) => source.taxAmount !== 0)
    .sort((a, b) => Math.abs(b.taxAmount) - Math.abs(a.taxAmount))
    .slice(0, 20)
    .map((source) => ({ entryId: source.entryId, entryNumber: source.entryNumber, postingDate: source.postingDate, reference: source.reference, kennziffer: source.kennziffer, direction: source.direction, taxCaseKey: source.taxCaseKey, netAmount: source.netAmount, taxAmount: source.taxAmount }));
  return {
    from: args.from, to: args.to, granularity, permanentExtension, periods,
    totals: { outputTax: whole.outputTaxAmount, inputTax: whole.inputTaxAmount, payable: whole.payableAmount },
    topLines,
  };
};

// --- Zahlungen an Finanzbehörden -------------------------------------------------------------------------------

export type TaxPaymentTopicKey = 'vat' | 'wage' | 'income' | 'other';
type Ranges = ReadonlyArray<readonly [number, number]>;

/** Accounts per topic and chart (DATEV SKR 03/04): the liabilities paid to the office and the tax expense booked straight from the bank. */
const TAX_TOPICS: Record<'SKR03' | 'SKR04', Record<TaxPaymentTopicKey, { label: string; ranges: Ranges }>> = {
  SKR04: {
    vat: { label: 'Umsatzsteuer', ranges: [[3820, 3849]] },
    wage: { label: 'Lohnsteuer', ranges: [[3730, 3739]] },
    income: { label: 'Ertragsteuern (KSt, Soli, GewSt)', ranges: [[7600, 7649]] },
    other: { label: 'Sonstige Steuern und Abgaben', ranges: [[3700, 3729], [7650, 7699]] },
  },
  SKR03: {
    vat: { label: 'Umsatzsteuer', ranges: [[1780, 1799]] },
    wage: { label: 'Lohnsteuer', ranges: [[1741, 1741]] },
    income: { label: 'Ertragsteuern (KSt, Soli, GewSt)', ranges: [[2200, 2289], [4320, 4320]] },
    other: { label: 'Sonstige Steuern und Abgaben', ranges: [[1730, 1740], [4340, 4355]] },
  },
};
const topicOf = (chart: 'SKR03' | 'SKR04', account: string): TaxPaymentTopicKey | undefined => {
  if (!/^\d{4}$/.test(account)) return undefined;
  const number = Number(account);
  return (Object.entries(TAX_TOPICS[chart]) as Array<[TaxPaymentTopicKey, { ranges: Ranges }]>).find(([, topic]) => topic.ranges.some(([low, high]) => number >= low && number <= high))?.[0];
};

export interface TaxPaymentEntry {
  entryId: string;
  entryNumber: number;
  postingDate: string;
  reference?: string;
  bookingText: string;
  accountNumber: string;
  /** Paid to the office (money out) is positive, a refund negative. */
  amount: number;
}

export interface TaxPaymentTopic {
  key: TaxPaymentTopicKey;
  label: string;
  accounts: Array<{ accountNumber: string; name?: string }>;
  paid: number;
  refunded: number;
  net: number;
  months: Array<{ period: string; paid: number; refunded: number }>;
  entries: TaxPaymentEntry[];
}

export const getTaxPayments = async (db: PostgresQueryable, scope: TenantScope, args: { from: string; to: string }): Promise<{ from: string; to: string; topics: TaxPaymentTopic[] }> => {
  assertRange(args.from, args.to);
  const t = scope.tenantId;
  const chart = await chartOf(db, t);
  const lines = await q<{ entry_id: string; entry_number: string; posting_date: string; reference: string | null; booking_text: string; account_number: string; debit_amount: string; credit_amount: string }>(db, `SELECT je.id AS entry_id, je.entry_number, je.posting_date, je.reference, je.booking_text, jl.account_number, jl.debit_amount, jl.credit_amount
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id AND je.tenant_id=jl.tenant_id
    WHERE jl.tenant_id=$1 AND je.status IN ('posted','reversed') AND ${RUNNING_JOURNAL} AND je.posting_date >= $2 AND je.posting_date <= $3
    ORDER BY je.posting_date, je.entry_number`, [t, args.from, args.to]);
  const byEntry = new Map<string, typeof lines>();
  for (const line of lines) byEntry.set(line.entry_id, [...(byEntry.get(line.entry_id) ?? []), line]);
  type TopicTotals = { accounts: Set<string>; months: Map<string, { paid: number; refunded: number }>; entries: TaxPaymentEntry[] };
  const topics = new Map<TaxPaymentTopicKey, TopicTotals>();
  for (const entryLines of byEntry.values()) {
    if (!entryLines.some((line) => isMoneyLedgerAccount(chart, String(line.account_number)))) continue;
    for (const line of entryLines) {
      const key = topicOf(chart, String(line.account_number));
      if (!key) continue;
      const amount = cents(line.debit_amount) - cents(line.credit_amount);
      if (!amount) continue;
      const topic: TopicTotals = topics.get(key) ?? { accounts: new Set(), months: new Map(), entries: [] };
      topic.accounts.add(String(line.account_number));
      const period = String(line.posting_date).slice(0, 7);
      const month = topic.months.get(period) ?? { paid: 0, refunded: 0 };
      if (amount > 0) month.paid += amount; else month.refunded -= amount;
      topic.months.set(period, month);
      topic.entries.push({ entryId: line.entry_id, entryNumber: Number(line.entry_number), postingDate: String(line.posting_date), ...(line.reference ? { reference: line.reference } : {}), bookingText: line.booking_text, accountNumber: String(line.account_number), amount: euro(amount) });
      topics.set(key, topic);
    }
  }
  const names = await accountNames(db, t, chart, [...new Set([...topics.values()].flatMap((topic) => [...topic.accounts]))]);
  return {
    from: args.from, to: args.to,
    topics: (Object.keys(TAX_TOPICS[chart]) as TaxPaymentTopicKey[]).map((key): TaxPaymentTopic => {
      const topic = topics.get(key);
      const months = [...(topic?.months ?? new Map())].sort(([a], [b]) => a.localeCompare(b)).map(([period, month]) => ({ period, paid: euro(month.paid), refunded: euro(month.refunded) }));
      const paid = months.reduce((sum, month) => sum + Math.round(month.paid * 100), 0);
      const refunded = months.reduce((sum, month) => sum + Math.round(month.refunded * 100), 0);
      return {
        key, label: TAX_TOPICS[chart][key].label,
        accounts: [...(topic?.accounts ?? [])].sort().map((accountNumber) => ({ accountNumber, ...(names.get(accountNumber) ? { name: names.get(accountNumber) } : {}) })),
        paid: euro(paid), refunded: euro(refunded), net: euro(paid - refunded),
        months,
        entries: [...(topic?.entries ?? [])].sort((a, b) => b.postingDate.localeCompare(a.postingDate)),
      };
    }),
  };
};

// --- Geldkonto je Jahr -----------------------------------------------------------------------------------------

export interface MoneyAccountYear {
  chart: 'SKR03' | 'SKR04';
  /** Every money account with a booking, with its years. */
  accounts: Array<{ accountNumber: string; name?: string; firstYear: number; lastYear: number }>;
  accountNumber: string;
  name?: string;
  year: number;
  openingBalance: number;
  closingBalance: number;
  inflow: number;
  outflow: number;
  entryCount: number;
  months: Array<{ period: string; inflow: number; outflow: number; balance: number }>;
  /** What the money went to or came from: the counter accounts of the entries, largest first. */
  counterAccounts: Array<{ accountNumber: string; name?: string; position?: string; inflow: number; outflow: number; count: number }>;
  /** Grouped by the start of the booking text (the payee or payer as the bank wrote it). */
  topInflows: Array<{ label: string; amount: number; count: number }>;
  topOutflows: Array<{ label: string; amount: number; count: number }>;
}

/** The payee part of a booking text: up to a dash, "Referenz", "Originalbetrag" or a date, at most 40 characters. */
export const bookingTextLabel = (text: string): string => {
  const cut = text.split(/\s[–-]\s|\s+Referenz:|\s+Originalbetrag:|\s+\d{2}\.\d{2}\.\d{2,4}|,/)[0] ?? text;
  const clean = cut.replace(/\s+/g, ' ').trim();
  return (clean.length > 40 ? `${clean.slice(0, 39)}…` : clean) || 'Ohne Text';
};

export const getMoneyAccountYear = async (db: PostgresQueryable, scope: TenantScope, args: { accountNumber?: string; year?: number }): Promise<MoneyAccountYear> => {
  const t = scope.tenantId;
  const chart = await chartOf(db, t);
  const extent = (await q<{ account_number: string; first: string; last: string }>(db, `SELECT jl.account_number, MIN(je.posting_date) AS first, MAX(je.posting_date) AS last
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id AND je.tenant_id=jl.tenant_id
    WHERE jl.tenant_id=$1 AND je.status IN ('posted','reversed') AND ${RUNNING_JOURNAL} GROUP BY jl.account_number`, [t]))
    .filter((row) => isMoneyLedgerAccount(chart, String(row.account_number)))
    .sort((a, b) => String(a.account_number).localeCompare(String(b.account_number)));
  const names = await accountNames(db, t, chart, extent.map((row) => String(row.account_number)));
  const accounts = extent.map((row) => ({ accountNumber: String(row.account_number), ...(names.get(String(row.account_number)) ? { name: names.get(String(row.account_number)) } : {}), firstYear: Number(String(row.first).slice(0, 4)), lastYear: Number(String(row.last).slice(0, 4)) }));
  const accountNumber = args.accountNumber ?? accounts[0]?.accountNumber;
  if (!accountNumber || !isMoneyLedgerAccount(chart, accountNumber)) throw new Error('MONEY_ACCOUNT_INVALID');
  const known = accounts.find((account) => account.accountNumber === accountNumber);
  const year = args.year ?? known?.lastYear ?? new Date().getUTCFullYear();
  if (!Number.isInteger(year) || year < 1990 || year > 2100) throw new Error('ANALYTICS_RANGE_INVALID');
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  const opening = cents((await q<{ balance: string }>(db, `SELECT COALESCE(SUM(jl.debit_amount-jl.credit_amount),0) AS balance FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id AND je.tenant_id=jl.tenant_id
    WHERE jl.tenant_id=$1 AND jl.account_number=$2 AND je.status IN ('posted','reversed') AND ${RUNNING_JOURNAL} AND je.posting_date < $3`, [t, accountNumber, from]))[0]?.balance);
  const lines = await q<{ entry_id: string; posting_date: string; booking_text: string; account_number: string; debit_amount: string; credit_amount: string }>(db, `SELECT je.id AS entry_id, je.posting_date, je.booking_text, jl.account_number, jl.debit_amount, jl.credit_amount
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id AND je.tenant_id=jl.tenant_id
    WHERE jl.tenant_id=$1 AND je.status IN ('posted','reversed') AND ${RUNNING_JOURNAL} AND je.posting_date >= $2 AND je.posting_date <= $3
      AND je.id IN (SELECT entry_id FROM journal_lines WHERE tenant_id=$1 AND account_number=$4)
    ORDER BY je.posting_date, je.entry_number`, [t, from, to, accountNumber]);
  const byEntry = new Map<string, typeof lines>();
  for (const line of lines) byEntry.set(line.entry_id, [...(byEntry.get(line.entry_id) ?? []), line]);
  const roles = await accountRoleMappings(db, t, chart);
  const taxAccounts = new Set(Object.entries(roles).filter(([role]) => /(^|_)vat(_|$)/.test(role)).map(([, account]) => account));

  const months = Array.from({ length: 12 }, (_, index) => ({ period: `${year}-${pad(index + 1)}`, inflow: 0, outflow: 0, balance: 0 }));
  const counters = new Map<string, { inflow: number; outflow: number; count: number }>();
  const inflowTexts = new Map<string, { amount: number; count: number }>();
  const outflowTexts = new Map<string, { amount: number; count: number }>();
  for (const entryLines of byEntry.values()) {
    const own = entryLines.filter((line) => String(line.account_number) === accountNumber);
    const movement = own.reduce((sum, line) => sum + cents(line.debit_amount) - cents(line.credit_amount), 0);
    if (!movement) continue;
    const month = months[Number(String(own[0]!.posting_date).slice(5, 7)) - 1]!;
    if (movement > 0) month.inflow += movement; else month.outflow -= movement;
    const label = bookingTextLabel(String(own[0]!.booking_text ?? ''));
    const texts = movement > 0 ? inflowTexts : outflowTexts;
    const text = texts.get(label) ?? { amount: 0, count: 0 };
    text.amount += Math.abs(movement); text.count += 1;
    texts.set(label, text);
    // Counter accounts: the other lines; VAT lines are left out, they follow their net line.
    const others = entryLines.filter((line) => String(line.account_number) !== accountNumber);
    const nonTax = others.filter((line) => !taxAccounts.has(String(line.account_number)));
    const counted = nonTax.length ? nonTax : others;
    const total = counted.reduce((sum, line) => sum + Math.abs(cents(line.debit_amount) - cents(line.credit_amount)), 0) || 1;
    for (const line of counted) {
      const share = Math.round(Math.abs(movement) * Math.abs(cents(line.debit_amount) - cents(line.credit_amount)) / total);
      const entry = counters.get(String(line.account_number)) ?? { inflow: 0, outflow: 0, count: 0 };
      if (movement > 0) entry.inflow += share; else entry.outflow += share;
      entry.count += 1;
      counters.set(String(line.account_number), entry);
    }
  }
  let running = opening;
  for (const month of months) { running += month.inflow - month.outflow; month.balance = running; }
  const counterNames = await accountNames(db, t, chart, [...counters.keys()]);
  const labels = new Map(bwaLabels().map((position) => [position.key, position.label]));
  const ranked = (texts: Map<string, { amount: number; count: number }>) => [...texts].map(([label, value]) => ({ label, amount: euro(value.amount), count: value.count })).sort((a, b) => b.amount - a.amount).slice(0, 8);
  return {
    chart, accounts, accountNumber, ...(names.get(accountNumber) ? { name: names.get(accountNumber) } : {}), year,
    openingBalance: euro(opening), closingBalance: euro(running),
    inflow: euro(months.reduce((sum, month) => sum + month.inflow, 0)),
    outflow: euro(months.reduce((sum, month) => sum + month.outflow, 0)),
    entryCount: byEntry.size,
    months: months.map((month) => ({ period: month.period, inflow: euro(month.inflow), outflow: euro(month.outflow), balance: euro(month.balance) })),
    counterAccounts: [...counters].map(([account, value]) => {
      const position = isProfitAndLossAccount(chart, account) ? defaultReportPosition(chart, account, 'bwa01')?.position : undefined;
      return { accountNumber: account, ...(counterNames.get(account) ? { name: counterNames.get(account) } : {}), ...(position && labels.get(position) ? { position: labels.get(position) } : {}), inflow: euro(value.inflow), outflow: euro(value.outflow), count: value.count };
    }).sort((a, b) => (b.inflow + b.outflow) - (a.inflow + a.outflow)).slice(0, 15),
    topInflows: ranked(inflowTexts),
    topOutflows: ranked(outflowTexts),
  };
};

const bwaLabels = () => {
  try {
    return listReportMappingPositions('bwa01', 'small', new Date().toISOString().slice(0, 10));
  } catch {
    return [];
  }
};
