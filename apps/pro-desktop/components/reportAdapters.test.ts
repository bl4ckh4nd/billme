import { describe, expect, it } from 'vitest';
import {
  mapBalanceSheetPreview,
  mapBwa01Report,
  mapGuvReport,
  mapHgbBilanzReport,
  mapHgbGuvReport,
  mapReportDrilldownEntries,
  mapSusaReport,
} from './reportAdapters';

const account = (accountNumber: string, name: string, chart: 'SKR03' | 'SKR04' = 'SKR03') => ({
  id: `${chart}-${accountNumber}`,
  chart,
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
        chart: 'SKR03',
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
      [account('8400', 'Erlöse 19 % USt'), account('8400', 'Falscher SKR04 Name', 'SKR04')],
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

  it('does not infer a mapped account as unmapped when its chart name is unavailable', () => {
    const report = mapSusaReport(
      {
        asOfDate: '2026-12-31',
        chart: 'SKR03',
        rows: [{
          accountNumber: '1200',
          openingBalance: 0,
          debitTurnover: 100,
          creditTurnover: 0,
          closingBalance: 100,
          mappedTo: 'bank',
          hasWarnings: false,
        }],
        totals: { debit: 100, credit: 0, balance: 100 },
      },
      [],
    );

    expect(report.rows[0]).toMatchObject({ mappedTo: 'bank', hasWarnings: false });
    expect(report.quality).toMatchObject({ unmappedAccounts: 0, warnings: 0 });
  });

  it('adds the GuV net result as a subtotal', () => {
    const report = mapGuvReport({
      rows: [{ positionKey: 'revenue', positionLabel: 'Umsatzerlöse', amount: 125, accountRefs: ['8400'] }],
      netResult: 75,
    });

    expect(report.lines[0]?.accountRefs).toEqual(['8400']);

    expect(report.lines.at(-1)).toMatchObject({
      id: 'net-result',
      amountCurrent: 75,
      isSubtotal: true,
    });
  });

  it('retains exact GuV unmapped account identities for UI resolution', () => {
    const report = mapGuvReport({
      rows: [],
      netResult: -12.5,
      blocking: true,
      unmappedAccounts: [{ accountNumber: '9999', amount: -12.5 }],
    });

    expect(report.quality.unmappedAccounts).toEqual([{ accountNumber: '9999', amount: -12.5 }]);
    expect(report.quality.warnings).toBe(1);
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
    expect(report.aktiva[0]?.accountRefs).toEqual(['0440']);
    expect(report.passiva[0]?.accountRefs).toEqual(['1600']);
  });

  it.each([
    {
      size: 'micro' as const,
      assets: [{ position: 'assets.current', label: 'B. Umlaufvermögen', amount: 100, accountNumbers: ['1200'], kind: 'heading' as const }],
      liabilities: [{ position: 'equity', label: 'A. Eigenkapital', amount: 100, accountNumbers: ['3000'], kind: 'heading' as const }],
    },
    {
      size: 'small' as const,
      assets: [
        { position: 'assets.current', label: 'B. Umlaufvermögen', amount: 100, accountNumbers: [], kind: 'heading' as const },
        { position: 'assets.current.cash', label: 'IV. Kassenbestand', amount: 100, accountNumbers: ['1200'], kind: 'line' as const, parentPosition: 'assets.current' },
      ],
      liabilities: [{ position: 'equity', label: 'A. Eigenkapital', amount: 100, accountNumbers: ['3000'], kind: 'heading' as const }],
    },
  ])('preserves $size HGB catalog positions, hierarchy and account refs', ({ assets, liabilities }) => {
    const report = mapHgbBilanzReport({
      kind: 'hgb-bilanz',
      assets,
      liabilities,
      totals: { assets: 100, liabilities: 100, delta: 0 },
      snapshot: { fiscalYear: 2026, fiscalYearStart: '01-01', businessSize: 'small', ledgerEntryCount: 1, ledgerAccountCount: 2, cashEntryCount: 0 },
      mappingHealth: { mappedAccounts: 2, inferredAccounts: 0, unmappedAccounts: [], warnings: [], blocking: false },
    }, [account('1200', 'Bank'), account('3000', 'Eigenkapital')]);
    expect([...report.aktiva, ...report.passiva].map((row) => row.position)).toEqual([...assets, ...liabilities].map((row) => row.position));
    if (assets.some((row) => row.position === 'assets.current.cash')) {
      expect(report.aktiva.find((row) => row.position === 'assets.current.cash')).toMatchObject({ level: 1, parentPosition: 'assets.current', accountRefs: ['1200'] });
    }
    expect(report.quality).toMatchObject({ mappingStatus: 'healthy', mappingNotes: [] });
  });

  it('preserves blocked HGB mapping health and unmapped identities', () => {
    const report = mapHgbBilanzReport({
      kind: 'hgb-bilanz', assets: [], liabilities: [], totals: { assets: 0, liabilities: 0, delta: 0 },
      snapshot: { fiscalYear: 2026, fiscalYearStart: '01-01', businessSize: 'small', ledgerEntryCount: 1, ledgerAccountCount: 1, cashEntryCount: 0 },
      mappingHealth: { mappedAccounts: 0, inferredAccounts: 0, unmappedAccounts: ['9999'], warnings: ['9999 fehlt im HGB-Bilanz-Mapping'], blocking: true },
    }, []);
    expect(report.quality).toMatchObject({ status: 'error', mappingStatus: 'blocked', mappingNotes: ['9999 fehlt im HGB-Bilanz-Mapping'], unmappedAccounts: [{ accountNumber: '9999', amount: 0 }] });
  });

  it('keeps report-specific engine rows and blocks incomplete mapping health', () => {
    const report = mapBwa01Report({
      kind: 'bwa01',
      rows: [{ position: 'revenue', label: 'Umsatzerlöse', amount: 100, accountNumbers: ['8400'] }],
      totals: { revenue: 100, expenses: 0, operatingResult: 100 },
      snapshot: {
        fiscalYear: 2026,
        fiscalYearStart: '01-01',
        businessSize: 'small',
        ledgerEntryCount: 1,
        ledgerAccountCount: 1,
        cashEntryCount: 0,
      },
      mappingHealth: {
        mappedAccounts: 1,
        inferredAccounts: 0,
        unmappedAccounts: ['9999'],
        warnings: ['9999 fehlt im BWA01-Katalog'],
        blocking: true,
      },
    });

    expect(report.lines[0]).toMatchObject({ id: 'revenue', accountRefs: ['8400'] });
    expect(report.quality).toMatchObject({
      mappingStatus: 'blocked',
      unmappedAccounts: [{ accountNumber: '9999', amount: 0 }],
      mappingNotes: ['9999 fehlt im BWA01-Katalog'],
    });

    const raw = mapHgbGuvReport({
      method: 'gkv',
      rows: [],
      netResult: 0,
    });
    expect(raw.quality).toMatchObject({ mappingStatus: 'blocked', warnings: 1 });
  });

  it('preserves OPOS source identity in drilldowns', () => {
    const entries = [
      {
        id: 'payment-entry', tenantId: 'default', entryNumber: 1, postingDate: '2026-03-01',
        bookingText: 'Kundenzahlung', period: '2026-03', fiscalYear: 2026, status: 'posted' as const,
        sourceType: 'payment' as const, sourceKey: 'payment:bank_transaction:bank-42', createdAt: '2026-03-01T00:00:00.000Z',
        lines: [{ id: 'payment-line', accountNumber: '1200', debitAmount: 100, creditAmount: 0 }],
      },
      {
        id: 'incoming-entry', tenantId: 'default', entryNumber: 2, postingDate: '2026-03-02',
        bookingText: 'Eingangsrechnung', period: '2026-03', fiscalYear: 2026, status: 'posted' as const,
        sourceType: 'incoming_invoice' as const, sourceKey: 'incoming-invoice:invoice-7', createdAt: '2026-03-02T00:00:00.000Z',
        lines: [{ id: 'incoming-line', accountNumber: '4900', debitAmount: 50, creditAmount: 0 }],
      },
      {
        id: 'outgoing-entry', tenantId: 'default', entryNumber: 3, postingDate: '2026-03-03',
        bookingText: 'Ausgangsrechnung', period: '2026-03', fiscalYear: 2026, status: 'posted' as const,
        sourceType: 'outgoing_invoice' as const, sourceKey: 'outgoing-invoice:invoice-8', createdAt: '2026-03-03T00:00:00.000Z',
        lines: [{ id: 'outgoing-line', accountNumber: '8400', debitAmount: 0, creditAmount: 100 }],
      },
      {
        id: 'payment-vat-entry', tenantId: 'default', entryNumber: 4, postingDate: '2026-03-04',
        bookingText: 'USt Vereinnahmung', period: '2026-03', fiscalYear: 2026, status: 'posted' as const,
        sourceType: 'payment_vat' as const, sourceKey: 'payment-vat:payment-9:allocation-1', createdAt: '2026-03-04T00:00:00.000Z',
        lines: [{ id: 'payment-vat-line', accountNumber: '1776', debitAmount: 0, creditAmount: 19 }],
      },
    ];
    const result = mapReportDrilldownEntries(entries, {
      reportType: 'susa', targetId: '1200', targetLabel: 'Bank', accountNumbers: ['1200', '4900', '8400', '1776'],
    }, { from: '2026-03-02', to: '2026-03-04' });
    expect(result.map((entry) => entry.source)).toEqual(['Inbox', 'Abgleich', 'Abgleich']);
    expect(result.map((entry) => entry.sourceType)).toEqual(['incoming_invoice', 'invoice', 'payment']);
    expect(result.map((entry) => entry.sourceId)).toEqual(['invoice-7', 'invoice-8', 'payment-9']);
    expect(result.map((entry) => entry.journalEntryId)).toEqual(['incoming-entry', 'outgoing-entry', 'payment-vat-entry']);
    expect(result.every((entry) => entry.transactionId === undefined)).toBe(true);

    const bank = mapReportDrilldownEntries(entries, {
      reportType: 'susa', targetId: '1200', targetLabel: 'Bank', accountNumbers: ['1200'],
    });
    expect(bank[0]).toMatchObject({
      journalEntryId: 'payment-entry',
      sourceType: 'bank_transaction',
      sourceId: 'bank-42',
      transactionId: 'bank-42',
    });
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
