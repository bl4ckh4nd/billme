import type { LedgerChart } from './accounting';

/**
 * Standard DATEV accounts for the common Anlage-EÜR Kennziffern, so an EÜR
 * classification can show the double-entry booking it corresponds to. This is
 * an explanatory preview, not a posting: EÜR businesses never book it.
 * ponytail: covers the frequent Kennziffern only; lines without a standard
 * account show "keine Standardzuordnung". Extend the table when users ask for
 * a missing line.
 */
const KZ_ACCOUNTS: Record<string, { SKR03: string; SKR04: string; label: string }> = {
  '111': { SKR03: '8195', SKR04: '4185', label: 'Erlöse Kleinunternehmer § 19 UStG' },
  '112': { SKR03: '8400', SKR04: '4400', label: 'Erlöse' },
  '103': { SKR03: '8100', SKR04: '4100', label: 'Steuerfreie Umsätze' },
  '102': { SKR03: '8820', SKR04: '4845', label: 'Erlöse aus Anlagenverkäufen' },
  '100': { SKR03: '3400', SKR04: '5400', label: 'Wareneingang' },
  '110': { SKR03: '3100', SKR04: '5900', label: 'Fremdleistungen' },
  '120': { SKR03: '4120', SKR04: '6020', label: 'Gehälter' },
  '130': { SKR03: '4830', SKR04: '6220', label: 'Abschreibungen auf Sachanlagen' },
  '131': { SKR03: '4822', SKR04: '6200', label: 'Abschreibungen auf immaterielle Vermögensgegenstände' },
  '132': { SKR03: '4855', SKR04: '6260', label: 'Sofortabschreibung GWG' },
  '150': { SKR03: '4210', SKR04: '6310', label: 'Miete' },
  '280': { SKR03: '4920', SKR04: '6805', label: 'Telefon' },
  '221': { SKR03: '4670', SKR04: '6670', label: 'Reisekosten Unternehmer' },
  '171': { SKR03: '4674', SKR04: '6674', label: 'Verpflegungsmehraufwand Unternehmer' },
  '281': { SKR03: '4945', SKR04: '6821', label: 'Fortbildungskosten' },
  '194': { SKR03: '4950', SKR04: '6825', label: 'Rechts- und Beratungskosten' },
  '222': { SKR03: '4960', SKR04: '6835', label: 'Mieten für Einrichtungen' },
  '225': { SKR03: '4805', SKR04: '6470', label: 'Reparaturen und Instandhaltung' },
  '223': { SKR03: '4360', SKR04: '6400', label: 'Versicherungen' },
  '228': { SKR03: '4806', SKR04: '6495', label: 'Wartung Hard- und Software' },
  '229': { SKR03: '4985', SKR04: '6845', label: 'Werkzeuge und Kleingeräte' },
  '227': { SKR03: '4710', SKR04: '6710', label: 'Verpackungsmaterial' },
  '224': { SKR03: '4600', SKR04: '6600', label: 'Werbekosten' },
  '232': { SKR03: '2120', SKR04: '7320', label: 'Zinsaufwendungen langfristig' },
  '234': { SKR03: '2110', SKR04: '7310', label: 'Zinsaufwendungen kurzfristig' },
  '186': { SKR03: '1780', SKR04: '3820', label: 'Umsatzsteuer-Vorauszahlungen' },
  '141': { SKR03: '1780', SKR04: '3820', label: 'Umsatzsteuer-Vorauszahlungen' },
  '183': { SKR03: '4900', SKR04: '6300', label: 'Sonstige betriebliche Aufwendungen' },
  '174': { SKR03: '4630', SKR04: '6610', label: 'Geschenke abzugsfähig' },
  '164': { SKR03: '4635', SKR04: '6620', label: 'Geschenke nicht abzugsfähig' },
  '175': { SKR03: '4650', SKR04: '6640', label: 'Bewirtungskosten' },
  '165': { SKR03: '4654', SKR04: '6644', label: 'Nicht abzugsfähige Bewirtungskosten' },
  '144': { SKR03: '4570', SKR04: '6560', label: 'Kfz-Leasing' },
  '145': { SKR03: '4520', SKR04: '6520', label: 'Kfz-Versicherungen' },
  '146': { SKR03: '4530', SKR04: '6530', label: 'Laufende Kfz-Betriebskosten' },
};

const BANK = { SKR03: '1200', SKR04: '1800' } as const;
const INPUT_VAT: Record<number, { SKR03: string; SKR04: string }> = { 19: { SKR03: '1576', SKR04: '1406' }, 7: { SKR03: '1571', SKR04: '1401' } };
const OUTPUT_VAT: Record<number, { SKR03: string; SKR04: string }> = { 19: { SKR03: '1776', SKR04: '3806' }, 7: { SKR03: '1771', SKR04: '3801' } };

export interface EurBookingLine {
  side: 'soll' | 'haben';
  account: string;
  label: string;
  amount: number;
}

/**
 * The double-entry booking an EÜR payment corresponds to, or null when the
 * Kennziffer has no standard account. Expense: Aufwand + Vorsteuer an Bank.
 * Income: Bank an Erlöse + Umsatzsteuer. Amounts are rounded to cents; the
 * VAT line absorbs the rounding so both sides stay equal to the gross.
 */
export const eurBookingPreview = (input: {
  kennziffer?: string;
  flow: 'income' | 'expense';
  gross: number;
  vatRate?: number;
  chart: LedgerChart;
}): EurBookingLine[] | null => {
  const target = input.kennziffer ? KZ_ACCOUNTS[input.kennziffer] : undefined;
  if (!target) return null;
  const gross = Math.round(Math.abs(input.gross) * 100) / 100;
  const rate = input.vatRate ?? 0;
  const vatAccounts = input.flow === 'expense' ? INPUT_VAT[rate] : OUTPUT_VAT[rate];
  const net = vatAccounts ? Math.round((gross / (1 + rate / 100)) * 100) / 100 : gross;
  const vat = Math.round((gross - net) * 100) / 100;
  const bank = { account: BANK[input.chart], label: 'Bank', amount: gross };
  const main = { account: target[input.chart], label: target.label, amount: net };
  const tax = vatAccounts && vat > 0
    ? { account: vatAccounts[input.chart], label: input.flow === 'expense' ? `Vorsteuer ${rate} %` : `Umsatzsteuer ${rate} %`, amount: vat }
    : null;
  return input.flow === 'expense'
    ? [{ side: 'soll', ...main }, ...(tax ? [{ side: 'soll' as const, ...tax }] : []), { side: 'haben', ...bank }]
    : [{ side: 'soll', ...bank }, { side: 'haben', ...main }, ...(tax ? [{ side: 'haben' as const, ...tax }] : [])];
};
