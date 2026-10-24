/**
 * Default accounts for the Lite DATEV export: Anlage-EÜR Kennziffer → standard DATEV SKR03/SKR04
 * account. billme Lite keeps no ledger; this table only lets the tax advisor import the EÜR cash
 * items as a Buchungsstapel.
 *
 * VAT: Lite items carry the gross payment. Accounts marked `autoRate` are DATEV Automatikkonten
 * (DATEV computes the tax from the gross itself), so their rows carry no BU-Schlüssel, and an item
 * whose rate differs from that rate cannot go to that account. Every other account gets the BU key
 * for the item's rate (`datevBuKey`).
 *
 * ponytail: one account per Kennziffer (per rate for 100/112); the advisor re-books finer splits.
 * Kennziffern not listed here come back as row errors. Extend the table when a user needs one.
 */
export type DatevChart = 'SKR03' | 'SKR04';

type DatevAccount = { SKR03: string; SKR04: string; label: string; autoRate?: 19 | 7 };

const ACCOUNTS: Record<string, DatevAccount> = {
  // Einnahmen
  '111': { SKR03: '8195', SKR04: '4185', label: 'Erlöse als Kleinunternehmer i. S. d. § 19 Abs. 1 UStG' },
  '112': { SKR03: '8400', SKR04: '4400', label: 'Erlöse 19 % USt', autoRate: 19 },
  '112@7': { SKR03: '8300', SKR04: '4300', label: 'Erlöse 7 % USt', autoRate: 7 },
  '103': { SKR03: '8100', SKR04: '4100', label: 'Steuerfreie Umsätze § 4 Nr. 8 ff. UStG' },
  '140': { SKR03: '1776', SKR04: '3806', label: 'Umsatzsteuer 19 %' },
  '141': { SKR03: '1780', SKR04: '3820', label: 'Umsatzsteuer-Vorauszahlungen (Erstattung)' },
  // Ausgaben
  '100': { SKR03: '3400', SKR04: '5400', label: 'Wareneingang 19 % Vorsteuer', autoRate: 19 },
  '100@7': { SKR03: '3300', SKR04: '5300', label: 'Wareneingang 7 % Vorsteuer', autoRate: 7 },
  '100@0': { SKR03: '3200', SKR04: '5200', label: 'Wareneingang' },
  '110': { SKR03: '3100', SKR04: '5900', label: 'Fremdleistungen' },
  '120': { SKR03: '4120', SKR04: '6020', label: 'Gehälter' },
  '132': { SKR03: '4855', SKR04: '6260', label: 'Sofortabschreibung geringwertiger Wirtschaftsgüter' },
  '150': { SKR03: '4210', SKR04: '6310', label: 'Miete' },
  '175': { SKR03: '4650', SKR04: '6640', label: 'Bewirtungskosten' },
  '165': { SKR03: '4654', SKR04: '6644', label: 'Nicht abzugsfähige Bewirtungskosten' },
  '174': { SKR03: '4630', SKR04: '6610', label: 'Geschenke abzugsfähig' },
  '164': { SKR03: '4635', SKR04: '6620', label: 'Geschenke nicht abzugsfähig' },
  '171': { SKR03: '4674', SKR04: '6674', label: 'Reisekosten Unternehmer Verpflegungsmehraufwand' },
  '183': { SKR03: '4900', SKR04: '6300', label: 'Sonstige betriebliche Aufwendungen' },
  '185': { SKR03: '1576', SKR04: '1406', label: 'Abziehbare Vorsteuer 19 %' },
  '186': { SKR03: '1780', SKR04: '3820', label: 'Umsatzsteuer-Vorauszahlungen' },
  '194': { SKR03: '4950', SKR04: '6825', label: 'Rechts- und Beratungskosten' },
  '221': { SKR03: '4670', SKR04: '6670', label: 'Reisekosten Unternehmer Fahrtkosten' },
  '222': { SKR03: '4960', SKR04: '6835', label: 'Mieten für Einrichtungen' },
  '223': { SKR03: '4360', SKR04: '6400', label: 'Versicherungen' },
  '224': { SKR03: '4600', SKR04: '6600', label: 'Werbekosten' },
  '225': { SKR03: '4805', SKR04: '6470', label: 'Reparaturen und Instandhaltung' },
  '227': { SKR03: '4710', SKR04: '6710', label: 'Verpackungsmaterial' },
  '228': { SKR03: '4806', SKR04: '6495', label: 'Wartungskosten für Hard- und Software' },
  '229': { SKR03: '4985', SKR04: '6845', label: 'Werkzeuge und Kleingeräte' },
  '232': { SKR03: '2120', SKR04: '7320', label: 'Zinsaufwendungen für langfristige Verbindlichkeiten' },
  '234': { SKR03: '2110', SKR04: '7310', label: 'Zinsaufwendungen für kurzfristige Verbindlichkeiten' },
  '280': { SKR03: '4920', SKR04: '6805', label: 'Telefon' },
  '281': { SKR03: '4945', SKR04: '6821', label: 'Fortbildungskosten' },
  '144': { SKR03: '4570', SKR04: '6560', label: 'Mietleasing Kfz' },
  '145': { SKR03: '4520', SKR04: '6520', label: 'Kfz-Versicherungen' },
  '146': { SKR03: '4530', SKR04: '6530', label: 'Laufende Kfz-Betriebskosten' },
};

/** Geldkonten: Bank 1200/1800, Kasse 1000/1600. */
export const DATEV_MONEY_ACCOUNTS = {
  bank: { SKR03: '1200', SKR04: '1800' },
  cash: { SKR03: '1000', SKR04: '1600' },
} as const;

/** Privatentnahmen allgemein / Privateinlagen (SKR03 1800/1890, SKR04 2100/2180). */
export const DATEV_PRIVATE_ACCOUNTS = {
  withdrawal: { SKR03: '1800', SKR04: '2100' },
  contribution: { SKR03: '1890', SKR04: '2180' },
} as const;

/** Geldtransit between own accounts (SKR03 1360, SKR04 1460); both legs balance it out. */
export const DATEV_TRANSIT_ACCOUNT = { SKR03: '1360', SKR04: '1460' } as const;

export type DatevAccountChoice = { account: string; buKey?: string } | { error: string };

/**
 * BU-Schlüssel (DATEV field 9, four digits): 3 = USt 19 %, 2 = USt 7 % on income;
 * 9 = Vorsteuer 19 %, 8 = Vorsteuer 7 % on expenses.
 */
const buKeyFor = (flow: 'income' | 'expense', rate: number): string | undefined => {
  if (rate === 19) return flow === 'income' ? '0003' : '0009';
  if (rate === 7) return flow === 'income' ? '0002' : '0008';
  return undefined;
};

/** Account (and BU key) for an EÜR Kennziffer at a VAT rate of 0, 7 or 19 %. */
export const datevAccountFor = (kennziffer: string | undefined, rate: number, flow: 'income' | 'expense', chart: DatevChart): DatevAccountChoice => {
  const entry = kennziffer ? ACCOUNTS[`${kennziffer}@${rate}`] ?? ACCOUNTS[kennziffer] : undefined;
  if (!entry) return { error: `Kennziffer ${kennziffer ?? '–'} hat kein DATEV-Standardkonto.` };
  if (entry.autoRate !== undefined) {
    return entry.autoRate === rate
      ? { account: entry[chart] }
      : { error: `Kennziffer ${kennziffer} mit ${rate} % USt passt zu keinem DATEV-Automatikkonto.` };
  }
  if (rate !== 0 && rate !== 7 && rate !== 19) return { error: `Steuersatz ${rate} % wird im DATEV-Export nicht unterstützt.` };
  return { account: entry[chart], buKey: buKeyFor(flow, rate) };
};
