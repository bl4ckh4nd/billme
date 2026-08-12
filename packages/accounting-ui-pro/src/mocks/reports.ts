import {
  BalanceSheetPreview,
  GuvReport,
  ReportDrilldownEntry,
  SusaReport,
} from '../domain/reportTypes';

type BaseSusaRow = [
  accountNumber: string,
  accountName: string,
  openingBalance: number,
  debitTurnover: number,
  creditTurnover: number,
  closingBalance: number,
  normalBalance: 'debit' | 'credit',
  mappedTo?: string,
];

const baseSusaRows: BaseSusaRow[] = [
  ['1000', 'Kasse', 1200, 4500, 3900, 1800, 'debit', 'Bilanz > Umlaufvermögen'],
  ['1200', 'Bank', 18250, 48500, 46120, 20630, 'debit', 'Bilanz > Umlaufvermögen'],
  ['1576', 'Abziehbare Vorsteuer 19%', 0, 1420, 990, 430, 'debit', 'Bilanz > Forderungen'],
  ['1600', 'Verbindlichkeiten aus Lieferungen', 6200, 2100, 5400, 9500, 'credit', 'Bilanz > Verbindlichkeiten'],
  ['4400', 'Erlöse 19% USt', 0, 0, 31200, -31200, 'credit', 'GuV > Umsatzerlöse'],
  ['4930', 'Bürobedarf', 0, 1650, 0, 1650, 'debit', 'GuV > Sonstige betriebliche Aufwendungen'],
  ['4530', 'Kfz-Betriebskosten', 0, 3200, 0, 3200, 'debit', 'GuV > Sonstige betriebliche Aufwendungen'],
  ['4830', 'Miete', 0, 7200, 0, 7200, 'debit', 'GuV > Raumkosten'],
  ['6200', 'Löhne und Gehälter', 0, 18200, 0, 18200, 'debit', 'GuV > Personalaufwand'],
  ['6330', 'Gehälter Aushilfen', 0, 4200, 0, 4200, 'debit', 'GuV > Personalaufwand'],
  ['6800', 'Porto', 0, 210, 0, 210, 'debit', 'GuV > Vertriebskosten'],
  ['6855', 'Reisekosten', 0, 850, 0, 850, 'debit', 'GuV > Vertriebskosten'],
  ['7300', 'Zinsen und ähnliche Aufwendungen', 0, 180, 0, 180, 'debit', 'GuV > Finanzergebnis'],
  ['9000', 'Saldenvorträge Sachkonten', 0, 0, 0, 0, 'debit', undefined],
];

export const mockSusaReportBase: SusaReport = {
  rows: baseSusaRows.map((r, idx) => ({
    accountNumber: r[0] as string,
    accountName: r[1] as string,
    openingBalance: r[2] as number,
    debitTurnover: r[3] as number,
    creditTurnover: r[4] as number,
    closingBalance: r[5] as number,
    normalBalance: r[6] as 'debit' | 'credit',
    mappedTo: r[7] as string | undefined,
    hasWarnings: idx % 7 === 0,
  })),
  totals: {
    openingDebit: 25450,
    openingCredit: 6200,
    turnoverDebit: 91930,
    turnoverCredit: 86410,
    closingDebit: 46520,
    closingCredit: 31100,
  },
  quality: {
    unmappedAccounts: 1,
    warnings: 3,
    generatedAt: new Date().toISOString(),
    source: 'mock',
  },
};

export const mockGuvReportBase: GuvReport = {
  lines: [
    {
      id: 'guv-1',
      code: '1',
      label: 'Umsatzerlöse',
      level: 0,
      amountCurrent: 31200,
      amountCompare: 28700,
      accountRefs: ['4400'],
      isSubtotal: true,
    },
    {
      id: 'guv-2',
      code: '2',
      label: 'Sonstige betriebliche Erträge',
      level: 0,
      amountCurrent: 980,
      amountCompare: 750,
      accountRefs: ['2740'],
    },
    {
      id: 'guv-3',
      code: '3',
      label: 'Material-/Betriebskosten',
      level: 0,
      amountCurrent: -4850,
      amountCompare: -4510,
      children: [
        {
          id: 'guv-3-1',
          code: '3.1',
          label: 'Bürobedarf',
          level: 1,
          amountCurrent: -1650,
          amountCompare: -1430,
          accountRefs: ['4930'],
        },
        {
          id: 'guv-3-2',
          code: '3.2',
          label: 'Kfz-Betriebskosten',
          level: 1,
          amountCurrent: -3200,
          amountCompare: -3080,
          accountRefs: ['4530'],
        },
      ],
      isSubtotal: true,
    },
    {
      id: 'guv-4',
      code: '4',
      label: 'Raumkosten',
      level: 0,
      amountCurrent: -7200,
      amountCompare: -7200,
      accountRefs: ['4830'],
    },
    {
      id: 'guv-5',
      code: '5',
      label: 'Personalaufwand',
      level: 0,
      amountCurrent: -22400,
      amountCompare: -21100,
      children: [
        {
          id: 'guv-5-1',
          code: '5.1',
          label: 'Löhne und Gehälter',
          level: 1,
          amountCurrent: -18200,
          amountCompare: -17150,
          accountRefs: ['6200'],
        },
        {
          id: 'guv-5-2',
          code: '5.2',
          label: 'Aushilfen',
          level: 1,
          amountCurrent: -4200,
          amountCompare: -3950,
          accountRefs: ['6330'],
        },
      ],
      isSubtotal: true,
    },
    {
      id: 'guv-6',
      code: '6',
      label: 'Vertriebskosten',
      level: 0,
      amountCurrent: -1060,
      amountCompare: -920,
      accountRefs: ['6800', '6855'],
    },
    {
      id: 'guv-7',
      code: '7',
      label: 'Finanzergebnis',
      level: 0,
      amountCurrent: -180,
      amountCompare: -230,
      accountRefs: ['7300'],
    },
    {
      id: 'guv-8',
      code: '8',
      label: 'Jahresergebnis (Beispiel)',
      level: 0,
      amountCurrent: -3510,
      amountCompare: -4510,
      isSubtotal: true,
      accountRefs: ['4400', '4930', '4530', '4830', '6200', '6330', '6800', '6855', '7300'],
    },
  ],
  totals: {
    revenue: 32180,
    expenses: 35690,
    result: -3510,
  },
  quality: {
    unmappedAccounts: 1,
    warnings: 2,
    generatedAt: new Date().toISOString(),
    source: 'mock',
  },
};

export const mockBalanceSheetPreviewBase: BalanceSheetPreview = {
  aktiva: [
    { id: 'a-1', code: 'A.I', label: 'Anlagevermögen', amount: 28182.5, level: 0, side: 'aktiva', isSubtotal: true },
    { id: 'a-1-1', code: 'A.I.1', label: 'Technische Anlagen / Fuhrpark', amount: 23266.67, level: 1, side: 'aktiva' },
    { id: 'a-1-2', code: 'A.I.2', label: 'Betriebs- und Geschäftsausstattung', amount: 4915.83, level: 1, side: 'aktiva' },
    { id: 'a-2', code: 'B.I', label: 'Umlaufvermögen', amount: 21060, level: 0, side: 'aktiva', isSubtotal: true },
    { id: 'a-2-1', code: 'B.I.1', label: 'Kasse / Bank', amount: 22430, level: 1, side: 'aktiva' },
    { id: 'a-2-2', code: 'B.I.2', label: 'Steuerforderungen', amount: -1370, level: 1, side: 'aktiva' },
  ],
  passiva: [
    { id: 'p-1', code: 'A', label: 'Eigenkapital', amount: 19742.5, level: 0, side: 'passiva', isSubtotal: true },
    { id: 'p-1-1', code: 'A.I', label: 'Gezeichnetes Kapital / EK', amount: 23252.5, level: 1, side: 'passiva' },
    { id: 'p-1-2', code: 'A.II', label: 'Jahresergebnis (Beispiel)', amount: -3510, level: 1, side: 'passiva' },
    { id: 'p-2', code: 'C', label: 'Verbindlichkeiten', amount: 29500, level: 0, side: 'passiva', isSubtotal: true },
    { id: 'p-2-1', code: 'C.1', label: 'Verbindlichkeiten aus LuL', amount: 9500, level: 1, side: 'passiva' },
    { id: 'p-2-2', code: 'C.2', label: 'Sonstige Verbindlichkeiten', amount: 20000, level: 1, side: 'passiva' },
  ],
  totals: {
    aktiva: 49242.5,
    passiva: 49242.5,
    difference: 0,
  },
  quality: {
    status: 'ok',
    notes: ['Bilanz ist ein Beispiel. 1 Konto ist aktuell noch ungemappt.'],
    generatedAt: new Date().toISOString(),
    source: 'mock',
  },
};

export const mockDrilldownEntriesByAccount: Record<string, ReportDrilldownEntry[]> = {
  '1200': [
    { id: 'd1', date: '2026-03-01', bookingText: 'Kundenzahlung Projekt A', reference: 'J-2026-0012', transactionId: 'tx-2', accountNumber: '1200', debit: 2500, credit: 0, amount: 2500, source: 'Abgleich' },
    { id: 'd2', date: '2026-03-02', bookingText: 'Softwarelizenz', reference: 'J-2026-0013', transactionId: 'tx-1', accountNumber: '1200', debit: 0, credit: 119, amount: -119, source: 'Inbox' },
    { id: 'd3', date: '2026-03-05', bookingText: 'Miete März', reference: 'J-2026-0019', accountNumber: '1200', debit: 0, credit: 2400, amount: -2400, source: 'Manuell' },
  ],
  '4400': [
    { id: 'd4', date: '2026-03-01', bookingText: 'Erlöse Projekt A', reference: 'J-2026-0012', transactionId: 'tx-2', accountNumber: '4400', debit: 0, credit: 2100.84, amount: -2100.84, source: 'Abgleich' },
  ],
  '4930': [
    { id: 'd5', date: '2026-03-02', bookingText: 'Bürobedarf Bestellung', reference: 'J-2026-0013', transactionId: 'tx-4', accountNumber: '4930', debit: 100, credit: 0, amount: 100, source: 'Inbox' },
  ],
  '4530': [
    { id: 'd6', date: '2026-03-06', bookingText: 'Tanken Firmenwagen', reference: 'J-2026-0024', transactionId: 'tx-3', accountNumber: '4530', debit: 85.5, credit: 0, amount: 85.5, source: 'Inbox' },
  ],
  '6200': [
    { id: 'd7', date: '2026-03-31', bookingText: 'Lohnlauf März', reference: 'J-2026-0042', accountNumber: '6200', debit: 18200, credit: 0, amount: 18200, source: 'Manuell' },
  ],
};
