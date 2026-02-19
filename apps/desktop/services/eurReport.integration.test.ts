import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLines = [
  {
    id: 'E2025_KZ112',
    taxYear: 2025,
    kennziffer: '112',
    label: 'Umsatzsteuerpflichtige Betriebseinnahmen',
    kind: 'income',
    exportable: true,
    sortOrder: 0,
    computedFromIds: [],
    sourceVersion: 'BMF-2025-2025-08-29',
  },
  {
    id: 'E2025_KZ280',
    taxYear: 2025,
    kennziffer: '280',
    label: 'Aufwendungen fuer Telekommunikation',
    kind: 'expense',
    exportable: true,
    sortOrder: 1,
    computedFromIds: [],
    sourceVersion: 'BMF-2025-2025-08-29',
  },
  {
    id: 'E2025_KZ183',
    taxYear: 2025,
    kennziffer: '183',
    label: 'Uebrige unbeschraenkt abziehbare Betriebsausgaben',
    kind: 'expense',
    exportable: true,
    sortOrder: 2,
    computedFromIds: [],
    sourceVersion: 'BMF-2025-2025-08-29',
  },
  {
    id: 'E2025_KZ159',
    taxYear: 2025,
    kennziffer: '159',
    label: 'Summe Betriebseinnahmen',
    kind: 'computed',
    exportable: true,
    sortOrder: 3,
    computedFromIds: ['E2025_KZ112'],
    sourceVersion: 'BMF-2025-2025-08-29',
  },
  {
    id: 'E2025_KZ199',
    taxYear: 2025,
    kennziffer: '199',
    label: 'Summe Betriebsausgaben',
    kind: 'computed',
    exportable: true,
    sortOrder: 4,
    computedFromIds: ['E2025_KZ280', 'E2025_KZ183'],
    sourceVersion: 'BMF-2025-2025-08-29',
  },
] as const;

let mockClassificationMap = new Map<string, any>();

vi.mock('../db/eurCatalogRepo', () => ({
  listEurLines: vi.fn(() => mockLines),
}));

vi.mock('../db/eurClassificationRepo', () => ({
  listEurClassificationsMap: vi.fn(() => mockClassificationMap),
  upsertEurClassification: vi.fn(),
}));

import { getEurReport, listEurItems } from './eurReport';

const makeSettings = () => ({
  company: { name: '', owner: '', street: '', zip: '', city: '', email: '', phone: '', website: '' },
  catalog: { categories: [] },
  finance: { bankName: '', iban: '', bic: '', taxId: '', vatId: '', registerCourt: '' },
  numbers: {
    invoicePrefix: 'RE-%Y-',
    nextInvoiceNumber: 1,
    numberLength: 3,
    offerPrefix: 'ANG-%Y-',
    nextOfferNumber: 1,
    customerPrefix: 'KD-',
    nextCustomerNumber: 1,
    customerNumberLength: 4,
  },
  dunning: { levels: [] },
  legal: {
    smallBusinessRule: false,
    defaultVatRate: 19,
    taxAccountingMethod: 'soll',
    paymentTermsDays: 14,
    defaultIntroText: '',
    defaultFooterText: '',
  },
  portal: { baseUrl: '' },
  eInvoice: { enabled: false, standard: 'zugferd-en16931', profile: 'EN16931', version: '2.3' },
  email: {
    provider: 'none',
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: '',
    fromName: '',
    fromEmail: '',
  },
  automation: { dunningEnabled: false, dunningRunTime: '09:00', recurringEnabled: false, recurringRunTime: '03:00' },
});

const buildFakeDb = () => {
  const invoiceRows = [
    { invoice_id: 'inv-1', date: '2025-01-02', amount: 119, client: 'Acme', number: 'RE-1' },
  ];
  const txRows = [
    {
      id: 'tx-1',
      date: '2025-01-03',
      amount: -59.5,
      type: 'expense',
      account_id: 'acc-1',
      linked_invoice_id: null,
      counterparty: 'Hosting GmbH',
      purpose: 'Hosting Januar',
    },
    {
      id: 'tx-2',
      date: '2025-01-04',
      amount: -30,
      type: 'expense',
      account_id: 'acc-2',
      linked_invoice_id: null,
      counterparty: 'Bahn',
      purpose: 'Reisekosten',
    },
  ];

  return {
    prepare: (sql: string) => ({
      all: () => {
        if (sql.includes('FROM invoice_payments')) return invoiceRows;
        if (sql.includes('FROM transactions')) return txRows;
        return [];
      },
    }),
  } as any;
};

describe('eurReport integration (service boundary)', () => {
  beforeEach(() => {
    mockClassificationMap = new Map();
  });

  it('filters/paginates transaction items and returns suggestion fields', () => {
    const db = buildFakeDb();
    const settings = makeSettings() as any;

    const result = listEurItems(db, {
      taxYear: 2025,
      settings,
      sourceType: 'transaction',
      flowType: 'expense',
      status: 'unclassified',
      search: 'hosting',
      accountId: 'acc-1',
      limit: 10,
      offset: 0,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.sourceId).toBe('tx-1');
    expect(result[0]?.suggestedLineId).toBe('E2025_KZ280');
    expect(result[0]?.suggestionReason).toBeTruthy();
    expect(result[0]?.accountId).toBe('acc-1');
  });

  it('reflects classification changes in report totals', () => {
    const db = buildFakeDb();
    const settings = makeSettings() as any;

    let report = getEurReport(db, { taxYear: 2025, settings });
    expect(report.unclassifiedCount).toBeGreaterThan(0);

    mockClassificationMap = new Map([
      ['invoice:inv-1', {
        id: 'c1', sourceType: 'invoice', sourceId: 'inv-1', taxYear: 2025, eurLineId: 'E2025_KZ112', excluded: false, vatMode: 'default', updatedAt: '2025-01-01T00:00:00.000Z',
      }],
      ['transaction:tx-1', {
        id: 'c2', sourceType: 'transaction', sourceId: 'tx-1', taxYear: 2025, eurLineId: 'E2025_KZ280', excluded: false, vatMode: 'default', updatedAt: '2025-01-01T00:00:00.000Z',
      }],
      ['transaction:tx-2', {
        id: 'c3', sourceType: 'transaction', sourceId: 'tx-2', taxYear: 2025, excluded: true, vatMode: 'none', updatedAt: '2025-01-01T00:00:00.000Z',
      }],
    ]);

    report = getEurReport(db, { taxYear: 2025, settings });

    const income = report.rows.find((row) => row.lineId === 'E2025_KZ112');
    const expense = report.rows.find((row) => row.lineId === 'E2025_KZ280');

    expect(income?.total).toBe(100);
    expect(expense?.total).toBe(50);
    expect(report.unclassifiedCount).toBe(0);
  });
});
