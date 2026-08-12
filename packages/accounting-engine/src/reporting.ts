import {
  assertEurUsesCalendarYear,
  fiscalYearForDate,
  fiscalYearRange,
} from '@billme/accounting-shared';
import type {
  ReportingCalculationProfile,
  Bwa01Report,
  CashInputEntry,
  HgbBilanzReport,
  HgbGuvReport,
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
import {
  getPublicReportCatalogsIncludingUnverified,
} from './catalogs/publicReportCatalogs.js';
import type { PublicReportCatalog, PublicReportPosition } from './catalogs/types.js';

type Cents = number;

type Aggregate = {
  accountNumber: string;
  opening: Cents;
  debit: Cents;
  credit: Cents;
};

type ReportStatement = 'bwa01' | 'management-guv' | 'hgb-guv' | 'hgb-bilanz' | 'eur';

type ReportingContext = {
  request: ReportRequest;
  profile: ReportingCalculationProfile;
  from?: string;
  to?: string;
  asOfDate?: string;
  rows: Aggregate[];
  mappings: Map<string, ReportingMapping[]>;
  mappingHealth: MappingHealth;
  snapshot: ReportSnapshot;
};

type PositionValue = {
  amount: Cents;
  accounts: Set<string>;
};

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

function statements(mapping: ReportingMapping): string[] {
  return typeof mapping.statement === 'string' ? [mapping.statement] : [...mapping.statement];
}

function isExplicitStatement(statement: string, requested: ReportStatement): boolean {
  if (statement === requested) return true;
  if (requested === 'hgb-guv' && statement === 'hgb-gkv') return true;
  return requested === 'hgb-bilanz' && statement === 'hgb-balance';
}

const incomeStatementKinds: ReadonlySet<string> = new Set(['bwa01', 'management-guv', 'hgb-guv', 'hgb-gkv', 'bwa', 'guv', 'eur']);
const balanceStatementKinds: ReadonlySet<string> = new Set(['hgb-bilanz', 'hgb-balance', 'bilanz']);

function makeContext(request: ReportRequest): ReportingContext {
  fiscalYearRange(2000, request.profile.fiscalYearStart);
  const { from, to, asOfDate } = periodOf(request);
  const entries = request.ledger.entries ?? [];
  const cashEntries = request.cash?.entries ?? [];
  const aggregates = new Map<string, Aggregate>();
  const sourceEntries = entries.length > 0 ? entries : undefined;

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
    // A balance snapshot can add accounts absent from the selected journal slice,
    // but must not double-count an account already aggregated from entries.
    for (const balance of request.ledger.balances ?? []) {
      if (aggregates.has(balance.accountNumber)) continue;
      const row = add(aggregates, balance.accountNumber);
      row.opening = cents(balance.openingBalance);
      row.debit = cents(balance.debitTurnover);
      row.credit = cents(balance.creditTurnover);
    }
  }

  const mappings = new Map<string, ReportingMapping[]>();
  for (const mapping of request.mappings ?? []) {
    const entries = mappings.get(mapping.accountNumber) ?? [];
    entries.push(mapping);
    mappings.set(mapping.accountNumber, entries);
  }
  const ledgerAccountNumbers = [...aggregates.keys()];
  const accounts = [...new Set([
    ...aggregates.keys(),
    ...cashEntries.flatMap((entry) => entry.accountNumber ? [entry.accountNumber] : []),
  ])].sort();
  const unmappedAccounts = accounts.filter((accountNumber) => !mappings.has(accountNumber));
  const warnings = unmappedAccounts.length
    ? [`${unmappedAccounts.length} account(s) have no report mapping`]
    : [];
  const health: MappingHealth = {
    mappedAccounts: accounts.length - unmappedAccounts.length,
    inferredAccounts: 0,
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
  return {
    request,
    profile: request.profile,
    from,
    to,
    asOfDate: effectiveAsOfDate,
    rows: [...aggregates.values()].sort((a, b) => a.accountNumber.localeCompare(b.accountNumber)),
    mappings,
    mappingHealth: health,
    snapshot,
  };
}

function signedTurnover(row: Aggregate): Cents {
  return row.credit - row.debit;
}

function balance(row: Aggregate): Cents {
  return row.opening + row.debit - row.credit;
}

function positionValues(
  context: ReportingContext,
  statement: ReportStatement,
  allowed: ReadonlySet<string>,
): { values: Map<string, PositionValue>; hardBlock: boolean; mappingHealth: MappingHealth } {
  const values = new Map<string, PositionValue>();
  const invalidAccounts = new Set<string>();
  const warnings = [...context.mappingHealth.warnings];

  for (const row of context.rows) {
    const mappings = context.mappings.get(row.accountNumber) ?? [];
    const mapping = mappings.find((candidate) => statements(candidate).some((value) => isExplicitStatement(value, statement)));
    if (!mapping) {
      const isIncome = incomeStatementKinds.has(statement);
      const relevant = mappings.some((candidate) => statements(candidate).some((value) =>
        (isIncome ? incomeStatementKinds : balanceStatementKinds).has(value)));
      const unrelatedOnly = mappings.length > 0 && mappings.every((candidate) => statements(candidate).every((value) =>
        (isIncome ? balanceStatementKinds : incomeStatementKinds).has(value)));
      if (relevant || !unrelatedOnly) {
        invalidAccounts.add(row.accountNumber);
        warnings.push(`${row.accountNumber} has no ${statement} report mapping`);
      }
      continue;
    }
    const mappedPosition = mapping.position;
    if (!mappedPosition || !allowed.has(mappedPosition)) {
      invalidAccounts.add(row.accountNumber);
      warnings.push(`${row.accountNumber} uses unknown ${statement} position ${mapping.position}`);
      continue;
    }
    const current = values.get(mappedPosition) ?? { amount: 0, accounts: new Set<string>() };
    current.amount += signedTurnover(row);
    current.accounts.add(row.accountNumber);
    values.set(mappedPosition, current);
  }

  const unmappedAccounts = [...new Set([...context.mappingHealth.unmappedAccounts, ...invalidAccounts])].sort();
  const mappingHealth: MappingHealth = {
    mappedAccounts: Math.max(0, context.mappingHealth.mappedAccounts - invalidAccounts.size),
    inferredAccounts: 0,
    unmappedAccounts,
    warnings: [...new Set(warnings)],
    blocking: context.mappingHealth.blocking || invalidAccounts.size > 0,
  };
  return { values, hardBlock: invalidAccounts.size > 0, mappingHealth };
}

function balanceValues(
  context: ReportingContext,
  catalog: PublicReportCatalog,
): { values: Map<string, PositionValue>; hardBlock: boolean; mappingHealth: MappingHealth } {
  const values = new Map<string, PositionValue>();
  const invalidAccounts = new Set<string>();
  const warnings = [...context.mappingHealth.warnings];
  for (const row of context.rows) {
    const mappings = context.mappings.get(row.accountNumber) ?? [];
    const mapping = mappings.find((candidate) => statements(candidate).some((value) => isExplicitStatement(value, 'hgb-bilanz')));
    if (!mapping) {
      const relevant = mappings.some((candidate) => statements(candidate).some((value) => balanceStatementKinds.has(value)));
      const unrelatedOnly = mappings.length > 0 && mappings.every((candidate) => statements(candidate).every((value) => incomeStatementKinds.has(value)));
      if (relevant || !unrelatedOnly) {
        invalidAccounts.add(row.accountNumber);
        warnings.push(`${row.accountNumber} has no hgb-bilanz report mapping`);
      }
      continue;
    }
    const position = mapping.position;
    const catalogPosition = catalog.positions.find((entry) => entry.key === position);
    // §266 micro only publishes the letter-level equity heading.  A licensed
    // explicit equity.result mapping is still accepted as closing evidence,
    // but is folded into that heading rather than emitted as a private row.
    const microClosedResult = context.profile.size === 'micro' && position === 'equity.result';
    if (!catalogPosition && !microClosedResult) {
      invalidAccounts.add(row.accountNumber);
      warnings.push(`${row.accountNumber} uses unknown hgb-bilanz position ${mapping.position}`);
      continue;
    }
    const expectedSide = position?.startsWith('assets.') ? 'asset' : 'liability';
    if (mapping.side && mapping.side !== expectedSide) {
      invalidAccounts.add(row.accountNumber);
      warnings.push(`${row.accountNumber} has an inconsistent balance side for ${position}`);
      continue;
    }
    const valueKey = microClosedResult ? 'equity.result' : catalogPosition!.key;
    const current = values.get(valueKey) ?? { amount: 0, accounts: new Set<string>() };
    current.amount += expectedSide === 'asset' ? balance(row) : -balance(row);
    current.accounts.add(row.accountNumber);
    values.set(valueKey, current);
  }
  const unmappedAccounts = [...new Set([...context.mappingHealth.unmappedAccounts, ...invalidAccounts])].sort();
  return {
    values,
    hardBlock: invalidAccounts.size > 0,
    mappingHealth: {
      mappedAccounts: Math.max(0, context.mappingHealth.mappedAccounts - invalidAccounts.size),
      inferredAccounts: 0,
      unmappedAccounts,
      warnings: [...new Set(warnings)],
      blocking: context.mappingHealth.blocking || invalidAccounts.size > 0,
    },
  };
}

function line(
  position: PublicReportPosition | { key: string; label: string; kind: ReportingLine['kind']; parentKey?: string },
  value: Cents,
  accounts: Iterable<string>,
  formula?: string,
): ReportingLine {
  const accountNumbers = [...new Set(accounts)].sort();
  return {
    position: position.key,
    label: position.label,
    amount: amount(value),
    accountNumbers,
    accountRefs: accountNumbers,
    kind: position.kind,
    parentPosition: position.parentKey,
    ...(formula ? { formula } : {}),
  };
}

function valueOf(values: Map<string, PositionValue>, key: string): Cents {
  return values.get(key)?.amount ?? 0;
}

function accountsOf(values: Map<string, PositionValue>, keys: readonly string[]): string[] {
  return keys.flatMap((key) => [...(values.get(key)?.accounts ?? [])]);
}

function formulaValue(values: Map<string, PositionValue>, key: string, parts: readonly string[]): Cents {
  // A direct mapping to a statutory heading is valid for charts that do not
  // expose its children. Child mappings win once they exist.
  return parts.some((part) => values.has(part)) ? parts.reduce((sum, part) => sum + valueOf(values, part), 0) : valueOf(values, key);
}

function catalogFor(kind: PublicReportCatalog['kind'], size: ReportingCalculationProfile['size']): PublicReportCatalog {
  const catalog = getPublicReportCatalogsIncludingUnverified(2025).find((entry) => entry.kind === kind && entry.scope === size);
  if (!catalog) throw new Error(`PUBLIC_REPORT_CATALOG_UNAVAILABLE:${kind}:${size}`);
  return catalog;
}

function envelope<T extends object>(context: ReportingContext, kind: ReportKind, report: T, mappingHealth = context.mappingHealth): ReportResult<T> {
  return { ...report, kind, snapshot: context.snapshot, mappingHealth };
}

export function calculateSusa(request: ReportRequest): ReportResult<SusaReport> {
  const context = makeContext(request);
  // SuSa is the ledger's account-level truth; report-category mappings are not
  // required to calculate its balances and must not block the statement.
  const mappingHealth: MappingHealth = {
    mappedAccounts: context.rows.length,
    inferredAccounts: 0,
    unmappedAccounts: [],
    warnings: [],
    blocking: false,
  };
  const rows = context.rows.map((row) => {
    return {
      accountNumber: row.accountNumber,
      openingBalance: amount(row.opening),
      debitTurnover: amount(row.debit),
      creditTurnover: amount(row.credit),
      closingBalance: amount(balance(row)),
      mappedTo: context.mappings.get(row.accountNumber)?.[0]?.position,
      label: context.mappings.get(row.accountNumber)?.[0]?.label,
    };
  });
  return envelope(context, 'susa', {
    rows,
    totals: {
      debit: amount(rows.reduce((sum, row) => sum + cents(row.debitTurnover), 0)),
      credit: amount(rows.reduce((sum, row) => sum + cents(row.creditTurnover), 0)),
      balance: amount(rows.reduce((sum, row) => sum + cents(row.closingBalance), 0)),
    },
  }, mappingHealth);
}

const bwaCostKeys = [
  'material-expense', 'personnel-expense', 'space-expense', 'operating-tax', 'insurance',
  'special-cost', 'vehicle-expense', 'advertising-travel', 'cost-of-goods-out',
  'depreciation', 'maintenance', 'other-operating-expense',
] as const;

export function calculateBwa01(request: ReportRequest): ReportResult<Bwa01Report> {
  const context = makeContext(request);
  const catalog = catalogFor('bwa01', context.profile.size);
  const allowed = new Set(catalog.positions.map((position) => position.key));
  const prepared = positionValues(context, 'bwa01', allowed);
  const mappingHealth = catalog.provenance.sourceHashStatus === 'unavailable'
    ? {
      ...prepared.mappingHealth,
      warnings: [...prepared.mappingHealth.warnings, 'BWA01 public catalog provenance hash is unavailable'],
      blocking: true,
    }
    : prepared.mappingHealth;
  if (prepared.hardBlock) return envelope(context, 'bwa01', { rows: [], totals: { revenue: 0, expenses: 0, operatingResult: 0 } }, mappingHealth);
  const values = prepared.values;
  const allValues = new Map(values);
  const formula = (key: string, parts: readonly string[]): PositionValue => ({
    amount: formulaValue(allValues, key, parts),
    accounts: new Set(accountsOf(allValues, parts.length ? parts : [key])),
  });
  const derived = new Map<string, PositionValue>();
  const formulaDescriptions = new Map<string, string>();
  const formulas: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['total-output', ['revenue']],
    ['gross-profit', ['total-output', 'material-expense']],
    ['operating-gross-profit', ['gross-profit', 'special-operating-income']],
    ['total-costs', bwaCostKeys],
    ['operating-result', ['operating-gross-profit', 'personnel-expense', 'space-expense', 'operating-tax', 'insurance', 'special-cost', 'vehicle-expense', 'advertising-travel', 'cost-of-goods-out', 'depreciation', 'maintenance', 'other-operating-expense']],
    ['neutral-expense', ['interest-expense', 'other-neutral-expense']],
    ['neutral-income', ['interest-income', 'other-neutral-income', 'imputed-cost-offset']],
    ['result-before-tax', ['operating-result', 'neutral-expense', 'neutral-income']],
    ['preliminary-result', ['result-before-tax', 'income-tax']],
  ];
  for (const [key, parts] of formulas) {
    const current = formula(key, parts);
    derived.set(key, current);
    allValues.set(key, current);
    formulaDescriptions.set(key, parts.join(' + '));
  }
  const rows = catalog.positions.map((position) => {
    const current = derived.get(position.key) ?? values.get(position.key) ?? { amount: 0, accounts: new Set<string>() };
    const formulaText = formulaDescriptions.get(position.key);
    return line(position, current.amount, current.accounts, formulaText);
  });
  const expensePositions = [...bwaCostKeys, 'neutral-expense', 'income-tax'] as const;
  const expenses = expensePositions.reduce((sum, key) => sum + Math.abs(Math.min(0, valueOf(allValues, key))), 0);
  const operatingResult = valueOf(derived, 'operating-result');
  return envelope(context, 'bwa01', {
    rows,
    totals: { revenue: amount(valueOf(values, 'revenue')), expenses: amount(expenses), operatingResult: amount(operatingResult) },
  }, mappingHealth);
}

const managementPositions = [
  { key: 'revenue', label: 'Betriebliche Erlöse', kind: 'line' as const },
  { key: 'variable-costs', label: 'Variable Kosten', kind: 'line' as const },
  { key: 'contribution-margin', label: 'Deckungsbeitrag', kind: 'subtotal' as const },
  { key: 'personnel-costs', label: 'Personalkosten', kind: 'line' as const },
  { key: 'fixed-costs', label: 'Fixkosten', kind: 'line' as const },
  { key: 'ebitda', label: 'EBITDA', kind: 'subtotal' as const },
  { key: 'depreciation', label: 'Abschreibungen', kind: 'line' as const },
  { key: 'ebit', label: 'EBIT', kind: 'subtotal' as const },
  { key: 'financial-result', label: 'Finanzergebnis', kind: 'line' as const },
  { key: 'taxes', label: 'Steuern', kind: 'line' as const },
  { key: 'net-result', label: 'Managementergebnis', kind: 'result' as const },
] as const;

export function calculateManagementGuv(request: ReportRequest): ReportResult<ManagementGuvReport> {
  const context = makeContext(request);
  const allowed = new Set(managementPositions.map((position) => position.key));
  const prepared = positionValues(context, 'management-guv', allowed);
  if (prepared.hardBlock) return envelope(context, 'management-guv', { rows: [], netResult: 0 }, prepared.mappingHealth);
  const values = prepared.values;
  const allValues = new Map(values);
  const derived = new Map<string, PositionValue>();
  const formulaDescriptions = new Map<string, string>();
  const formulas: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['contribution-margin', ['revenue', 'variable-costs']],
    ['ebitda', ['contribution-margin', 'personnel-costs', 'fixed-costs']],
    ['ebit', ['ebitda', 'depreciation']],
    ['net-result', ['ebit', 'financial-result', 'taxes']],
  ];
  for (const [key, parts] of formulas) {
    const current = { amount: formulaValue(allValues, key, parts), accounts: new Set(accountsOf(allValues, parts)) };
    derived.set(key, current);
    allValues.set(key, current);
    formulaDescriptions.set(key, parts.join(' + '));
  }
  const rows = managementPositions.map((position) => {
    const current = derived.get(position.key) ?? values.get(position.key) ?? { amount: 0, accounts: new Set<string>() };
    return line(position, current.amount, current.accounts, formulaDescriptions.get(position.key));
  });
  return envelope(context, 'management-guv', { rows, netResult: amount(valueOf(allValues, 'net-result')) }, prepared.mappingHealth);
}

const hgbFormulaParts: ReadonlyMap<string, readonly string[]> = new Map([
  ['material', ['material.raw', 'material.services']],
  ['personnel', ['personnel.wages', 'personnel.social']],
  ['depreciation', ['depreciation.intangible-tangible', 'depreciation.current-assets']],
  ['result-after-tax', ['revenue', 'inventory-change', 'capitalized-work', 'other-operating-income', 'material', 'personnel', 'depreciation', 'other-operating-expense', 'investment-income', 'securities-income', 'interest-income', 'financial-depreciation', 'interest-expense', 'income-tax']],
  ['annual-result', ['result-after-tax', 'other-tax']],
]);

export function calculateHgbGuv(request: ReportRequest): ReportResult<HgbGuvReport> {
  const context = makeContext(request);
  const catalog = catalogFor('gkv', context.profile.size);
  const allowed = new Set(catalog.positions.map((position) => position.key));
  const prepared = positionValues(context, 'hgb-guv', allowed);
  if (prepared.hardBlock) return envelope(context, 'hgb-guv', { method: 'gkv', rows: [], netResult: 0 }, prepared.mappingHealth);
  const values = prepared.values;
  const allValues = new Map(values);
  const derived = new Map<string, PositionValue>();
  const formulaDescriptions = new Map<string, string>();
  for (const [key, parts] of hgbFormulaParts) {
    const current = allValues.get(key);
    const accounts = new Set(accountsOf(allValues, parts));
    derived.set(key, {
      amount: formulaValue(allValues, key, parts),
      accounts: accounts.size ? accounts : new Set(current?.accounts ?? []),
    });
    allValues.set(key, derived.get(key)!);
    formulaDescriptions.set(key, parts.join(' + '));
  }
  const all = allValues;
  const rows = catalog.positions.map((position) => {
    const current = all.get(position.key) ?? { amount: 0, accounts: new Set<string>() };
    return line(position, current.amount, current.accounts, formulaDescriptions.get(position.key));
  });
  return envelope(context, 'hgb-guv', { method: 'gkv', rows, netResult: amount(valueOf(all, 'annual-result')) }, prepared.mappingHealth);
}

function childKeys(catalog: PublicReportCatalog, key: string): string[] {
  return catalog.positions.filter((position) => position.parentKey === key).map((position) => position.key);
}

function balancePositionValue(catalog: PublicReportCatalog, values: Map<string, PositionValue>, key: string): PositionValue {
  const direct = values.get(key);
  const children = childKeys(catalog, key);
  if (!children.length) return direct ?? { amount: 0, accounts: new Set<string>() };
  const nested = children.map((child) => balancePositionValue(catalog, values, child));
  return {
    amount: (direct?.amount ?? 0) + nested.reduce((sum, value) => sum + value.amount, 0),
    accounts: new Set([...(direct?.accounts ?? []), ...nested.flatMap((value) => [...value.accounts])]),
  };
}

export function calculateHgbBilanz(request: ReportRequest): ReportResult<HgbBilanzReport> {
  const context = makeContext(request);
  const catalog = catalogFor('bilanz', context.profile.size);
  const prepared = balanceValues(context, catalog);
  const hasClosedResult = prepared.values.has('equity.result');
  if (hasClosedResult && context.profile.size === 'micro') {
    const result = prepared.values.get('equity.result')!;
    const equity = prepared.values.get('equity') ?? { amount: 0, accounts: new Set<string>() };
    equity.amount += result.amount;
    for (const accountNumber of result.accounts) equity.accounts.add(accountNumber);
    prepared.values.set('equity', equity);
  }
  let mappingHealth = prepared.mappingHealth;
  if (!hasClosedResult) {
    const guv = calculateHgbGuv(request);
    if (guv.mappingHealth.blocking) {
      mappingHealth = {
        mappedAccounts: Math.min(mappingHealth.mappedAccounts, guv.mappingHealth.mappedAccounts),
        inferredAccounts: 0,
        unmappedAccounts: [...new Set([...mappingHealth.unmappedAccounts, ...guv.mappingHealth.unmappedAccounts])].sort(),
        warnings: [...new Set([...mappingHealth.warnings, ...guv.mappingHealth.warnings, 'HGB-Bilanz benötigt eine vollständige aktuelle HGB-GuV-Zuordnung für den Jahresüberschuss/Jahresfehlbetrag'])],
        blocking: true,
      };
    } else {
      const resultPosition = catalog.positions.find((position) => position.key === 'equity.result');
      if (resultPosition) {
        const accountNumbers = guv.rows.flatMap((row) => row.accountNumbers);
        prepared.values.set('equity.result', { amount: cents(guv.netResult), accounts: new Set(accountNumbers) });
      } else if (context.profile.size === 'micro') {
        const equity = prepared.values.get('equity') ?? { amount: 0, accounts: new Set<string>() };
        equity.amount += cents(guv.netResult);
        for (const accountNumber of guv.rows.flatMap((row) => row.accountNumbers)) equity.accounts.add(accountNumber);
        prepared.values.set('equity', equity);
      }
    }
  }
  if (prepared.hardBlock || mappingHealth.blocking) return envelope(context, 'hgb-bilanz', { assets: [], liabilities: [], totals: { assets: 0, liabilities: 0, delta: 0 } }, mappingHealth);
  const makeRows = (side: 'asset' | 'liability'): ReportingLine[] => catalog.positions
    .filter((position) => side === 'asset' ? position.key.startsWith('assets.') : !position.key.startsWith('assets.'))
    .sort((left, right) => left.order - right.order)
    .map((position) => {
      const current = balancePositionValue(catalog, prepared.values, position.key);
      return line(position, current.amount, current.accounts, position.kind === 'heading' && childKeys(catalog, position.key).length ? childKeys(catalog, position.key).join(' + ') : undefined);
    });
  const assets = makeRows('asset');
  const liabilities = makeRows('liability');
  const topLevel = (side: 'asset' | 'liability') => catalog.positions.filter((position) => {
    const isAsset = position.key.startsWith('assets.');
    return !position.parentKey && (side === 'asset' ? isAsset : !isAsset);
  });
  const total = (side: 'asset' | 'liability'): Cents => topLevel(side).reduce((sum, position) => sum + balancePositionValue(catalog, prepared.values, position.key).amount, 0);
  const totalAssets = total('asset');
  const totalLiabilities = total('liability');
  return envelope(context, 'hgb-bilanz', {
    assets,
    liabilities,
    totals: { assets: amount(totalAssets), liabilities: amount(totalLiabilities), delta: amount(totalAssets - totalLiabilities) },
  }, mappingHealth);
}

const eurPositions = new Set(['income', 'expense', 'tax', 'transfer', 'private', 'other']);

function cashAmount(entries: CashInputEntry[], kinds: CashInputEntry['kind'][], from?: string, to?: string): Cents {
  return entries.filter((entry) => kinds.includes(entry.kind) && inRange(entry.date, from, to)).reduce((sum, entry) => sum + Math.abs(cents(entry.amount)), 0);
}

export function reconcileEurToLedger(request: ReportRequest): ReportResult<EurLedgerReconciliationReport> {
  assertEurUsesCalendarYear(request.profile);
  const context = makeContext(request);
  const prepared = positionValues(context, 'eur', eurPositions);
  const cash = request.cash?.entries ?? [];
  const cashIncome = cashAmount(cash, ['income'], context.from, context.to);
  const cashExpenses = cashAmount(cash, ['expense', 'tax'], context.from, context.to);
  const ledgerIncome = [...prepared.values.entries()].filter(([key]) => key === 'income').reduce((sum, [, value]) => sum + Math.max(0, value.amount), 0);
  const ledgerExpenses = [...prepared.values.entries()].filter(([key]) => key === 'expense' || key === 'tax').reduce((sum, [, value]) => sum + Math.abs(Math.min(0, value.amount)), 0);
  const unmatchedCashEntries = cash
    .filter((entry) => inRange(entry.date, context.from, context.to) && (!entry.accountNumber || !context.mappings.has(entry.accountNumber)))
    .map((entry) => entry.id ?? entry.date);
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
  }, prepared.mappingHealth);
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
