import { describe, expect, it } from 'vitest';
import {
  mapBalanceSheetPreview,
  mapGuvReport,
  mapReportDrilldownEntries,
  mapSusaReport,
} from './reportAdapters';

const account = (accountNumber: string, name: string) => ({
  id: accountNumber,
  chart: 'SKR03' as const,
  accountNumber,
  name,
  source: 'test',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('reportAdapters', () => {
  it('maps missing names and credit-normal SuSa accounts', () => {
    const report = mapSusaReport(
      {
        asOfDate: '2026-12-31',
        rows: [
          {
            accountNumber: '8400',
            openingBalance: -20,
            debitTurnover: 10,
            creditTurnover: 100,
            closingBalance: -110,
          },
          {
            accountNumber: '9999',
            openingBalance: 0,
            debitTurnover: 0,
            creditTurnover: 0,
            closingBalance: 0,
          },
        ],
        totals: { debit: 10, credit: 100, balance: -110 },
      },
      [account('8400', 'Erlöse 19 % USt')],
    );

    expect(report.rows[0]).toMatchObject({
      accountName: 'Erlöse 19 % USt',
      normalBalance: 'credit',
    });
    expect(report.rows[1].accountName).toBe('Konto 9999');
    expect(report.quality).toMatchObject({ source: 'live', unmappedAccounts: 1 });
    expect(report.totals).toMatchObject({
      openingCredit: 20,
      turnoverDebit: 10,
      turnoverCredit: 100,
      closingCredit: 110,
    });
  });

  it('adds the GuV net result as a subtotal', () => {
    const report = mapGuvReport({
      rows: [{ positionKey: 'revenue', positionLabel: 'Umsatzerlöse', amount: 125 }],
      netResult: 75,
    });

    expect(report.lines.at(-1)).toMatchObject({
      id: 'net-result',
      amountCurrent: 75,
      isSubtotal: true,
    });
  });

  it('maps Bilanz delta to difference and resolves account names', () => {
    const report = mapBalanceSheetPreview(
      {
        asOfDate: '2026-12-31',
        assets: [{ accountNumber: '0440', amount: 500 }],
        liabilities: [{ accountNumber: '1600', amount: 450 }],
        totals: { assets: 500, liabilities: 450, delta: 50 },
      },
      [account('0440', 'Maschinen'), account('1600', 'Verbindlichkeiten')],
    );

    expect(report.aktiva[0]).toMatchObject({ label: 'Maschinen', side: 'aktiva' });
    expect(report.passiva[0]).toMatchObject({ label: 'Verbindlichkeiten', side: 'passiva' });
    expect(report.totals.difference).toBe(50);
  });

  it('maps empty report and drilldown results', () => {
    expect(
      mapSusaReport(
        { asOfDate: '2026-12-31', rows: [], totals: { debit: 0, credit: 0, balance: 0 } },
        [],
      ).rows,
    ).toEqual([]);
    expect(mapGuvReport({ rows: [], netResult: 0 }).lines).toHaveLength(1);
    expect(
      mapBalanceSheetPreview(
        {
          asOfDate: '2026-12-31',
          assets: [],
          liabilities: [],
          totals: { assets: 0, liabilities: 0, delta: 0 },
        },
        [],
      ),
    ).toMatchObject({ aktiva: [], passiva: [] });
    expect(
      mapReportDrilldownEntries([], {
        reportType: 'susa',
        targetId: '1200',
        targetLabel: 'Bank',
        accountNumbers: ['1200'],
      }),
    ).toEqual([]);
  });
});
