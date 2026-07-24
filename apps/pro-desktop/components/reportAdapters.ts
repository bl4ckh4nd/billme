import type {
  BalanceSheetPreview,
  GuvReport,
  ReportDrilldownEntry,
  ReportDrilldownSelection,
  SusaReport,
} from '@billme/accounting-ui-pro';
import type { IpcResult } from '../ipc/contract';

type LedgerAccount = IpcResult<'pro:listLedgerAccounts'>[number];

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const accountNameMap = (accounts: LedgerAccount[]): Map<string, string> =>
  new Map(accounts.map((account) => [account.accountNumber, account.name]));

const isCreditNormal = (accountNumber: string): boolean =>
  ['2', '3', '8', '9'].includes(accountNumber[0] ?? '');

export const mapSusaReport = (
  report: IpcResult<'pro:getSusaReport'>,
  accounts: LedgerAccount[],
): SusaReport => {
  const names = accountNameMap(accounts);
  const rows = report.rows.map((row) => ({
    ...row,
    accountName: names.get(row.accountNumber) ?? `Konto ${row.accountNumber}`,
    normalBalance: isCreditNormal(row.accountNumber) ? 'credit' as const : 'debit' as const,
  }));

  return {
    rows,
    totals: rows.reduce<SusaReport['totals']>(
      (totals, row) => {
        totals.openingDebit += Math.max(row.openingBalance, 0);
        totals.openingCredit += Math.max(-row.openingBalance, 0);
        totals.turnoverDebit += row.debitTurnover;
        totals.turnoverCredit += row.creditTurnover;
        totals.closingDebit += Math.max(row.closingBalance, 0);
        totals.closingCredit += Math.max(-row.closingBalance, 0);
        return totals;
      },
      {
        openingDebit: 0,
        openingCredit: 0,
        turnoverDebit: 0,
        turnoverCredit: 0,
        closingDebit: 0,
        closingCredit: 0,
      },
    ),
    quality: {
      unmappedAccounts: rows.filter((row) => !names.has(row.accountNumber)).length,
      warnings: 0,
      generatedAt: new Date().toISOString(),
      source: 'live',
    },
  };
};

export const mapGuvReport = (report: IpcResult<'pro:getGuvReport'>): GuvReport => {
  const revenue = report.rows.filter((row) => row.amount > 0).reduce((sum, row) => sum + row.amount, 0);
  const expenses = Math.abs(
    report.rows.filter((row) => row.amount < 0).reduce((sum, row) => sum + row.amount, 0),
  );
  return {
    lines: [
      ...report.rows.map((row) => ({
        id: row.positionKey,
        code: row.positionKey,
        label: row.positionLabel,
        level: 0,
        amountCurrent: row.amount,
      })),
      {
        id: 'net-result',
        code: '=',
        label: 'Jahresergebnis',
        level: 0,
        amountCurrent: report.netResult,
        isSubtotal: true,
      },
    ],
    totals: { revenue: round2(revenue), expenses: round2(expenses), result: report.netResult },
    quality: {
      unmappedAccounts: 0,
      warnings: 0,
      generatedAt: new Date().toISOString(),
      source: 'live',
    },
  };
};

export const mapBalanceSheetPreview = (
  report: IpcResult<'pro:getBilanzReport'>,
  accounts: LedgerAccount[],
): BalanceSheetPreview => {
  const names = accountNameMap(accounts);
  const mapLines = (
    rows: Array<{ accountNumber: string; amount: number }>,
    side: 'aktiva' | 'passiva',
  ) => rows.map((row) => ({
    id: `${side}-${row.accountNumber}`,
    code: row.accountNumber,
    label: names.get(row.accountNumber) ?? `Konto ${row.accountNumber}`,
    amount: row.amount,
    level: 0,
    side,
  }));

  const missingNames = [...report.assets, ...report.liabilities]
    .filter((row) => !names.has(row.accountNumber))
    .map((row) => row.accountNumber);
  return {
    aktiva: mapLines(report.assets, 'aktiva'),
    passiva: mapLines(report.liabilities, 'passiva'),
    totals: {
      aktiva: report.totals.assets,
      passiva: report.totals.liabilities,
      difference: report.totals.delta,
    },
    quality: {
      status: missingNames.length ? 'warning' : report.totals.delta === 0 ? 'ok' : 'warning',
      notes: missingNames.length ? [`Fehlende Kontonamen: ${missingNames.join(', ')}`] : [],
      generatedAt: new Date().toISOString(),
      source: 'live',
    },
  };
};

export const mapReportDrilldownEntries = (
  entries: IpcResult<'pro:listJournalEntries'>,
  selection: ReportDrilldownSelection,
): ReportDrilldownEntry[] => {
  const accounts = new Set(selection.accountNumbers);
  if (!accounts.size) return [];

  return entries.flatMap((entry) =>
    entry.lines
      .filter((line) => accounts.has(line.accountNumber))
      .map((line) => ({
        id: line.id,
        date: entry.postingDate,
        bookingText: entry.bookingText,
        reference: entry.reference,
        accountNumber: line.accountNumber,
        debit: line.debitAmount,
        credit: line.creditAmount,
        amount: round2(line.debitAmount - line.creditAmount),
        source: /afa|abschreibung/i.test(entry.bookingText)
          ? 'AfA' as const
          : entry.sourceDraftId
            ? 'Inbox' as const
            : 'Manuell' as const,
      })),
  );
};
