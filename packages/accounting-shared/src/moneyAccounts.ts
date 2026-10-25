/**
 * Geldkonten (Kasse, Bank, Schecks) of the DATEV Kontenrahmen 2025: the accounts a bank account may book on.
 * The ranges are those of the balance-sheet position "Kassenbestand, Guthaben bei Kreditinstituten und Schecks"
 * (§ 266 Abs. 2 B.IV HGB) in accounting-engine reportDefaultMapping.ts.
 */
export type MoneyAccountChart = 'SKR03' | 'SKR04';

/** The bank role of a chart when the tenant has not mapped it (accounting_account_mappings role `bank`). */
export const BANK_ACCOUNT_DEFAULT: Record<MoneyAccountChart, string> = { SKR03: '1200', SKR04: '1800' };

const MONEY_RANGES: Record<MoneyAccountChart, ReadonlyArray<readonly [number, number]>> = {
  SKR03: [[1000, 1299], [1330, 1339]],
  SKR04: [[1550, 1899]],
};

export const isMoneyLedgerAccount = (chart: MoneyAccountChart, accountNumber: string): boolean => {
  const trimmed = accountNumber.trim();
  if (!/^\d{4}$/.test(trimmed)) return false;
  const number = Number(trimmed);
  return MONEY_RANGES[chart].some(([from, to]) => number >= from && number <= to);
};
