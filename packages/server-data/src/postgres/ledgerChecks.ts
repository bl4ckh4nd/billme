import { randomUUID } from 'node:crypto';
import { defaultReportPosition } from '@billme/accounting-engine';
import { isMoneyLedgerAccount, isProfitAndLossAccount, type AccountingMutationContext } from '@billme/accounting-shared';
import type { TenantScope } from '@billme/server-core';
import { runInTransaction, type PostgresQueryable } from './connection.js';
import { appendWithClient } from './audit.js';
import { accountRoleMappings } from './taxAccounts.js';
import { DATEV_AUTOMATIC_ACCOUNTS } from './datevAutomaticAccounts.js';
import { bookingTextLabel } from './taxAnalytics.js';

/**
 * Checks on the journal (Prüfungen) and the business partners behind the money movements (Geschäftspartner).
 *
 * The checks read posted entries (a reversed entry and its Storno are left out) and report findings a person can
 * mark as OK with a reason (ledger_check_dismissals); a later change of the data never reopens a dismissed finding
 * by itself, its subject key stays the same. The partners are named by the bank line's counterparty where the
 * entry came from a bank line, else by the start of the booking text.
 */

const RUNNING_JOURNAL = `COALESCE(je.source_type,'') NOT IN ('fiscal_close','carry_forward')`;
const q = async <T = any>(db: PostgresQueryable, text: string, values: unknown[] = []): Promise<T[]> => (await db.query(text, values)).rows as T[];
const cents = (value: unknown): number => Math.round(Number(value || 0) * 100);
const euro = (value: number): number => value / 100;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type LedgerCheckKey = 'vat_without_case' | 'private_on_corporation' | 'foreign_vat' | 'revenue_without_vat' | 'refund_as_revenue' | 'duplicate' | 'transit_open' | 'unmapped_account';
export type LedgerCheckSeverity = 'error' | 'warning' | 'info';

export interface LedgerCheckFinding {
  subjectKey: string;
  entryId?: string;
  entryNumber?: number;
  postingDate?: string;
  reference?: string;
  bookingText?: string;
  accountNumber?: string;
  amount?: number;
  detail: string;
  dismissed?: { reason: string; at: string; by?: string };
}

export interface LedgerCheck {
  key: LedgerCheckKey;
  label: string;
  description: string;
  severity: LedgerCheckSeverity;
  openCount: number;
  dismissedCount: number;
  findings: LedgerCheckFinding[];
}

export interface LedgerChecks {
  from?: string;
  to?: string;
  openErrors: number;
  openWarnings: number;
  openInfos: number;
  checks: LedgerCheck[];
}

const CHECKS: Record<LedgerCheckKey, { label: string; description: string; severity: LedgerCheckSeverity }> = {
  vat_without_case: { label: 'Steuerzeile ohne Steuerfall', description: 'Vor- oder Umsatzsteuer gebucht, aber keine Zeile der Buchung trägt einen Steuerfall: die UStVA zählt sie nicht.', severity: 'error' },
  private_on_corporation: { label: 'Privatkonto bei einer Kapitalgesellschaft', description: 'Eine GmbH oder UG hat keine Privatentnahmen; Gesellschaftervorgänge laufen über Verrechnungs- oder Darlehenskonten.', severity: 'error' },
  foreign_vat: { label: 'Auslandsanbieter mit deutscher Vorsteuer', description: 'Leistung eines Anbieters aus dem Ausland mit 19 % oder 7 % Vorsteuer: meist ist es § 13b (Reverse Charge), dann gibt es keine Vorsteuer aus der Rechnung.', severity: 'warning' },
  revenue_without_vat: { label: 'Erlös auf Konto mit Umsatzsteuer, aber ohne Steuer', description: 'Das Erlöskonto führt 19 % oder 7 % Umsatzsteuer, die Buchung hat keine. Steuerfrei wäre ein anderes Konto.', severity: 'warning' },
  refund_as_revenue: { label: 'Erstattung als Erlös gebucht', description: 'Der Buchungstext spricht von Erstattung, Gutschrift oder Retoure, gebucht ist ein Erlös: eine Erstattung mindert meist den Aufwand.', severity: 'warning' },
  duplicate: { label: 'Mögliche Dublette', description: 'Zwei Geldbewegungen mit gleichem Betrag und gleichem Partner innerhalb von drei Tagen.', severity: 'warning' },
  transit_open: { label: 'Geldtransit nicht ausgeglichen', description: 'Auf dem Geldtransit bleibt im Monat ein Saldo: eine Seite einer Umbuchung zwischen eigenen Konten fehlt.', severity: 'warning' },
  unmapped_account: { label: 'Konto ohne GuV-Zuordnung', description: 'Das Erfolgskonto fällt in keinen Bereich der GuV; Auswertungen zeigen es als nicht zugeordnet.', severity: 'info' },
};

/** Text hints of a provider abroad (currency, place, legal form, well-known non-German services). */
const FOREIGN = /\b(USD|GBP|CHF|SEK|DKK|PLN)\b|Originalbetrag|Wechselkurs|\bIreland\b|\bIrland\b|\bDublin\b|Luxemb|San Francisco|New York|Seattle|Palo Alto|Mountain View|Redmond|\bDelaware\b|\bUSA?\b|\bInc\b\.?|\bLLC\b|\bLtd\b\.?|\bLimited\b|\bB\.V\.|\bAWS\b|aws\.amazon|Amazon Web Services|Google Cloud|OpenAI|GitHub|Namecheap|Cloudflare|DigitalOcean|Zapier|Atlassian|Slack|Notion|Figma|Webflow|Bitwarden|\bmake\.com/i;
/** A refund in the text. "Gutschrift" alone is how banks name any incoming transfer ("Umsatzart: Gutschrift"); only a credit note counts. */
const REFUND = /erstatt|rückerstatt|rückgutschrift|refund|retoure|storno|zurückerstattet|gutschrift\s+(zu|zur|für|nr\b|rechnung|re\b)/i;
const BANK_TRANSACTION_TYPE = /Umsatzart:\s*[^,;]+/gi;
const REVENUE_POSITIONS = new Set(['revenue', 'special-operating-income']);

type Line = { entry_id: string; entry_number: string; posting_date: string; reference: string | null; booking_text: string; source_type: string | null; account_number: string; debit_amount: string; credit_amount: string; tax_case_key: string | null; counterparty: string | null };

const loadLines = async (db: PostgresQueryable, t: string, from?: string, to?: string): Promise<Line[]> => q<Line>(db, `SELECT je.id AS entry_id, je.entry_number, je.posting_date, je.reference, je.booking_text, je.source_type, jl.account_number, jl.debit_amount, jl.credit_amount, jl.tax_case_key,
    NULLIF(btrim(bt.counterparty), '') AS counterparty
  FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id AND je.tenant_id=jl.tenant_id
  LEFT JOIN booking_drafts bd ON bd.tenant_id=je.tenant_id AND bd.id=je.source_draft_id
  LEFT JOIN bank_transactions bt ON bt.tenant_id=je.tenant_id AND bt.id=bd.transaction_id
  WHERE jl.tenant_id=$1 AND je.status='posted' AND COALESCE(je.source_type,'')<>'reversal' AND ${RUNNING_JOURNAL}
    AND ($2::text IS NULL OR je.posting_date >= $2) AND ($3::text IS NULL OR je.posting_date <= $3)
  ORDER BY je.posting_date, je.entry_number, jl.line_no`, [t, from ?? null, to ?? null]);

const groupByEntry = (lines: Line[]) => {
  const out = new Map<string, Line[]>();
  for (const line of lines) out.set(line.entry_id, [...(out.get(line.entry_id) ?? []), line]);
  return out;
};

const chartOf = async (db: PostgresQueryable, t: string): Promise<'SKR03' | 'SKR04'> =>
  (await q<{ active_chart: string }>(db, `SELECT active_chart FROM accounting_policies WHERE tenant_id=$1`, [t]))[0]?.active_chart === 'SKR04' ? 'SKR04' : 'SKR03';

const assertRange = (from?: string, to?: string) => {
  if ((from && !ISO_DATE.test(from)) || (to && !ISO_DATE.test(to)) || (from && to && from > to)) throw new Error('ANALYTICS_RANGE_INVALID');
};

/** The partner of an entry: the bank line's counterparty, else the payee part of the booking text. */
const partnerOf = (lines: Line[]): string => lines.find((line) => line.counterparty)?.counterparty?.trim() || bookingTextLabel(String(lines[0]?.booking_text ?? ''));

export const getLedgerChecks = async (db: PostgresQueryable, scope: TenantScope, args: { from?: string; to?: string } = {}): Promise<LedgerChecks> => {
  assertRange(args.from, args.to);
  const t = scope.tenantId;
  const chart = await chartOf(db, t);
  const roles = await accountRoleMappings(db, t, chart);
  const vatAccounts = new Set(Object.entries(roles).filter(([role]) => /(^|_)vat(_|$)/.test(role)).map(([, account]) => account));
  const settings = (await q<{ settings_json: unknown }>(db, `SELECT settings_json FROM server_settings WHERE tenant_id=$1 LIMIT 1`, [t]))[0]?.settings_json;
  const parsedSettings = (typeof settings === 'string' ? JSON.parse(settings) : settings) as { businessReportingProfile?: { legalForm?: string } } | undefined;
  const corporation = ['gmbh', 'ug'].includes(parsedSettings?.businessReportingProfile?.legalForm ?? '');
  const explicit = new Set((await q<{ account_number: string }>(db, `SELECT DISTINCT account_number FROM report_account_mappings WHERE tenant_id=$1 AND chart=$2 AND report_type IN ('hgb-guv','bwa01')`, [t, chart])).map((row) => String(row.account_number)));
  const automatic = DATEV_AUTOMATIC_ACCOUNTS[chart];
  const lines = await loadLines(db, t, args.from, args.to);
  const entries = groupByEntry(lines);
  const findings = new Map<LedgerCheckKey, LedgerCheckFinding[]>((Object.keys(CHECKS) as LedgerCheckKey[]).map((key) => [key, []]));
  const entryFinding = (key: LedgerCheckKey, entryLines: Line[], detail: string, extra: Partial<LedgerCheckFinding> = {}) => {
    const first = entryLines[0]!;
    findings.get(key)!.push({ subjectKey: first.entry_id, entryId: first.entry_id, entryNumber: Number(first.entry_number), postingDate: String(first.posting_date), ...(first.reference ? { reference: first.reference } : {}), bookingText: first.booking_text, detail, ...extra });
  };
  const privateRange = chart === 'SKR04' ? [2100, 2199] : [1800, 1899];
  const moving: Array<{ entryId: string; date: string; amount: number; partner: string; lines: Line[] }> = [];

  for (const entryLines of entries.values()) {
    const amountOf = (line: Line) => cents(line.debit_amount) - cents(line.credit_amount);
    const hasCase = entryLines.some((line) => line.tax_case_key);
    const vatLine = entryLines.find((line) => vatAccounts.has(String(line.account_number)));
    if (vatLine && !hasCase) entryFinding('vat_without_case', entryLines, `Konto ${vatLine.account_number}: ${euro(Math.abs(amountOf(vatLine))).toFixed(2).replace('.', ',')} € ohne Steuerfall`, { accountNumber: String(vatLine.account_number), amount: euro(amountOf(vatLine)) });
    if (corporation) {
      const privateLine = entryLines.find((line) => /^\d{4}$/.test(line.account_number) && Number(line.account_number) >= privateRange[0]! && Number(line.account_number) <= privateRange[1]!);
      if (privateLine) entryFinding('private_on_corporation', entryLines, `Konto ${privateLine.account_number}`, { accountNumber: String(privateLine.account_number), amount: euro(amountOf(privateLine)) });
    }
    const text = entryLines.map((line) => `${line.booking_text} ${line.counterparty ?? ''}`).join(' ').replace(BANK_TRANSACTION_TYPE, ' ');
    const foreign = entryLines.find((line) => (line.tax_case_key === 'DE_STD_19' || line.tax_case_key === 'DE_STD_7') && amountOf(line) > 0 && isProfitAndLossAccount(chart, String(line.account_number)));
    if (foreign && FOREIGN.test(text)) entryFinding('foreign_vat', entryLines, `${foreign.tax_case_key === 'DE_STD_7' ? '7' : '19'} % Vorsteuer auf Konto ${foreign.account_number}`, { accountNumber: String(foreign.account_number), amount: euro(amountOf(foreign)) });
    for (const line of entryLines) {
      const account = String(line.account_number);
      if (!isProfitAndLossAccount(chart, account) || amountOf(line) >= 0) continue;
      const position = defaultReportPosition(chart, account, 'bwa01')?.position;
      if (!position || !REVENUE_POSITIONS.has(position)) continue;
      if ((automatic[account] ?? 0) > 0 && !line.tax_case_key && !hasCase) {
        entryFinding('revenue_without_vat', entryLines, `Konto ${account} (${automatic[account]} %)`, { accountNumber: account, amount: euro(-amountOf(line)) });
      }
      if (REFUND.test(text)) entryFinding('refund_as_revenue', entryLines, `Erlös auf Konto ${account}`, { accountNumber: account, amount: euro(-amountOf(line)) });
      break;
    }
    const money = entryLines.filter((line) => isMoneyLedgerAccount(chart, String(line.account_number)));
    if (money.length && !entryLines.every((line) => isMoneyLedgerAccount(chart, String(line.account_number)) || line.account_number === roles.transit)) {
      const amount = money.reduce((sum, line) => sum + amountOf(line), 0);
      if (amount) moving.push({ entryId: entryLines[0]!.entry_id, date: String(entryLines[0]!.posting_date), amount, partner: partnerOf(entryLines).toLocaleLowerCase('de-DE'), lines: entryLines });
    }
  }

  // Dubletten: same signed amount and partner within three days.
  const byKey = new Map<string, typeof moving>();
  for (const item of moving) byKey.set(`${item.amount}|${item.partner}`, [...(byKey.get(`${item.amount}|${item.partner}`) ?? []), item]);
  for (const group of byKey.values()) {
    for (let index = 1; index < group.length; index += 1) {
      const previous = group[index - 1]!; const current = group[index]!;
      const days = (Date.parse(current.date) - Date.parse(previous.date)) / 86_400_000;
      if (days > 3) continue;
      entryFinding('duplicate', current.lines, `Gleicher Betrag und Partner wie Buchung ${previous.lines[0]!.entry_number} vom ${previous.date.slice(8, 10)}.${previous.date.slice(5, 7)}.`, { subjectKey: [previous.entryId, current.entryId].sort().join('|'), amount: euro(current.amount) });
    }
  }

  // Geldtransit per month.
  const transit = roles.transit;
  const transitByMonth = new Map<string, number>();
  for (const line of lines) if (line.account_number === transit) transitByMonth.set(String(line.posting_date).slice(0, 7), (transitByMonth.get(String(line.posting_date).slice(0, 7)) ?? 0) + cents(line.debit_amount) - cents(line.credit_amount));
  for (const [period, balance] of [...transitByMonth].sort(([a], [b]) => a.localeCompare(b))) {
    if (balance) findings.get('transit_open')!.push({ subjectKey: period, postingDate: `${period}-01`, accountNumber: transit, amount: euro(balance), detail: `Saldo ${period}: ${euro(balance).toFixed(2).replace('.', ',')} €` });
  }

  // Erfolgskonten without a GuV position.
  const pnlAccounts = new Set(lines.map((line) => String(line.account_number)).filter((account) => isProfitAndLossAccount(chart, account)));
  for (const account of [...pnlAccounts].sort()) {
    if (explicit.has(account) || defaultReportPosition(chart, account, 'hgb-guv')) continue;
    const total = lines.filter((line) => line.account_number === account).reduce((sum, line) => sum + cents(line.debit_amount) - cents(line.credit_amount), 0);
    findings.get('unmapped_account')!.push({ subjectKey: account, accountNumber: account, amount: euro(total), detail: `Konto ${account}` });
  }

  const dismissals = new Map((await q<{ check_key: string; subject_key: string; reason: string; dismissed_by: string | null; created_at: string }>(db, `SELECT check_key,subject_key,reason,dismissed_by,created_at FROM ledger_check_dismissals WHERE tenant_id=$1`, [t]))
    .map((row) => [`${row.check_key}|${row.subject_key}`, { reason: row.reason, at: row.created_at, ...(row.dismissed_by ? { by: row.dismissed_by } : {}) }]));
  const checks = (Object.keys(CHECKS) as LedgerCheckKey[]).map((key): LedgerCheck => {
    const list = findings.get(key)!.map((finding) => {
      const dismissed = dismissals.get(`${key}|${finding.subjectKey}`);
      return dismissed ? { ...finding, dismissed } : finding;
    });
    const dismissedCount = list.filter((finding) => finding.dismissed).length;
    return { key, ...CHECKS[key], openCount: list.length - dismissedCount, dismissedCount, findings: list };
  });
  const open = (severity: LedgerCheckSeverity) => checks.filter((check) => check.severity === severity).reduce((sum, check) => sum + check.openCount, 0);
  return { ...(args.from ? { from: args.from } : {}), ...(args.to ? { to: args.to } : {}), openErrors: open('error'), openWarnings: open('warning'), openInfos: open('info'), checks };
};

/** Marks a finding as OK (with a reason) or opens it again; audited either way. */
export const setLedgerCheckDismissal = async (db: PostgresQueryable, scope: TenantScope, input: { checkKey: LedgerCheckKey; subjectKey: string; dismissed: boolean; reason: string; mutation?: AccountingMutationContext }): Promise<{ dismissed: boolean }> => {
  if (!(input.checkKey in CHECKS)) throw new Error('LEDGER_CHECK_UNKNOWN');
  const subjectKey = input.subjectKey.trim();
  const reason = input.reason.trim();
  if (!subjectKey || !reason) throw new Error('LEDGER_CHECK_REASON_REQUIRED');
  return runInTransaction(db, async (tx) => {
    const t = scope.tenantId;
    if (input.dismissed) {
      await tx.query(`INSERT INTO ledger_check_dismissals (id,tenant_id,check_key,subject_key,reason,dismissed_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (tenant_id,check_key,subject_key) DO UPDATE SET reason=EXCLUDED.reason,dismissed_by=EXCLUDED.dismissed_by,created_at=EXCLUDED.created_at`,
        [randomUUID(), t, input.checkKey, subjectKey, reason, input.mutation?.actor?.displayName ?? null, new Date().toISOString()]);
    } else {
      await tx.query(`DELETE FROM ledger_check_dismissals WHERE tenant_id=$1 AND check_key=$2 AND subject_key=$3`, [t, input.checkKey, subjectKey]);
    }
    await appendWithClient(tx, scope, {
      occurredAt: new Date().toISOString(), action: input.dismissed ? 'dismiss' : 'reopen', reason,
      actor: input.mutation?.actor ?? { type: 'service', displayName: 'server-accounting' },
      subject: { entityType: 'ledger_check', entityId: `${input.checkKey}:${subjectKey}`, tenantId: t },
      change: { before: null, after: { checkKey: input.checkKey, subjectKey, dismissed: input.dismissed } },
    });
    return { dismissed: input.dismissed };
  });
};

// --- Geschäftspartner ------------------------------------------------------------------------------------------

export interface LedgerPartner {
  name: string;
  income: number;
  expense: number;
  net: number;
  count: number;
  firstDate: string;
  lastDate: string;
  /** Most used counter account (Erfolgskonto) and its BWA position. */
  topAccount?: string;
}

export interface LedgerPartnerDetail {
  name: string;
  income: number;
  expense: number;
  net: number;
  count: number;
  months: Array<{ period: string; income: number; expense: number }>;
  entries: Array<{ entryId: string; entryNumber: number; postingDate: string; reference?: string; bookingText: string; amount: number }>;
}

const partnerMovements = async (db: PostgresQueryable, scope: TenantScope, from?: string, to?: string) => {
  const t = scope.tenantId;
  const chart = await chartOf(db, t);
  const roles = await accountRoleMappings(db, t, chart);
  const entries = groupByEntry(await loadLines(db, t, from, to));
  const out: Array<{ name: string; entryId: string; entryNumber: number; postingDate: string; reference?: string; bookingText: string; amount: number; account?: string }> = [];
  for (const entryLines of entries.values()) {
    const money = entryLines.filter((line) => isMoneyLedgerAccount(chart, String(line.account_number)));
    if (!money.length) continue;
    // Own transfers (money and Geldtransit only) have no partner.
    if (entryLines.every((line) => isMoneyLedgerAccount(chart, String(line.account_number)) || line.account_number === roles.transit)) continue;
    const amount = money.reduce((sum, line) => sum + cents(line.debit_amount) - cents(line.credit_amount), 0);
    if (!amount) continue;
    const counter = entryLines.filter((line) => isProfitAndLossAccount(chart, String(line.account_number))).sort((a, b) => Math.abs(cents(b.debit_amount) - cents(b.credit_amount)) - Math.abs(cents(a.debit_amount) - cents(a.credit_amount)))[0];
    const first = entryLines[0]!;
    out.push({ name: partnerOf(entryLines), entryId: first.entry_id, entryNumber: Number(first.entry_number), postingDate: String(first.posting_date), ...(first.reference ? { reference: first.reference } : {}), bookingText: first.booking_text, amount, ...(counter ? { account: String(counter.account_number) } : {}) });
  }
  return { chart, movements: out };
};

export const getLedgerPartners = async (db: PostgresQueryable, scope: TenantScope, args: { from?: string; to?: string } = {}): Promise<{ from?: string; to?: string; partners: LedgerPartner[] }> => {
  assertRange(args.from, args.to);
  const { chart, movements } = await partnerMovements(db, scope, args.from, args.to);
  const names = new Map<string, string>();
  const byPartner = new Map<string, { name: string; income: number; expense: number; count: number; first: string; last: string; accounts: Map<string, number> }>();
  for (const item of movements) {
    const key = item.name.toLocaleLowerCase('de-DE');
    const entry = byPartner.get(key) ?? { name: item.name, income: 0, expense: 0, count: 0, first: item.postingDate, last: item.postingDate, accounts: new Map() };
    if (item.amount > 0) entry.income += item.amount; else entry.expense -= item.amount;
    entry.count += 1;
    if (item.postingDate < entry.first) entry.first = item.postingDate;
    if (item.postingDate > entry.last) entry.last = item.postingDate;
    if (item.account) entry.accounts.set(item.account, (entry.accounts.get(item.account) ?? 0) + 1);
    byPartner.set(key, entry);
  }
  const accounts = [...new Set([...byPartner.values()].flatMap((entry) => [...entry.accounts.keys()]))];
  if (accounts.length) {
    const rows = await q<{ account_number: string; name: string }>(db, `SELECT n.account_number, COALESCE(tla.name, la.name, '') AS name FROM unnest($3::text[]) AS n(account_number)
      LEFT JOIN tenant_ledger_accounts tla ON tla.tenant_id=$1 AND tla.chart=$2 AND tla.account_number=n.account_number
      LEFT JOIN ledger_accounts la ON la.chart=$2 AND la.account_number=n.account_number`, [scope.tenantId, chart, accounts]);
    for (const row of rows) names.set(String(row.account_number), String(row.name ?? ''));
  }
  const partners = [...byPartner.values()].map((entry): LedgerPartner => {
    const top = [...entry.accounts].sort((a, b) => b[1] - a[1])[0]?.[0];
    return {
      name: entry.name, income: euro(entry.income), expense: euro(entry.expense), net: euro(entry.income - entry.expense), count: entry.count, firstDate: entry.first, lastDate: entry.last,
      ...(top ? { topAccount: `${top}${names.get(top) ? ` ${names.get(top)}` : ''}` } : {}),
    };
  }).sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  return { ...(args.from ? { from: args.from } : {}), ...(args.to ? { to: args.to } : {}), partners };
};

export const getLedgerPartnerDetail = async (db: PostgresQueryable, scope: TenantScope, args: { name: string; from?: string; to?: string }): Promise<LedgerPartnerDetail> => {
  assertRange(args.from, args.to);
  const key = args.name.trim().toLocaleLowerCase('de-DE');
  if (!key) throw new Error('LEDGER_PARTNER_REQUIRED');
  const { movements } = await partnerMovements(db, scope, args.from, args.to);
  const mine = movements.filter((item) => item.name.toLocaleLowerCase('de-DE') === key);
  const months = new Map<string, { income: number; expense: number }>();
  for (const item of mine) {
    const month = months.get(item.postingDate.slice(0, 7)) ?? { income: 0, expense: 0 };
    if (item.amount > 0) month.income += item.amount; else month.expense -= item.amount;
    months.set(item.postingDate.slice(0, 7), month);
  }
  const income = mine.filter((item) => item.amount > 0).reduce((sum, item) => sum + item.amount, 0);
  const expense = mine.filter((item) => item.amount < 0).reduce((sum, item) => sum - item.amount, 0);
  return {
    name: mine[0]?.name ?? args.name.trim(),
    income: euro(income), expense: euro(expense), net: euro(income - expense), count: mine.length,
    months: [...months].sort(([a], [b]) => a.localeCompare(b)).map(([period, month]) => ({ period, income: euro(month.income), expense: euro(month.expense) })),
    entries: [...mine].sort((a, b) => b.postingDate.localeCompare(a.postingDate)).slice(0, 50).map((item) => ({ entryId: item.entryId, entryNumber: item.entryNumber, postingDate: item.postingDate, ...(item.reference ? { reference: item.reference } : {}), bookingText: item.bookingText, amount: euro(item.amount) })),
  };
};
