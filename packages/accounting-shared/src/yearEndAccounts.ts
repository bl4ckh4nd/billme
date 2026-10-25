/**
 * Year-end accounts of the DATEV Kontenrahmen: which accounts are Erfolgskonten (closed into the result every
 * fiscal year and opened at 0) and where the result of a year goes. Classes, not report positions: SKR03 keeps
 * its Erfolgskonten in the classes 2, 3 (without the Bestände 3970-3999), 4 and 8, SKR04 in the classes 4 to 7.
 * Everything else (Bestandskonten, the 9xxx Vortrags- and statistische Konten) carries over.
 */
export type YearEndChart = 'SKR03' | 'SKR04';

export const isProfitAndLossAccount = (chart: YearEndChart, accountNumber: string): boolean => {
  const trimmed = accountNumber.trim();
  if (!/^\d{4}$/.test(trimmed)) return false;
  const number = Number(trimmed);
  if (chart === 'SKR04') return number >= 4000 && number <= 7999;
  return (number >= 2000 && number <= 3969) || (number >= 4000 && number <= 4999) || (number >= 8000 && number <= 8999);
};

/** Saldenvorträge, Sachkonten: the other side of the opening entry in both charts. */
export const OPENING_BALANCE_ACCOUNT = '9000';

/**
 * The account a year's result is closed into when the user picks none: a Kapitalgesellschaft carries it as
 * Gewinnvortrag vor Verwendung (SKR03 0860, SKR04 2970), a sole proprietor, eK or GbR on the variable Kapital
 * (SKR03 0880, SKR04 2010).
 */
export const defaultResultAccount = (chart: YearEndChart, legalForm?: string): string => {
  const corporation = legalForm === 'gmbh' || legalForm === 'ug';
  if (chart === 'SKR04') return corporation ? '2970' : '2010';
  return corporation ? '0860' : '0880';
};
