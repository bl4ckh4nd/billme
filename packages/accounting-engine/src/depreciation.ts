import { fiscalYearForDate } from '@billme/accounting-shared';

export type DepreciationMethod = 'linear' | 'degressive' | 'gwg' | 'pool';

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
  /** MM-DD of the Wirtschaftsjahr; schedule years are fiscal years (the year the Wirtschaftsjahr starts). Default 01-01. */
  fiscalYearStart?: string;
}

export interface AssetDisposalResult {
  depreciationToDate: number;
  residualBookValue: number;
  proceeds: number;
  gainLoss: number;
}

export interface IabLifecycleInput {
  formedYear: number;
  formedAmount: number;
  usedAmount?: number;
  repaidAmount?: number;
  asOfYear?: number;
}

export interface IabLifecycleResult {
  formedAmount: number;
  usedAmount: number;
  repaidAmount: number;
  remainingAmount: number;
  status: 'open' | 'partially-used' | 'used' | 'repaid' | 'expired';
}

export interface SpecialDepreciationLifecycleInput {
  acquisitionCost: number;
  recognizedAmount?: number;
  maxRate?: number;
  asOfYear?: number;
}

export interface SpecialDepreciationLifecycleResult {
  eligibleAmount: number;
  recognizedAmount: number;
  remainingAmount: number;
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

/**
 * Computer hardware and software may be written off over one year (BMF 26.02.2021 and 22.02.2022,
 * "Nutzungsdauer von Computerhardware und Software zur Dateneingabe und -verarbeitung"): with a useful
 * life of 1 year these classes are depreciated in full in the year of acquisition. A longer life stays allowed.
 */
export const DIGITAL_ASSET_CLASSES: ReadonlySet<string> = new Set(['IT-Hardware', 'Computerhardware', 'Software', 'EDV-Software']);

/**
 * Degressive AfA (§ 7 Abs. 2 EStG) is only open for additions in these windows: 2.5 × linear, at most 25 %
 * (01.04.2020–31.12.2022, Zweites Corona-Steuerhilfegesetz) and 3 × linear, at most 30 % (01.07.2025–31.12.2027,
 * Gesetz für ein steuerliches Investitionssofortprogramm).
 */
const DEGRESSIVE_WINDOWS = [
  { from: '2020-04-01', to: '2022-12-31', factor: 2.5, cap: 0.25 },
  { from: '2025-07-01', to: '2027-12-31', factor: 3, cap: 0.3 },
] as const;
export const degressiveRate = (activationDate: string, usefulLifeYears: number): number => {
  const window = DEGRESSIVE_WINDOWS.find((entry) => activationDate >= entry.from && activationDate <= entry.to);
  if (!window) throw new Error('ASSET_DEGRESSIVE_NOT_ALLOWED: Degressive AfA gilt nur für Zugänge 01.04.2020–31.12.2022 und 01.07.2025–31.12.2027.');
  return Math.min(window.cap, window.factor / usefulLifeYears);
};

export const DEPRECIATION_EXPENSE_ACCOUNTS = {
  SKR03: '4830',
  SKR04: '6220',
} as const;

const toCents = (value: number): number => Math.round((value + Number.EPSILON) * 100);
const fromCents = (value: number): number => value / 100;

/** Minimal §7g IAB lifecycle facts; submission and tax authority validation stay outside this engine. */
export const calculateIabLifecycle = (input: IabLifecycleInput): IabLifecycleResult => {
  if (!Number.isInteger(input.formedYear) || input.formedYear < 2000) throw new RangeError('Invalid IAB formation year');
  if (input.asOfYear !== undefined && (!Number.isInteger(input.asOfYear) || input.asOfYear < input.formedYear)) throw new RangeError('Invalid IAB as-of year');
  const formed = toCents(input.formedAmount);
  const used = toCents(input.usedAmount ?? 0);
  const repaid = toCents(input.repaidAmount ?? 0);
  if (![input.formedAmount, input.usedAmount ?? 0, input.repaidAmount ?? 0].every(Number.isFinite) || formed <= 0 || used < 0 || repaid < 0 || used + repaid > formed) throw new RangeError('IAB lifecycle allocation exceeds formed amount');
  const remaining = formed - used - repaid;
  const status = remaining === 0
    ? (repaid > 0 && used === 0 ? 'repaid' : 'used')
    : (input.asOfYear !== undefined && input.asOfYear > input.formedYear + 3 ? 'expired' : (used > 0 || repaid > 0 ? 'partially-used' : 'open'));
  return {
    formedAmount: fromCents(formed),
    usedAmount: fromCents(used),
    repaidAmount: fromCents(repaid),
    remainingAmount: fromCents(remaining),
    status,
  };
};

/** Minimal §7g special-depreciation lifecycle facts with the statutory 20% ceiling. */
export const calculateSpecialDepreciationLifecycle = (
  input: SpecialDepreciationLifecycleInput,
): SpecialDepreciationLifecycleResult => {
  const acquisition = toCents(input.acquisitionCost);
  const rate = input.maxRate ?? 0.2;
  if (!Number.isFinite(input.acquisitionCost) || !Number.isFinite(input.recognizedAmount ?? 0) || acquisition < 0 || !Number.isFinite(rate) || rate < 0 || rate > 1) throw new RangeError('Invalid special depreciation base or rate');
  if (input.asOfYear !== undefined && (!Number.isInteger(input.asOfYear) || input.asOfYear < 2000)) throw new RangeError('Invalid special depreciation year');
  const eligible = Math.round(acquisition * rate);
  const recognized = toCents(input.recognizedAmount ?? 0);
  if (recognized < 0 || recognized > eligible) throw new RangeError('Special depreciation exceeds the eligible amount');
  return { eligibleAmount: fromCents(eligible), recognizedAmount: fromCents(recognized), remainingAmount: fromCents(eligible - recognized) };
};

const parseDate = (value: string): Date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid date: ${value}`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(`Invalid date: ${value}`);
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
  const fiscalYearStart = input.fiscalYearStart ?? '01-01';
  const fiscalYearOf = (date: Date): number => fiscalYearForDate(date.toISOString().slice(0, 10), fiscalYearStart);
  const firstYear = fiscalYearOf(activation);
  if (method === 'gwg') {
    return [{ year: firstYear, amount: fromCents(baseCents), months: 12 }];
  }
  if (method === 'pool') {
    const periods: DepreciationSchedulePeriod[] = [];
    let allocated = 0;
    for (let index = 0; index < 5; index += 1) {
      const amount = index === 4 ? baseCents - allocated : Math.round(baseCents / 5);
      allocated += amount;
      periods.push({
        year: firstYear + index,
        amount: fromCents(amount),
        months: 12,
      });
    }
    return periods;
  }

  const usefulLife = resolveUsefulLife(input);
  if (usefulLife === 1 && method === 'linear' && DIGITAL_ASSET_CLASSES.has(input.assetClass)) {
    return [{ year: firstYear, amount: fromCents(baseCents), months: 12 }];
  }
  const totalMonths = usefulLife * 12;
  const monthsByYear = new Map<number, number>();
  for (let month = 0; month < totalMonths; month += 1) {
    const cursor = new Date(Date.UTC(
      activation.getUTCFullYear(),
      activation.getUTCMonth() + month,
      1,
    ));
    const year = fiscalYearOf(cursor);
    monthsByYear.set(year, (monthsByYear.get(year) ?? 0) + 1);
  }

  if (method === 'degressive') {
    // Book value × rate, pro rata temporis in the first year; switch to linear on the rest once that is higher (§ 7 Abs. 3 EStG).
    const rate = degressiveRate(input.activationDate, usefulLife);
    const periods: DepreciationSchedulePeriod[] = [];
    let remaining = baseCents;
    let remainingMonths = totalMonths;
    for (const [year, months] of monthsByYear) {
      if (remaining <= 0) break;
      const degressive = Math.round(remaining * rate * months / 12);
      const linear = Math.round(remaining * months / remainingMonths);
      const amount = remainingMonths <= months ? remaining : Math.min(remaining, Math.max(degressive, linear));
      periods.push({ year, amount: fromCents(amount), months });
      remaining -= amount;
      remainingMonths -= months;
    }
    return periods;
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
  } else if (method === 'degressive' || (resolveUsefulLife(input) === 1 && DIGITAL_ASSET_CLASSES.has(input.assetClass))) {
    // Every earlier Wirtschaftsjahr in full, the year of the disposal up to its month (pro rata temporis).
    const fiscalYearStart = input.fiscalYearStart ?? '01-01';
    const disposalYear = fiscalYearForDate(input.disposalDate, fiscalYearStart);
    const schedule = buildDepreciationSchedule(input);
    const before = schedule.filter((period) => period.year < disposalYear).reduce((sum, period) => sum + toCents(period.amount), 0);
    const current = schedule.find((period) => period.year === disposalYear);
    const [startMonth] = fiscalYearStart.split('-').map(Number);
    const periodStart = disposalYear === fiscalYearForDate(input.activationDate, fiscalYearStart)
      ? activation
      : new Date(Date.UTC(disposalYear, startMonth! - 1, 1));
    const elapsed = (disposal.getUTCFullYear() - periodStart.getUTCFullYear()) * 12 + disposal.getUTCMonth() - periodStart.getUTCMonth() + 1;
    depreciationCents = before + (current ? Math.round(toCents(current.amount) * Math.min(current.months, elapsed) / current.months) : 0);
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
