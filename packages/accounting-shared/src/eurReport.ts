export type EurCalculationLineKind = 'income' | 'expense' | 'computed';

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

export interface EurCalculationItem {
  sourceType: string;
  sourceId: string;
  amountNet: number;
  flowType: 'income' | 'expense';
  lineId?: string;
  excluded?: boolean;
  warning?: string;
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
}

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

/** Pure EÜR row calculator shared by desktop and server cash-basis adapters. */
export const calculateEurRows = (
  lines: readonly EurCalculationLine[],
  items: readonly EurCalculationItem[],
): EurCalculationResult => {
  const linesById = new Map(lines.map((line) => [line.id, line]));
  const totals = new Map(lines.map((line) => [line.id, 0]));
  const warnings: string[] = [];
  let unclassifiedCount = 0;

  for (const item of items) {
    if (item.warning) warnings.push(item.warning);
    if (item.excluded) continue;
    const source = `${item.sourceType}:${item.sourceId}`;
    if (!item.lineId) {
      unclassifiedCount += 1;
      continue;
    }
    const line = linesById.get(item.lineId);
    if (!line) {
      warnings.push(`Unknown EÜR line for ${source}: ${item.lineId}`);
      unclassifiedCount += 1;
      continue;
    }
    if (line.kind === 'computed') {
      warnings.push(`Computed line cannot be used for classification: ${line.id}`);
      unclassifiedCount += 1;
      continue;
    }
    if (line.kind !== item.flowType) {
      warnings.push(`Flow mismatch for ${source}: line ${line.id} is ${line.kind}`);
      unclassifiedCount += 1;
      continue;
    }
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
  return { rows, summary: { incomeTotal, expenseTotal, surplus: round2(incomeTotal - expenseTotal) }, unclassifiedCount, warnings };
};
