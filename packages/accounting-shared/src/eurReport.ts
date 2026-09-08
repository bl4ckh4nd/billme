export type EurCalculationLineKind = 'income' | 'expense' | 'computed';

export type EurCashItemKind =
  | 'income'
  | 'expense'
  | 'private-withdrawal'
  | 'private-contribution'
  | 'private_withdrawal'
  | 'private_contribution'
  | 'private'
  | 'pass-through'
  | 'pass_through'
  | 'passThrough';

export type EurDeductibility = 'deductible' | 'non-deductible';

export interface EurCalculationTerm {
  id: string;
  sign: 1 | -1;
}

export interface EurCalculationLine {
  id: string;
  kennziffer?: string;
  providerPath?: string;
  label: string;
  kind: EurCalculationLineKind;
  exportable: boolean;
  sortOrder: number;
  computedFromIds?: string[];
  computedTerms?: EurCalculationTerm[];
}

export interface EurExpenseSplit {
  amountNet: number;
  deductibility?: EurDeductibility;
  classification?: EurDeductibility;
  /** Compatibility input for callers that model this as a boolean. */
  deductible?: boolean;
  lineId?: string;
  reason?: string;
  auditId?: string;
}

export interface EurCalculationItem {
  sourceType: string;
  sourceId: string;
  amountNet: number;
  flowType?: 'income' | 'expense';
  /** Typed cash facts which must not be silently folded into operating rows. */
  kind?: EurCashItemKind;
  privateDirection?: 'withdrawal' | 'contribution';
  /** Cash date; `date` is accepted as a compatibility alias. */
  cashDate?: string;
  date?: string;
  lineId?: string;
  splits?: readonly EurExpenseSplit[];
  excluded?: boolean;
  warning?: string;
}

export interface EurSplitClassification {
  sourceType: string;
  sourceId: string;
  amountNet: number;
  splits: EurExpenseSplit[];
}

export interface EurCalculationRow extends EurCalculationLine {
  total: number;
}

export interface EurCalculationResult {
  rows: EurCalculationRow[];
  summary: {
    incomeTotal: number;
    expenseTotal: number;
    surplus: number;
  };
  unclassifiedCount: number;
  warnings: string[];
  privateWithdrawals?: number;
  privateContributions?: number;
  passThroughTotal?: number;
  deductibility?: {
    deductibleExpenseTotal: number;
    nonDeductibleExpenseTotal: number;
  };
  splitClassifications?: EurSplitClassification[];
}

export interface EurCalculationOptions {
  taxYear?: number;
  from?: string;
  to?: string;
  /** Filing calculations require every cash item to carry a valid date. */
  requireCashDate?: boolean;
}

export interface EurAnnexValueLine {
  id: string;
  kind: 'input' | 'computed' | 'choice';
  operation?: 'sum' | 'min' | 'max';
  computedFromIds?: readonly string[];
  computedTerms?: readonly EurCalculationTerm[];
}

export interface EurAnnexValueFact {
  lineId: string;
  amount: number;
  sourceId?: string;
  date?: string;
}

export interface EurAnnexValueOptions {
  taxYear?: number;
  asOfDate?: string;
  requiredLineIds?: readonly string[];
  /** Alias for requiredLineIds when the caller has a complete filing packet. */
  requireComplete?: boolean;
  totalLineId?: string;
}

export interface EurAnnexValueResult {
  values: Record<string, number>;
  total: number;
  facts: EurAnnexValueFact[];
}

/** Tax years for which a bundled EÜR catalog is available. */
export const SUPPORTED_EUR_TAX_YEARS = [2025, 2026] as const;
export type SupportedEurTaxYear = (typeof SUPPORTED_EUR_TAX_YEARS)[number];
export const LATEST_SUPPORTED_EUR_TAX_YEAR = 2026 as const;

export const isSupportedEurTaxYear = (year: number): year is SupportedEurTaxYear =>
  Number.isInteger(year) && (SUPPORTED_EUR_TAX_YEARS as readonly number[]).includes(year);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const toCents = (value: number): number => Math.round((value + Number.EPSILON) * 100);
const fromCents = (value: number): number => value / 100;
const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const assertDate = (value: string, field: string): void => {
  if (!DATE_PATTERN.test(value)) throw new RangeError(`${field} must use YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${field} must be a valid calendar date`);
  }
};

const assertYear = (year: number): void => {
  if (!isSupportedEurTaxYear(year)) {
    throw new RangeError(`EUR_CATALOG_UNAVAILABLE:${year}`);
  }
};

const dateInRange = (value: string, from?: string, to?: string): boolean => (!from || value >= from) && (!to || value <= to);
const itemKind = (item: EurCalculationItem): EurCashItemKind | undefined => {
  if (!item.kind && item.privateDirection) return item.privateDirection === 'contribution' ? 'private-contribution' : 'private-withdrawal';
  if (item.kind === 'private' && item.privateDirection === 'contribution') return 'private-contribution';
  if (item.kind === 'private_withdrawal') return 'private-withdrawal';
  if (item.kind === 'private_contribution') return 'private-contribution';
  if (item.kind === 'private') return 'private-withdrawal';
  if (item.kind === 'pass_through' || item.kind === 'passThrough') return 'pass-through';
  return item.kind ?? item.flowType;
};

const splitDeductibility = (split: EurExpenseSplit): EurDeductibility => {
  if (split.deductibility) return split.deductibility;
  if (split.classification) return split.classification;
  if (split.deductible !== undefined) return split.deductible ? 'deductible' : 'non-deductible';
  return 'deductible';
};

/** Pure EÜR row calculator shared by desktop and server cash-basis adapters. */
export const calculateEurRows = (
  lines: readonly EurCalculationLine[],
  items: readonly EurCalculationItem[],
  options: EurCalculationOptions = {},
): EurCalculationResult => {
  if (options.taxYear !== undefined) assertYear(options.taxYear);
  const from = options.from ?? (options.taxYear === undefined ? undefined : `${options.taxYear}-01-01`);
  const to = options.to ?? (options.taxYear === undefined ? undefined : `${options.taxYear}-12-31`);
  if (from) assertDate(from, 'from');
  if (to) assertDate(to, 'to');
  if (from && to && from > to) throw new RangeError('EÜR date range is inverted');
  if (options.taxYear !== undefined && ((from && !from.startsWith(`${options.taxYear}-`)) || (to && !to.startsWith(`${options.taxYear}-`)))) {
    throw new RangeError(`EÜR range does not belong to ${options.taxYear}`);
  }
  const linesById = new Map(lines.map((line) => [line.id, line]));
  const totals = new Map(lines.map((line) => [line.id, 0]));
  const warnings: string[] = [];
  const splitClassifications: EurSplitClassification[] = [];
  let unclassifiedCount = 0;
  let privateWithdrawals = 0;
  let privateContributions = 0;
  let passThroughTotal = 0;
  let deductibleExpenseTotal = 0;
  let nonDeductibleExpenseTotal = 0;

  for (const item of items) {
    if (item.warning) warnings.push(item.warning);
    if (item.excluded) continue;
    const source = `${item.sourceType}:${item.sourceId}`;
    const cashDate = item.cashDate ?? item.date;
    if (item.cashDate && item.date && item.cashDate !== item.date) throw new RangeError(`Conflicting cash dates for ${source}`);
    if (!Number.isFinite(item.amountNet)) throw new RangeError(`Invalid EÜR amount for ${source}`);
    if (cashDate) {
      assertDate(cashDate, `cash date for ${source}`);
      if (!dateInRange(cashDate, from, to)) continue;
    } else if (options.requireCashDate) {
      throw new RangeError(`Missing cash date for ${source}`);
    }
    const kind = itemKind(item);
    const flowType = item.flowType ?? (kind === 'income' || kind === 'expense' ? kind : undefined);
    if (kind === 'private-withdrawal' || kind === 'private-contribution' || kind === 'pass-through') {
      const amount = toCents(item.amountNet);
      if (!Number.isFinite(item.amountNet) || amount < 0) throw new RangeError(`Invalid neutral EÜR amount for ${source}`);
      if (kind === 'private-withdrawal') privateWithdrawals += amount;
      if (kind === 'private-contribution') privateContributions += amount;
      if (kind === 'pass-through') passThroughTotal += amount;
      continue;
    }
    if (item.splits?.length) {
      if (flowType !== 'expense') throw new Error(`EÜR splits are only valid for expenses: ${source}`);
      const itemCents = toCents(item.amountNet);
      const splitCents = item.splits.map((split) => {
        if (!Number.isFinite(split.amountNet) || toCents(split.amountNet) < 0) throw new RangeError(`Invalid EÜR split amount for ${source}`);
        if (!split.reason?.trim()) throw new Error(`EÜR split requires an audit reason: ${source}`);
        const deductibility = splitDeductibility(split);
        if (deductibility !== 'deductible' && deductibility !== 'non-deductible') throw new Error(`Invalid EÜR split deductibility: ${source}`);
        if (deductibility === 'deductible' && !split.lineId) throw new Error(`EÜR deductible split requires a line: ${source}`);
        return { ...split, deductibility, amountNet: round2(split.amountNet) };
      });
      if (splitCents.reduce((sum, split) => sum + toCents(split.amountNet), 0) !== itemCents) {
        throw new Error(`EÜR split allocation does not reconcile in cents: ${source}`);
      }
      splitClassifications.push({ sourceType: item.sourceType, sourceId: item.sourceId, amountNet: round2(item.amountNet), splits: splitCents });
      for (const split of splitCents) {
        const amount = toCents(split.amountNet);
        if (split.deductibility === 'non-deductible') {
          nonDeductibleExpenseTotal += amount;
          continue;
        }
        const splitLine = split.lineId ? linesById.get(split.lineId) : undefined;
        if (!splitLine) {
          warnings.push(`Unknown EÜR split line for ${source}: ${split.lineId}`);
          unclassifiedCount += 1;
          continue;
        }
        if (splitLine.kind !== 'expense') {
          warnings.push(`EÜR split line is not an expense for ${source}: ${split.lineId}`);
          unclassifiedCount += 1;
          continue;
        }
        deductibleExpenseTotal += amount;
        totals.set(splitLine.id, (totals.get(splitLine.id) ?? 0) + fromCents(amount));
      }
      continue;
    }
    const itemLineId = item.lineId;
    if (!itemLineId) {
      unclassifiedCount += 1;
      continue;
    }
    const line = linesById.get(itemLineId);
    if (!line) {
      warnings.push(`Unknown EÜR line for ${source}: ${itemLineId}`);
      unclassifiedCount += 1;
      continue;
    }
    if (line.kind === 'computed') {
      warnings.push(`Computed line cannot be used for classification: ${line.id}`);
      unclassifiedCount += 1;
      continue;
    }
    if (line.kind !== flowType) {
      warnings.push(`Flow mismatch for ${source}: line ${line.id} is ${line.kind}`);
      unclassifiedCount += 1;
      continue;
    }
    if (flowType === 'expense') deductibleExpenseTotal += toCents(item.amountNet);
    totals.set(line.id, round2((totals.get(line.id) ?? 0) + item.amountNet));
  }

  const resolved = new Map<string, number>();
  const resolve = (id: string): number => {
    if (resolved.has(id)) return resolved.get(id)!;
    const line = linesById.get(id);
    if (!line) return 0;
    if (line.kind !== 'computed') {
      const total = totals.get(id) ?? 0;
      resolved.set(id, total);
      return total;
    }
    const terms = line.computedTerms?.length
      ? line.computedTerms
      : (line.computedFromIds ?? []).map((childId) => ({ id: childId, sign: 1 as const }));
    const total = round2(terms.reduce((sum, term) => sum + term.sign * resolve(term.id), 0));
    resolved.set(id, total);
    totals.set(id, total);
    return total;
  };

  for (const line of lines) resolve(line.id);
  const rows = lines.map((line) => ({ ...line, total: round2(totals.get(line.id) ?? 0) }));
  const incomeTotal = round2(rows.filter((row) => row.kind === 'income').reduce((sum, row) => sum + row.total, 0));
  const expenseTotal = round2(rows.filter((row) => row.kind === 'expense').reduce((sum, row) => sum + row.total, 0));
  return {
    rows,
    summary: { incomeTotal, expenseTotal, surplus: round2(incomeTotal - expenseTotal) },
    unclassifiedCount,
    warnings,
    privateWithdrawals: fromCents(privateWithdrawals),
    privateContributions: fromCents(privateContributions),
    passThroughTotal: fromCents(passThroughTotal),
    deductibility: {
      deductibleExpenseTotal: fromCents(deductibleExpenseTotal),
      nonDeductibleExpenseTotal: fromCents(nonDeductibleExpenseTotal),
    },
    splitClassifications,
  };
};

/** Calculates AVEÜR/SZ facts through the same signed-term resolver as EÜR rows. */
export const calculateEurAnnexValues = (
  lines: readonly EurAnnexValueLine[],
  facts: readonly EurAnnexValueFact[],
  options: EurAnnexValueOptions = {},
): EurAnnexValueResult => {
  if (options.taxYear !== undefined) assertYear(options.taxYear);
  if (options.asOfDate) assertDate(options.asOfDate, 'asOfDate');
  const byId = new Map(lines.map((line) => [line.id, line]));
  if (byId.size !== lines.length) throw new Error('Duplicate EÜR annex line id');
  const values = new Map<string, number>(lines.map((line) => [line.id, 0]));
  const present = new Set<string>();
  const normalizedFacts: EurAnnexValueFact[] = [];
  for (const fact of facts) {
    const line = byId.get(fact.lineId);
    if (!line) throw new Error(`Unknown EÜR annex line: ${fact.lineId}`);
    if (line.kind === 'computed' && (line.computedTerms?.length || line.computedFromIds?.length)) throw new Error(`Computed EÜR annex line cannot receive a fact: ${fact.lineId}`);
    if (!Number.isFinite(fact.amount)) throw new RangeError(`Invalid EÜR annex amount: ${fact.lineId}`);
    if (fact.date) {
      assertDate(fact.date, `EÜR annex date for ${fact.lineId}`);
      if (options.asOfDate && fact.date > options.asOfDate) throw new RangeError(`EÜR annex fact is after ${options.asOfDate}: ${fact.lineId}`);
      if (options.taxYear && !fact.date.startsWith(`${options.taxYear}-`)) throw new RangeError(`EÜR annex fact year mismatch: ${fact.lineId}`);
    }
    const amount = round2(fact.amount);
    values.set(fact.lineId, round2((values.get(fact.lineId) ?? 0) + amount));
    present.add(fact.lineId);
    normalizedFacts.push({ ...fact, amount });
  }
  const required = options.requiredLineIds ?? (options.requireComplete ? lines.filter((line) => line.kind !== 'computed').map((line) => line.id) : []);
  for (const lineId of required) {
    if (!byId.has(lineId)) throw new Error(`Unknown required EÜR annex line: ${lineId}`);
    if (!present.has(lineId)) throw new Error(`Incomplete EÜR annex facts: ${lineId}`);
  }
  const resolved = new Map<string, number>();
  const resolve = (id: string): number => {
    if (resolved.has(id)) return resolved.get(id)!;
    const line = byId.get(id);
    if (!line) throw new Error(`Unknown EÜR annex line: ${id}`);
    if (line.kind !== 'computed') {
      const value = values.get(id) ?? 0;
      resolved.set(id, value);
      return value;
    }
    const terms = line.computedTerms?.length
      ? line.computedTerms
      : (line.computedFromIds ?? []).map((childId) => ({ id: childId, sign: 1 as const }));
    if (!terms.length) {
      if (!present.has(line.id)) throw new Error(`Incomplete EÜR annex facts: computed line ${line.id}`);
      const supplied = values.get(line.id) ?? 0;
      resolved.set(id, supplied);
      return supplied;
    }
    const termValues = terms.map((term) => term.sign * resolve(term.id));
    const total = line.operation === 'min'
      ? round2(Math.min(...termValues))
      : line.operation === 'max'
        ? round2(Math.max(...termValues))
        : round2(termValues.reduce((sum, value) => sum + value, 0));
    resolved.set(id, total);
    return total;
  };
  for (const line of lines) resolve(line.id);
  const resultValues = Object.fromEntries(lines.map((line) => [line.id, round2(resolved.get(line.id) ?? 0)]));
  const totalLineId = options.totalLineId ?? [...lines].reverse().find((line) => line.kind === 'computed')?.id;
  return { values: resultValues, total: totalLineId ? resultValues[totalLineId] ?? 0 : 0, facts: normalizedFacts };
};

export const calculateEurReport = (lines: readonly EurCalculationLine[], items: readonly EurCalculationItem[], options: EurCalculationOptions = {}): EurCalculationResult =>
  calculateEurRows(lines, items, { ...options, requireCashDate: options.requireCashDate ?? true });
export const calculateEurCashReport = calculateEurReport;
export const calculateEurAnnexFacts = calculateEurAnnexValues;
