import {
  assertEurUsesCalendarYear,
  fiscalYearForDate,
  fiscalYearRange,
} from '@billme/accounting-shared';
import type {
  BusinessReportingProfile,
  Bwa01Report,
  CashInputEntry,
  HgbBilanzReport,
  HgbGuvReport,
  LedgerInput,
  LedgerInputEntry,
  ManagementGuvReport,
  MappingHealth,
  ReportKind,
  ReportRequest,
  ReportResult,
  ReportSnapshot,
  ReportingLine,
  ReportingMapping,
  SusaReport,
  EurLedgerReconciliationReport,
} from '@billme/accounting-shared';

type Cents = number;

interface Aggregate {
  accountNumber: string;
  opening: Cents;
  debit: Cents;
  credit: Cents;
}

interface ResolvedMapping extends ReportingMapping {
  inferred?: boolean;
}

interface ReportingContext {
  request: ReportRequest;
  profile: BusinessReportingProfile;
  from?: string;
  to?: string;
  asOfDate?: string;
  rows: Aggregate[];
  mappings: Map<string, ResolvedMapping>;
  mappingHealth: MappingHealth;
  snapshot: ReportSnapshot;
}

const cents = (value: number | undefined): Cents => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
};

const amount = (value: Cents): number => value / 100;

const add = (map: Map<string, Aggregate>, accountNumber: string): Aggregate => {
  const current = map.get(accountNumber) ?? { accountNumber, opening: 0, debit: 0, credit: 0 };
  map.set(accountNumber, current);
  return current;
};

const inRange = (date: string, from?: string, to?: string): boolean =>
  (!from || date >= from) && (!to || date <= to);

const maxDate = (entries: LedgerInputEntry[]): string | undefined =>
  entries.map((entry) => entry.postingDate).sort().at(-1);

function periodOf(request: ReportRequest): { from?: string; to?: string; asOfDate?: string } {
  return {
    from: request.from ?? request.period?.from,
    to: request.to ?? request.period?.to ?? request.asOfDate ?? request.period?.asOfDate,
    asOfDate: request.asOfDate ?? request.period?.asOfDate ?? request.to ?? request.period?.to,
  };
}

function validateProfile(profile: BusinessReportingProfile): void {
  if (!Number.isInteger(profile.fiscalYearStart) || profile.fiscalYearStart < 1 || profile.fiscalYearStart > 12) {
    throw new RangeError('fiscalYearStart must be a month from 1 to 12');
  }
}

function defaultMapping(accountNumber: string): ResolvedMapping | undefined {
  const first = accountNumber.trim()[0];
  if (!first || !/^[0-8]$/.test(first)) return undefined;
  if (first <= '3') {
    return {
      accountNumber,
      statement: 'bilanz',
      position: first <= '1' ? 'assets' : 'liabilities',
      side: first <= '1' ? 'asset' : 'liability',
      inferred: true,
    };
  }
  if (first <= '7') {
    return { accountNumber, statement: ['bwa', 'guv', 'eur'], position: 'operating_expenses', inferred: true };
  }
  return { accountNumber, statement: ['bwa', 'guv', 'eur'], position: 'revenue', inferred: true };
}

function statements(mapping: ReportingMapping): string[] {
  return typeof mapping.statement === 'string' ? [mapping.statement] : [...mapping.statement];
}

function makeContext(request: ReportRequest): ReportingContext {
  validateProfile(request.profile);
  const { from, to, asOfDate } = periodOf(request);
  const entries = request.ledger.entries ?? [];
  const cashEntries = request.cash?.entries ?? [];
  const sourceEntries = entries.length > 0 ? entries : undefined;
  const aggregates = new Map<string, Aggregate>();

  if (!sourceEntries) {
    for (const balance of request.ledger.balances ?? []) {
      const row = add(aggregates, balance.accountNumber);
      row.opening += cents(balance.openingBalance);
      row.debit += cents(balance.debitTurnover);
      row.credit += cents(balance.creditTurnover);
    }
  } else {
    for (const entry of sourceEntries) {
      if (entry.status === 'void') continue;
      for (const line of entry.lines) {
        const row = add(aggregates, line.accountNumber);
        const debit = cents(line.debit);
        const credit = cents(line.credit);
        if (from && entry.postingDate < from) row.opening += debit - credit;
        else if (inRange(entry.postingDate, from, to)) {
          row.debit += debit;
          row.credit += credit;
        }
      }
    }
    // A balance snapshot may contain accounts not represented by the selected
    // journal slice. It is useful for a report, but never double-counts entries.
    for (const balance of request.ledger.balances ?? []) {
      if (aggregates.has(balance.accountNumber)) continue;
      const row = add(aggregates, balance.accountNumber);
      row.opening = cents(balance.openingBalance);
      row.debit = cents(balance.debitTurnover);
      row.credit = cents(balance.creditTurnover);
    }
  }

  const mappings = new Map<string, ResolvedMapping>();
  for (const mapping of request.mappings ?? []) mappings.set(mapping.accountNumber, mapping);
  const ledgerAccountNumbers = [...aggregates.keys()];
  const accounts = [...new Set([
    ...aggregates.keys(),
    ...cashEntries.flatMap((entry) => entry.accountNumber ? [entry.accountNumber] : []),
  ])].sort();
  const inferredAccounts: string[] = [];
  const unmappedAccounts: string[] = [];
  for (const accountNumber of accounts) {
    const mapping = mappings.get(accountNumber) ?? defaultMapping(accountNumber);
    if (mapping) {
      mappings.set(accountNumber, mapping);
      if (mapping.inferred) inferredAccounts.push(accountNumber);
    } else unmappedAccounts.push(accountNumber);
  }
  const warnings = [
    ...(inferredAccounts.length ? [`${inferredAccounts.length} account(s) use inferred report mappings`] : []),
    ...(unmappedAccounts.length ? [`${unmappedAccounts.length} account(s) have no report mapping`] : []),
  ];
  const health: MappingHealth = {
    mappedAccounts: accounts.length - inferredAccounts.length - unmappedAccounts.length,
    inferredAccounts: inferredAccounts.length,
    unmappedAccounts,
    warnings,
    blocking: unmappedAccounts.length > 0,
  };
  const effectiveAsOfDate = asOfDate ?? to ?? maxDate(entries);
  const snapshot: ReportSnapshot = {
    from,
    to,
    asOfDate: effectiveAsOfDate,
    fiscalYear: effectiveAsOfDate ? fiscalYearForDate(effectiveAsOfDate, request.profile.fiscalYearStart) : 0,
    fiscalYearStart: request.profile.fiscalYearStart,
    fiscalYearRange: effectiveAsOfDate
      ? fiscalYearRange(fiscalYearForDate(effectiveAsOfDate, request.profile.fiscalYearStart), request.profile.fiscalYearStart)
      : undefined,
    businessSize: request.profile.size,
    ledgerEntryCount: entries.length,
    ledgerAccountCount: ledgerAccountNumbers.length,
    cashEntryCount: cashEntries.length,
  };
  return { request, profile: request.profile, from, to, asOfDate: effectiveAsOfDate, rows: [...aggregates.values()].sort((a, b) => a.accountNumber.localeCompare(b.accountNumber)), mappings, mappingHealth: health, snapshot };
}

function hasStatement(mapping: ReportingMapping | undefined, statement: string): boolean {
  return Boolean(mapping && statements(mapping).includes(statement));
}

function signedTurnover(row: Aggregate): Cents {
  return row.credit - row.debit;
}

function balanceSide(mapping: ReportingMapping): 'asset' | 'liability' | undefined {
  if (mapping.side) return mapping.side;
  if (/asset|aktiva|bank|cash|receivable|inventory/i.test(mapping.position)) return 'asset';
  if (/liabil|passiva|equity|payable|debt/i.test(mapping.position)) return 'liability';
  return undefined;
}

function balance(row: Aggregate): Cents {
  return row.opening + row.debit - row.credit;
}

function lineLabel(mapping: ResolvedMapping, position: string): string {
  return mapping.label ?? position.replaceAll('_', ' ');
}

function groupedLines(context: ReportingContext, statement: 'bwa' | 'guv' | 'eur', aliases = new Map<string, string>()): ReportingLine[] {
  const grouped = new Map<string, { label: string; amount: Cents; accounts: Set<string> }>();
  for (const row of context.rows) {
    const mapping = context.mappings.get(row.accountNumber);
    if (!hasStatement(mapping, statement) || !mapping) continue;
    const position = aliases.get(mapping.position) ?? mapping.position;
    const current = grouped.get(position) ?? { label: lineLabel(mapping, position), amount: 0, accounts: new Set<string>() };
    current.amount += signedTurnover(row);
    current.accounts.add(row.accountNumber);
    grouped.set(position, current);
  }
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([position, value]) => ({
    position,
    label: value.label,
    amount: amount(value.amount),
    accountNumbers: [...value.accounts].sort(),
  }));
}

function envelope<T extends object>(context: ReportingContext, kind: ReportKind, report: T): ReportResult<T> {
  return { ...report, kind, snapshot: context.snapshot, mappingHealth: context.mappingHealth };
}

export function calculateSusa(request: ReportRequest): ReportResult<SusaReport> {
  const context = makeContext(request);
  const rows = context.rows.map((row) => {
    const mapping = context.mappings.get(row.accountNumber);
    return {
      accountNumber: row.accountNumber,
      openingBalance: amount(row.opening),
      debitTurnover: amount(row.debit),
      creditTurnover: amount(row.credit),
      closingBalance: amount(balance(row)),
      mappedTo: mapping?.position,
      label: mapping?.label,
    };
  });
  return envelope(context, 'susa', {
    rows,
    totals: {
      debit: amount(rows.reduce((sum, row) => sum + cents(row.debitTurnover), 0)),
      credit: amount(rows.reduce((sum, row) => sum + cents(row.creditTurnover), 0)),
      balance: amount(rows.reduce((sum, row) => sum + cents(row.closingBalance), 0)),
    },
  });
}

const bwaAliases = new Map([
  ['sales', 'revenue'],
  ['umsatz', 'revenue'],
  ['wareneinsatz', 'materials'],
  ['material', 'materials'],
  ['personalkosten', 'personnel'],
  ['afa', 'depreciation'],
  ['abschreibungen', 'depreciation'],
]);

export function calculateBwa01(request: ReportRequest): ReportResult<Bwa01Report> {
  const context = makeContext(request);
  const rows = groupedLines(context, 'bwa', bwaAliases);
  const revenue = rows.filter((row) => row.position === 'revenue').reduce((sum, row) => sum + cents(row.amount), 0);
  const expenses = rows.filter((row) => row.position !== 'revenue' && row.amount < 0).reduce((sum, row) => sum + Math.abs(cents(row.amount)), 0);
  return envelope(context, 'bwa01', { rows, totals: { revenue: amount(revenue), expenses: amount(expenses), operatingResult: amount(rows.reduce((sum, row) => sum + cents(row.amount), 0)) } });
}

export function calculateManagementGuv(request: ReportRequest): ReportResult<ManagementGuvReport> {
  const context = makeContext(request);
  const rows = groupedLines(context, 'guv', bwaAliases);
  return envelope(context, 'management-guv', { rows, netResult: amount(rows.reduce((sum, row) => sum + cents(row.amount), 0)) });
}

const hgbPositions = [
  ['revenue', 'Umsatzerlöse'],
  ['inventory_change', 'Erhöhung oder Verminderung des Bestands'],
  ['own_work', 'Andere aktivierte Eigenleistungen'],
  ['other_operating_income', 'Sonstige betriebliche Erträge'],
  ['materials', 'Materialaufwand'],
  ['personnel', 'Personalaufwand'],
  ['depreciation', 'Abschreibungen'],
  ['other_operating_expenses', 'Sonstige betriebliche Aufwendungen'],
  ['financial_income', 'Erträge aus Beteiligungen und Wertpapieren'],
  ['financial_expenses', 'Zinsen und ähnliche Aufwendungen'],
  ['taxes', 'Steuern vom Einkommen und vom Ertrag'],
] as const;

const hgbAliases = new Map([
  ['sales', 'revenue'],
  ['umsatz', 'revenue'],
  ['material', 'materials'],
  ['wareneinsatz', 'materials'],
  ['personalkosten', 'personnel'],
  ['afa', 'depreciation'],
  ['abschreibungen', 'depreciation'],
  ['operating_expenses', 'other_operating_expenses'],
  ['interest_expense', 'financial_expenses'],
  ['interest_income', 'financial_income'],
]);

export function calculateHgbGuv(request: ReportRequest): ReportResult<HgbGuvReport> {
  const context = makeContext(request);
  const grouped = new Map(groupedLines(context, 'guv', hgbAliases).map((line) => [line.position, line]));
  const rows: ReportingLine[] = hgbPositions.map(([position, label]) => grouped.get(position) ?? { position, label, amount: 0, accountNumbers: [] });
  const netResult = amount(rows.reduce((sum, row) => sum + cents(row.amount), 0));
  return envelope(context, 'hgb-guv', { method: 'gkv', rows, netResult });
}

export function calculateHgbBilanz(request: ReportRequest): ReportResult<HgbBilanzReport> {
  const context = makeContext(request);
  const grouped = new Map<string, { label: string; side: 'asset' | 'liability'; amount: Cents; accounts: Set<string> }>();
  for (const row of context.rows) {
    const mapping = context.mappings.get(row.accountNumber);
    const side = mapping ? balanceSide(mapping) : undefined;
    if (!hasStatement(mapping, 'bilanz') || !mapping || !side) continue;
    const current = grouped.get(mapping.position) ?? { label: lineLabel(mapping, mapping.position), side, amount: 0, accounts: new Set<string>() };
    current.amount += side === 'asset' ? balance(row) : -balance(row);
    current.accounts.add(row.accountNumber);
    grouped.set(mapping.position, current);
  }
  const makeLines = (side: 'asset' | 'liability'): ReportingLine[] => [...grouped.entries()]
    .filter(([, value]) => value.side === side)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([position, value]) => ({ position, label: value.label, amount: amount(value.amount), accountNumbers: [...value.accounts].sort() }));
  const assets = makeLines('asset');
  const liabilities = makeLines('liability');
  const totalAssets = assets.reduce((sum, row) => sum + cents(row.amount), 0);
  const totalLiabilities = liabilities.reduce((sum, row) => sum + cents(row.amount), 0);
  return envelope(context, 'hgb-bilanz', { assets, liabilities, totals: { assets: amount(totalAssets), liabilities: amount(totalLiabilities), delta: amount(totalAssets - totalLiabilities) } });
}

function cashAmount(entries: CashInputEntry[], kinds: CashInputEntry['kind'][], from?: string, to?: string): Cents {
  return entries.filter((entry) => kinds.includes(entry.kind) && inRange(entry.date, from, to)).reduce((sum, entry) => sum + Math.abs(cents(entry.amount)), 0);
}

export function reconcileEurToLedger(request: ReportRequest): ReportResult<EurLedgerReconciliationReport> {
  assertEurUsesCalendarYear(request.profile);
  const context = makeContext(request);
  const cash = request.cash?.entries ?? [];
  const cashIncome = cashAmount(cash, ['income'], context.from, context.to);
  const cashExpenses = cashAmount(cash, ['expense', 'tax'], context.from, context.to);
  const eurRows = groupedLines(context, 'eur', hgbAliases);
  const ledgerIncome = eurRows.filter((row) => row.amount > 0).reduce((sum, row) => sum + cents(row.amount), 0);
  const ledgerExpenses = eurRows.filter((row) => row.amount < 0).reduce((sum, row) => sum + Math.abs(cents(row.amount)), 0);
  const unmatchedCashEntries = cash.filter((entry) => inRange(entry.date, context.from, context.to) && (!entry.accountNumber || !hasStatement(context.mappings.get(entry.accountNumber), 'eur'))).map((entry) => entry.id ?? entry.date);
  const cashResult = cashIncome - cashExpenses;
  const ledgerResult = ledgerIncome - ledgerExpenses;
  return envelope(context, 'eur-ledger-reconciliation', {
    cashIncome: amount(cashIncome),
    cashExpenses: amount(cashExpenses),
    cashResult: amount(cashResult),
    ledgerIncome: amount(ledgerIncome),
    ledgerExpenses: amount(ledgerExpenses),
    ledgerResult: amount(ledgerResult),
    differences: { income: amount(cashIncome - ledgerIncome), expenses: amount(cashExpenses - ledgerExpenses), result: amount(cashResult - ledgerResult) },
    unmatchedCashEntries,
  });
}

export function calculateReport(request: ReportRequest & { kind: ReportKind }): ReportResult<object> {
  switch (request.kind.replaceAll('_', '-')) {
    case 'susa': return calculateSusa(request);
    case 'bwa01': return calculateBwa01(request);
    case 'management-guv': return calculateManagementGuv(request);
    case 'hgb-guv': return calculateHgbGuv(request);
    case 'hgb-bilanz': return calculateHgbBilanz(request);
    case 'eur-ledger-reconciliation': return reconcileEurToLedger(request);
    default: throw new RangeError(`Unsupported report kind: ${request.kind}`);
  }
}

export const calculateSusaReport = calculateSusa;
export const calculateBwa01Report = calculateBwa01;
export const calculateManagementGuvReport = calculateManagementGuv;
export const calculateHgbGuvReport = calculateHgbGuv;
export const calculateHgbBilanzReport = calculateHgbBilanz;
export const reconcileEurLedger = reconcileEurToLedger;
