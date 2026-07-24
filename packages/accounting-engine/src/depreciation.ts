export type DepreciationMethod = 'linear' | 'gwg' | 'pool';

export interface DepreciationSchedulePeriod {
  year: number;
  amount: number;
  months: number;
}

export interface DepreciationInput {
  acquisitionCost: number;
  activationDate: string;
  assetClass: string;
  usefulLifeYears?: number;
  method?: DepreciationMethod;
}

export interface AssetDisposalResult {
  depreciationToDate: number;
  residualBookValue: number;
  proceeds: number;
  gainLoss: number;
}

/**
 * Small default subset of the German BMF AfA tables. It is intentionally not
 * exhaustive; callers may override usefulLifeYears per asset.
 * Source: BMF AfA table AV, current general-purpose asset table.
 */
export const DEFAULT_AFA_USEFUL_LIVES: Readonly<Record<string, number>> = {
  'IT-Hardware': 3,
  'Büromöbel': 13,
  'Betriebsausstattung': 13,
  'Bürogeräte': 8,
  'Fuhrpark': 6,
  'Personenkraftwagen': 6,
  'Maschinen': 10,
};

export const DEPRECIATION_EXPENSE_ACCOUNTS = {
  SKR03: '4830',
  SKR04: '6220',
} as const;

const toCents = (value: number): number => Math.round((value + Number.EPSILON) * 100);
const fromCents = (value: number): number => value / 100;

const parseDate = (value: string): Date => {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!value || Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
};

const resolveUsefulLife = (input: DepreciationInput): number => {
  const years = input.usefulLifeYears ?? DEFAULT_AFA_USEFUL_LIVES[input.assetClass];
  if (!years || !Number.isInteger(years) || years <= 0) {
    throw new Error(`No useful life configured for asset class: ${input.assetClass}`);
  }
  return years;
};

export const resolveDepreciationMethod = (input: DepreciationInput): DepreciationMethod => {
  if (input.method === 'pool') {
    if (input.acquisitionCost < 250.01 || input.acquisitionCost > 1000) {
      throw new Error('Pool depreciation requires net acquisition cost between 250.01 and 1000.00 EUR');
    }
    return 'pool';
  }
  if (input.method === 'gwg' && input.acquisitionCost > 800) {
    throw new Error('GWG depreciation requires net acquisition cost of at most 800.00 EUR');
  }
  if (input.acquisitionCost <= 800) return 'gwg';
  return input.method ?? 'linear';
};

export const buildDepreciationSchedule = (input: DepreciationInput): DepreciationSchedulePeriod[] => {
  const baseCents = toCents(input.acquisitionCost);
  if (baseCents < 0) throw new Error('Acquisition cost must not be negative');
  if (baseCents === 0) return [];

  const activation = parseDate(input.activationDate);
  const method = resolveDepreciationMethod(input);
  if (method === 'gwg') {
    return [{ year: activation.getUTCFullYear(), amount: fromCents(baseCents), months: 12 }];
  }
  if (method === 'pool') {
    const periods: DepreciationSchedulePeriod[] = [];
    let allocated = 0;
    for (let index = 0; index < 5; index += 1) {
      const amount = index === 4 ? baseCents - allocated : Math.round(baseCents / 5);
      allocated += amount;
      periods.push({
        year: activation.getUTCFullYear() + index,
        amount: fromCents(amount),
        months: 12,
      });
    }
    return periods;
  }

  const totalMonths = resolveUsefulLife(input) * 12;
  const monthsByYear = new Map<number, number>();
  for (let month = 0; month < totalMonths; month += 1) {
    const cursor = new Date(Date.UTC(
      activation.getUTCFullYear(),
      activation.getUTCMonth() + month,
      1,
    ));
    const year = cursor.getUTCFullYear();
    monthsByYear.set(year, (monthsByYear.get(year) ?? 0) + 1);
  }

  const periods: DepreciationSchedulePeriod[] = [];
  let allocated = 0;
  const yearMonths = [...monthsByYear.entries()];
  yearMonths.forEach(([year, months], index) => {
    const amount = index === yearMonths.length - 1
      ? baseCents - allocated
      : Math.round(baseCents * months / totalMonths);
    allocated += amount;
    periods.push({ year, amount: fromCents(amount), months });
  });
  return periods;
};

export const computeAssetDisposal = (
  input: DepreciationInput & { disposalDate: string; proceeds: number },
): AssetDisposalResult => {
  const activation = parseDate(input.activationDate);
  const disposal = parseDate(input.disposalDate);
  if (disposal < activation) throw new Error('Disposal date must not precede activation date');

  const baseCents = toCents(input.acquisitionCost);
  const method = resolveDepreciationMethod(input);
  let depreciationCents: number;
  if (method === 'gwg') {
    depreciationCents = baseCents;
  } else if (method === 'pool') {
    depreciationCents = toCents(
      buildDepreciationSchedule(input)
        .filter((period) => period.year <= disposal.getUTCFullYear())
        .reduce((sum, period) => sum + period.amount, 0),
    );
  } else {
    const totalMonths = resolveUsefulLife(input) * 12;
    const elapsedMonths = Math.min(
      totalMonths,
      (disposal.getUTCFullYear() - activation.getUTCFullYear()) * 12
        + disposal.getUTCMonth() - activation.getUTCMonth() + 1,
    );
    depreciationCents = Math.round(baseCents * elapsedMonths / totalMonths);
  }

  const residualCents = Math.max(0, baseCents - depreciationCents);
  const proceedsCents = toCents(input.proceeds);
  return {
    depreciationToDate: fromCents(depreciationCents),
    residualBookValue: fromCents(residualCents),
    proceeds: fromCents(proceedsCents),
    gainLoss: fromCents(proceedsCents - residualCents),
  };
};
