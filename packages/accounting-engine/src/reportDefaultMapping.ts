import { listReportMappingPositions } from './reportMappingCatalog';

/**
 * Default report positions by account range of the DATEV Kontenrahmen (SKR03 / SKR04, edition 2025),
 * so GuV (§ 275 HGB, Gesamtkostenverfahren), Bilanz (§ 266 HGB) and BWA 01 run without mapping every account by
 * hand. A tenant mapping (report_account_mappings) always wins; defaults are resolved at report time and
 * never stored. Ranges without a clear § 266/§ 275 position (ausstehende Einlagen, kalkulatorische Kosten,
 * Ergebnisverwendung, statistische Konten, SKR03 Klassen 5/6) stay unmapped and keep blocking.
 */
type Range = readonly [from: number, to: number, position: string];

const SKR03_BILANZ: readonly Range[] = [
  [10, 49, 'assets.non-current.intangible'],
  [50, 199, 'assets.non-current.tangible.land'],
  [200, 299, 'assets.non-current.tangible.machinery'],
  [300, 499, 'assets.non-current.tangible.equipment'],
  [500, 599, 'assets.non-current.financial'],
  [600, 629, 'liabilities.bonds'],
  [630, 699, 'liabilities.bank'],
  [700, 729, 'liabilities.affiliates'],
  [730, 799, 'liabilities.other'],
  [800, 839, 'equity.subscribed'],
  [840, 845, 'equity.capital-reserve'],
  [846, 859, 'equity.revenue-reserves'],
  [860, 869, 'equity.profit-loss-forward'],
  // Festkapital, variables Kapital, Kommanditkapital: the Kapitalkonto of a sole proprietor or partnership.
  [870, 889, 'equity'],
  [890, 899, 'liabilities.other'],
  [900, 949, 'equity'],
  [950, 954, 'provisions.pensions'],
  [955, 969, 'provisions.tax'],
  [970, 979, 'provisions.other'],
  [980, 989, 'assets.prepaid'],
  [990, 999, 'liabilities.prepaid'],
  [1000, 1299, 'assets.current.cash'],
  [1300, 1329, 'assets.current.securities.other'],
  [1330, 1339, 'assets.current.cash'],
  [1340, 1349, 'assets.current.securities.affiliates'],
  [1350, 1359, 'assets.current.securities.other'],
  // Geldtransit and the other Verrechnungskonten: their balance should be 0, a rest is a sonstiger Vermögensgegenstand.
  [1360, 1399, 'assets.current.receivables.other'],
  [1400, 1469, 'assets.current.receivables.trade'],
  [1470, 1479, 'assets.current.receivables.affiliates'],
  [1480, 1489, 'assets.current.receivables.participations'],
  [1490, 1499, 'assets.current.receivables.trade'],
  [1500, 1599, 'assets.current.receivables.other'],
  [1600, 1699, 'liabilities.trade'],
  [1700, 1709, 'liabilities.other'],
  [1710, 1729, 'liabilities.advances'],
  [1730, 1799, 'liabilities.other'],
  // Privatentnahmen und -einlagen reduce or raise the Eigenkapital of a sole proprietor.
  [1800, 1999, 'equity'],
  [3970, 3979, 'assets.current.inventory.materials'],
  [3980, 3999, 'assets.current.inventory.finished'],
  [7000, 7099, 'assets.current.inventory.work-in-progress'],
  [7100, 7999, 'assets.current.inventory.finished'],
];

const SKR03_GUV: readonly Range[] = [
  [2000, 2099, 'other-operating-expense'],
  [2100, 2149, 'interest-expense'],
  [2150, 2199, 'other-operating-expense'],
  [2200, 2284, 'income-tax'],
  [2285, 2289, 'other-tax'],
  [2290, 2299, 'income-tax'],
  [2300, 2499, 'other-operating-expense'],
  [2500, 2599, 'other-operating-income'],
  [2600, 2619, 'investment-income'],
  [2620, 2649, 'securities-income'],
  [2650, 2699, 'interest-income'],
  [2700, 2799, 'other-operating-income'],
  [3000, 3099, 'material.raw'],
  [3100, 3199, 'material.services'],
  [3200, 3969, 'material.raw'],
  [4000, 4099, 'material.raw'],
  [4100, 4129, 'personnel.wages'],
  [4130, 4169, 'personnel.social'],
  [4170, 4199, 'personnel.wages'],
  [4200, 4319, 'other-operating-expense'],
  [4320, 4329, 'income-tax'],
  [4330, 4359, 'other-tax'],
  [4360, 4509, 'other-operating-expense'],
  [4510, 4519, 'other-tax'],
  [4520, 4819, 'other-operating-expense'],
  [4820, 4869, 'depreciation.intangible-tangible'],
  [4870, 4879, 'financial-depreciation'],
  [4880, 4889, 'depreciation.current-assets'],
  [4890, 4989, 'other-operating-expense'],
  [8000, 8799, 'revenue'],
  [8800, 8899, 'other-operating-income'],
  [8900, 8959, 'revenue'],
  [8960, 8989, 'inventory-change'],
  [8990, 8999, 'capitalized-work'],
];

/**
 * BWA 01 lines by the account groups of the Kontenrahmen (Raumkosten 4200–4299, Kfz 4500–4599, …). Kfz-Steuer and
 * the other Betriebssteuern go to „Betriebliche Steuern“, Gewerbe- and Körperschaftsteuer to „Steuern“ after the
 * result; Anlagenverkäufe, Kursdifferenzen and Abschreibungen auf Finanzanlagen are neutral. Bestandsveränderungen,
 * aktivierte Eigenleistungen and kalkulatorische Kosten have no BWA 01 line here and keep blocking.
 */
const SKR03_BWA: readonly Range[] = [
  [2000, 2099, 'other-neutral-expense'],
  [2100, 2149, 'interest-expense'],
  [2150, 2199, 'other-neutral-expense'],
  [2200, 2299, 'income-tax'],
  [2300, 2399, 'other-neutral-expense'],
  [2400, 2499, 'other-operating-expense'],
  [2500, 2649, 'other-neutral-income'],
  [2650, 2699, 'interest-income'],
  [2700, 2799, 'other-neutral-income'],
  [3000, 3969, 'material-expense'],
  [4000, 4099, 'material-expense'],
  [4100, 4199, 'personnel-expense'],
  [4200, 4299, 'space-expense'],
  [4300, 4319, 'other-operating-expense'],
  [4320, 4329, 'income-tax'],
  [4330, 4359, 'operating-tax'],
  [4360, 4399, 'insurance'],
  [4500, 4509, 'vehicle-expense'],
  [4510, 4519, 'operating-tax'],
  [4520, 4599, 'vehicle-expense'],
  [4600, 4699, 'advertising-travel'],
  [4700, 4799, 'cost-of-goods-out'],
  [4800, 4809, 'maintenance'],
  [4810, 4819, 'other-operating-expense'],
  [4820, 4869, 'depreciation'],
  [4870, 4879, 'other-neutral-expense'],
  [4880, 4889, 'depreciation'],
  [4890, 4989, 'other-operating-expense'],
  [8000, 8599, 'revenue'],
  [8600, 8649, 'special-operating-income'],
  [8650, 8699, 'interest-income'],
  [8700, 8799, 'revenue'],
  [8800, 8899, 'other-neutral-income'],
  [8900, 8959, 'revenue'],
];

const SKR04_BILANZ: readonly Range[] = [
  [100, 199, 'assets.non-current.intangible'],
  [200, 399, 'assets.non-current.tangible.land'],
  [400, 499, 'assets.non-current.tangible.machinery'],
  [500, 699, 'assets.non-current.tangible.equipment'],
  [700, 799, 'assets.non-current.tangible.construction'],
  [800, 999, 'assets.non-current.financial'],
  [1000, 1039, 'assets.current.inventory.materials'],
  [1040, 1099, 'assets.current.inventory.work-in-progress'],
  [1100, 1179, 'assets.current.inventory.finished'],
  [1180, 1199, 'assets.current.inventory.advances'],
  [1200, 1249, 'assets.current.receivables.trade'],
  [1250, 1259, 'assets.current.receivables.other'],
  [1260, 1279, 'assets.current.receivables.affiliates'],
  [1280, 1299, 'assets.current.receivables.participations'],
  // 1460 Geldtransit lies in here: its balance should be 0, a rest is a sonstiger Vermögensgegenstand.
  [1300, 1499, 'assets.current.receivables.other'],
  [1500, 1509, 'assets.current.securities.affiliates'],
  [1510, 1549, 'assets.current.securities.other'],
  [1550, 1899, 'assets.current.cash'],
  [1900, 1949, 'assets.prepaid'],
  [1950, 1959, 'assets.deferred-tax'],
  // Kapital, Privatentnahmen und -einlagen of sole proprietors and partnerships.
  [2000, 2899, 'equity'],
  [2900, 2909, 'equity.subscribed'],
  [2920, 2929, 'equity.capital-reserve'],
  [2930, 2969, 'equity.revenue-reserves'],
  [2970, 2979, 'equity.profit-loss-forward'],
  [3000, 3019, 'provisions.pensions'],
  [3020, 3069, 'provisions.tax'],
  [3070, 3099, 'provisions.other'],
  [3100, 3149, 'liabilities.bonds'],
  [3150, 3249, 'liabilities.bank'],
  [3250, 3299, 'liabilities.advances'],
  [3300, 3399, 'liabilities.trade'],
  [3400, 3449, 'liabilities.affiliates'],
  [3450, 3499, 'liabilities.participations'],
  [3500, 3899, 'liabilities.other'],
  [3900, 3949, 'liabilities.prepaid'],
];

const SKR04_GUV: readonly Range[] = [
  [4000, 4799, 'revenue'],
  [4800, 4819, 'inventory-change'],
  [4820, 4829, 'capitalized-work'],
  [4830, 4999, 'other-operating-income'],
  [5000, 5899, 'material.raw'],
  [5900, 5999, 'material.services'],
  [6000, 6099, 'personnel.wages'],
  [6100, 6199, 'personnel.social'],
  [6200, 6269, 'depreciation.intangible-tangible'],
  [6270, 6289, 'depreciation.current-assets'],
  [6290, 6999, 'other-operating-expense'],
  [7000, 7009, 'investment-income'],
  [7010, 7099, 'securities-income'],
  [7100, 7199, 'interest-income'],
  [7200, 7299, 'financial-depreciation'],
  [7300, 7399, 'interest-expense'],
  [7600, 7649, 'income-tax'],
  [7650, 7699, 'other-tax'],
];

const SKR04_BWA: readonly Range[] = [
  [4000, 4499, 'revenue'],
  [4500, 4599, 'special-operating-income'],
  [4600, 4799, 'revenue'],
  [4830, 4999, 'other-neutral-income'],
  [5000, 5999, 'material-expense'],
  [6000, 6199, 'personnel-expense'],
  [6200, 6279, 'depreciation'],
  [6280, 6299, 'other-operating-expense'],
  [6300, 6309, 'other-operating-expense'],
  [6310, 6389, 'space-expense'],
  [6390, 6399, 'other-operating-expense'],
  [6400, 6449, 'insurance'],
  [6450, 6499, 'maintenance'],
  [6500, 6599, 'vehicle-expense'],
  [6600, 6699, 'advertising-travel'],
  [6700, 6799, 'cost-of-goods-out'],
  [6800, 6879, 'other-operating-expense'],
  [6880, 6899, 'other-neutral-expense'],
  [6900, 6959, 'other-operating-expense'],
  [6960, 6969, 'other-neutral-expense'],
  [7000, 7099, 'other-neutral-income'],
  [7100, 7199, 'interest-income'],
  [7200, 7299, 'other-neutral-expense'],
  [7300, 7399, 'interest-expense'],
  [7600, 7649, 'income-tax'],
  [7650, 7699, 'operating-tax'],
];

const RANGES = {
  SKR03: { 'hgb-bilanz': SKR03_BILANZ, 'hgb-guv': SKR03_GUV, bwa01: SKR03_BWA },
  SKR04: { 'hgb-bilanz': SKR04_BILANZ, 'hgb-guv': SKR04_GUV, bwa01: SKR04_BWA },
} as const;

export type DefaultReportStatement = 'hgb-guv' | 'hgb-bilanz' | 'bwa01';
/** The profit-and-loss layout whose defaults apply besides the balance sheet. */
export type DefaultResultStatement = 'hgb-guv' | 'bwa01';
export interface DefaultReportPosition { statement: DefaultReportStatement; position: string; side?: 'asset' | 'liability' }

/** The § 266 position, else the position of `result` (§ 275 or BWA 01), an account falls into by its number; undefined when its range has none. */
export const defaultReportPosition = (chart: 'SKR03' | 'SKR04', accountNumber: string, result: DefaultResultStatement = 'hgb-guv'): DefaultReportPosition | undefined => {
  if (!/^\d{4}$/.test(accountNumber)) return undefined;
  const number = Number(accountNumber);
  for (const statement of ['hgb-bilanz', result] as const) {
    const hit = RANGES[chart][statement].find(([from, to]) => number >= from && number <= to);
    if (hit) return { statement, position: hit[2], ...(statement === 'hgb-bilanz' ? { side: hit[2].startsWith('assets.') ? 'asset' as const : 'liability' as const } : {}) };
  }
  return undefined;
};

/**
 * Defaults for the accounts that have no tenant mapping for that statement, folded onto the nearest position
 * the catalogue of the size class publishes (Kleinst-Bilanz: only the letter headings).
 */
export const defaultReportMappings = (
  chart: 'SKR03' | 'SKR04',
  accounts: readonly string[],
  size: 'micro' | 'small',
  asOfDate: string,
  mapped: (accountNumber: string, statement: DefaultReportStatement) => boolean,
  result: DefaultResultStatement = 'hgb-guv',
): Array<{ accountNumber: string; statement: DefaultReportStatement; position: string; label: string; side?: 'asset' | 'liability' }> => {
  const catalogs = new Map<DefaultReportStatement, Map<string, string>>();
  const catalog = (statement: DefaultReportStatement) => {
    if (!catalogs.has(statement)) catalogs.set(statement, new Map(listReportMappingPositions(statement, size, asOfDate).map((entry) => [entry.key, entry.label])));
    return catalogs.get(statement)!;
  };
  const out: ReturnType<typeof defaultReportMappings> = [];
  for (const accountNumber of new Set(accounts)) {
    const found = defaultReportPosition(chart, accountNumber, result);
    if (!found || mapped(accountNumber, found.statement)) continue;
    const keys = catalog(found.statement);
    let position = found.position;
    while (!keys.has(position) && position.includes('.')) position = position.slice(0, position.lastIndexOf('.'));
    if (!keys.has(position)) continue;
    out.push({ accountNumber, statement: found.statement, position, label: keys.get(position)!, ...(found.side ? { side: found.side } : {}) });
  }
  return out;
};
