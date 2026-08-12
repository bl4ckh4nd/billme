import type {
  BalanceSheetPreview,
  GuvReport,
  ReportDrilldownEntry,
  ReportDrilldownSource,
  ReportDrilldownSourceType,
  ReportDrilldownSelection,
  SusaReport,
} from '@billme/accounting-ui-pro';
import type { IpcResult } from '../ipc/contract';

type LedgerAccount = IpcResult<'pro:listLedgerAccounts'>[number];

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const accountNameMap = (accounts: LedgerAccount[], chart?: 'SKR03' | 'SKR04'): Map<string, string> =>
  new Map(accounts.filter((account) => !chart || account.chart === chart).map((account) => [account.accountNumber, account.name]));

const isCreditNormal = (accountNumber: string): boolean =>
  ['2', '3', '8', '9'].includes(accountNumber[0] ?? '');

export const mapSusaReport = (
  report: IpcResult<'pro:getSusaReport'>,
  accounts: LedgerAccount[],
): SusaReport => {
  const names = accountNameMap(accounts, report.chart);
  const rows = report.rows.map((row) => ({
    ...row,
    accountName: names.get(row.accountNumber) ?? `Konto ${row.accountNumber}`,
    normalBalance: isCreditNormal(row.accountNumber) ? 'credit' as const : 'debit' as const,
  }));
  const unmappedAccounts = report.unmappedAccounts;
  const hasMappingMetadata = report.rows.some((row) => row.mappedTo !== undefined || row.hasWarnings !== undefined);

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
      unmappedAccounts: unmappedAccounts?.length ?? (hasMappingMetadata ? rows.filter((row) => !row.mappedTo).length : rows.filter((row) => !names.has(row.accountNumber)).length),
      warnings: report.blocking ? unmappedAccounts?.length ?? rows.filter((row) => row.hasWarnings).length : 0,
      generatedAt: new Date().toISOString(),
      source: 'live',
    },
  };
};

export const mapGuvReport = (report: IpcResult<'pro:getGuvReport'>): GuvReport => {
  const revenue = report.rows
    .filter((row) => row.positionKey === 'revenue')
    .reduce((sum, row) => sum + row.amount, 0);
  const expenses = Math.abs(report.rows
    .filter((row) => row.positionKey === 'expense')
    .reduce((sum, row) => sum + row.amount, 0));
  const unmappedAccounts = report.unmappedAccounts ?? [];
  return {
    lines: [
      ...report.rows.map((row) => ({
        id: row.positionKey,
        code: row.positionKey,
        label: row.positionLabel,
        level: 0,
        amountCurrent: row.amount,
        accountRefs: row.accountRefs,
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
      unmappedAccounts,
      warnings: report.blocking ? unmappedAccounts.length : 0,
      generatedAt: new Date().toISOString(),
      source: 'live',
    },
  };
};

export const mapBalanceSheetPreview = (
  report: IpcResult<'pro:getBilanzReport'>,
  accounts: LedgerAccount[],
): BalanceSheetPreview => {
  const names = accountNameMap(accounts, report.chart);
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
      status: report.blocking || missingNames.length ? 'warning' : report.totals.delta === 0 ? 'ok' : 'warning',
      notes: [
        ...(report.unmappedAccounts?.length ? report.unmappedAccounts.map((row) => `Nicht zugeordnet: ${row.accountNumber} (${row.amount.toFixed(2)} EUR)`) : []),
        ...(missingNames.length ? [`Fehlende Kontonamen: ${missingNames.join(', ')}`] : []),
      ],
      generatedAt: new Date().toISOString(),
      source: 'live',
    },
  };
};

type AuditableReportDrilldownEntry = ReportDrilldownEntry & ReportDrilldownSource & {
  journalEntryId: string;
};

const reportSourceFromEntry = (
  entry: IpcResult<'pro:listJournalEntries'>[number],
): ReportDrilldownSource & { transactionId?: string } => {
  const key = entry.sourceKey;
  if (entry.sourceType === 'outgoing_invoice' && key?.startsWith('outgoing-invoice:') && key.length > 'outgoing-invoice:'.length) {
    return { sourceType: 'invoice', sourceId: key.slice('outgoing-invoice:'.length) };
  }
  if (entry.sourceType === 'incoming_invoice' && key?.startsWith('incoming-invoice:') && key.length > 'incoming-invoice:'.length) {
    return { sourceType: 'receipt', sourceId: key.slice('incoming-invoice:'.length) };
  }
  if (entry.sourceType === 'payment') {
    const match = key?.match(/^payment:([^:]+):(.+)$/);
    if (!match) return { sourceType: 'journal_entry', sourceId: entry.id };
    const sourceId = match[2];
    if (match?.[1] === 'bank_transaction') {
      // The desktop shell has a transaction handler; never pass invoice or
      // journal source identifiers through this legacy callback.
      return { sourceType: 'bank_transaction', sourceId, transactionId: sourceId };
    }
    return { sourceType: 'payment', sourceId };
  }
  if (entry.sourceType === 'payment_vat' && key?.startsWith('payment-vat:')) {
    return { sourceType: 'payment', sourceId: key.slice('payment-vat:'.length).split(':')[0] || entry.id };
  }
  return {
    sourceType: 'journal_entry',
    sourceId: entry.id,
  };
};

const sourceLabel = (entry: IpcResult<'pro:listJournalEntries'>[number]): ReportDrilldownEntry['source'] =>
  /afa|abschreibung/i.test(entry.bookingText) || entry.sourceType === 'depreciation'
    ? 'AfA'
    : entry.sourceType === 'payment' || entry.sourceType === 'payment_vat'
      ? 'Abgleich'
      : entry.sourceType === 'incoming_invoice' || entry.sourceType === 'booking_draft' || entry.sourceDraftId
        ? 'Inbox'
        : entry.sourceType === 'outgoing_invoice'
          ? 'Abgleich'
          : 'Manuell';

export const mapReportDrilldownEntries = (
  entries: IpcResult<'pro:listJournalEntries'>,
  selection: ReportDrilldownSelection,
  range: { from?: string; to?: string } = {},
): AuditableReportDrilldownEntry[] => {
  const accounts = new Set(selection.accountNumbers);
  if (!accounts.size) return [];

  return entries
    .filter((entry) => (!range.from || entry.postingDate >= range.from) && (!range.to || entry.postingDate <= range.to))
    .flatMap((entry) =>
      entry.lines
        .filter((line) => accounts.has(line.accountNumber))
        .map((line) => {
          const source = reportSourceFromEntry(entry);
          return {
            id: `${entry.id}:${line.id}`,
            date: entry.postingDate,
            bookingText: entry.bookingText,
            reference: entry.reference,
            journalEntryId: entry.id,
            sourceType: source.sourceType,
            sourceId: source.sourceId,
            ...(source.transactionId ? { transactionId: source.transactionId } : {}),
            accountNumber: line.accountNumber,
            debit: line.debitAmount,
            credit: line.creditAmount,
            amount: round2(line.debitAmount - line.creditAmount),
            source: sourceLabel(entry),
          };
        }),
    );
};
