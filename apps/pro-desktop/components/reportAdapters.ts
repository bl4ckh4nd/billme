import type {
  BalanceSheetPreview,
  GuvReport,
  ReportDrilldownEntry,
  ReportDrilldownSource,
  ReportDrilldownSourceType,
  ReportDrilldownSelection,
  SusaReport,
} from '@billme/accounting-ui-pro';
import type {
  Bwa01Report,
  HgbGuvReport,
  ManagementGuvReport,
  ReportResult,
} from '@billme/accounting-shared';
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

/**
 * The reporting engine emits neutral position lines.  Keep the renderer
 * contract deliberately boring: all report flavours use the same line view,
 * while the engine remains the source of the amounts and account references.
 */
type EngineReport =
  | ReportResult<Bwa01Report>
  | ReportResult<ManagementGuvReport>
  | ReportResult<HgbGuvReport>;

type EngineReportPayload =
  | Bwa01Report
  | ManagementGuvReport
  | HgbGuvReport;

export const mapEngineReport = (report: EngineReport | EngineReportPayload): GuvReport => {
  const mappingHealth = 'mappingHealth' in report
    ? report.mappingHealth
    : {
      // A raw payload has no trustworthy completeness metadata. Never present
      // it as a healthy live report; callers must use the engine envelope.
      mappedAccounts: 0,
      inferredAccounts: 0,
      unmappedAccounts: [],
      warnings: ['REPORT_MAPPING_HEALTH_UNAVAILABLE'],
      blocking: true,
    };
  const rows = report.rows.map((row) => ({
    id: row.position,
    code: row.position,
    label: row.label,
    level: 0,
    amountCurrent: row.amount,
    accountRefs: row.accountNumbers,
  }));
  const totals = 'totals' in report && 'revenue' in report.totals
    ? {
      revenue: report.totals.revenue,
      expenses: report.totals.expenses,
      result: report.totals.operatingResult,
    }
    : {
      revenue: rows.filter((row) => row.amountCurrent > 0).reduce((sum, row) => sum + row.amountCurrent, 0),
      expenses: Math.abs(rows.filter((row) => row.amountCurrent < 0).reduce((sum, row) => sum + row.amountCurrent, 0)),
      result: 'netResult' in report ? report.netResult : rows.reduce((sum, row) => sum + row.amountCurrent, 0),
    };
  const result = 'netResult' in report ? report.netResult : totals.result;
  return {
    lines: [
      ...rows,
      {
        id: 'net-result',
        code: '=',
        label: 'Jahresergebnis',
        level: 0,
        amountCurrent: result,
        isSubtotal: true,
      },
    ],
    totals: { ...totals, result },
    quality: {
      unmappedAccounts: mappingHealth.unmappedAccounts.map((accountNumber) => ({ accountNumber, amount: 0 })),
      warnings: mappingHealth.warnings.length,
      generatedAt: new Date().toISOString(),
      source: 'live',
      mappingStatus: mappingHealth.blocking ? 'blocked' : mappingHealth.warnings.length ? 'warning' : 'healthy',
      mappingNotes: mappingHealth.warnings,
    },
  };
};

export const mapBwa01Report = mapEngineReport;
export const mapManagementGuvReport = mapEngineReport;
export const mapHgbGuvReport = mapEngineReport;

export const mapEurReport = (report: IpcResult<'eur:getReport'>): GuvReport => {
  const lines = report.rows.map((row) => ({
    id: row.lineId,
    code: row.kennziffer ?? row.lineId,
    label: row.label,
    level: 0,
    amountCurrent: row.kind === 'expense' ? -Math.abs(row.total) : row.total,
    isSubtotal: row.kind === 'computed',
  }));
  return {
    lines,
    totals: {
      revenue: report.summary.incomeTotal,
      expenses: report.summary.expenseTotal,
      result: report.summary.surplus,
    },
    quality: {
      unmappedAccounts: [],
      warnings: report.warnings.length + report.unclassifiedCount,
      generatedAt: new Date().toISOString(),
      source: 'live',
      mappingStatus: report.unclassifiedCount > 0 ? 'blocked' : 'healthy',
      mappingNotes: report.warnings,
    },
    filing: {
      kind: 'euer',
      taxYear: report.taxYear,
      catalog: report.catalog,
      lineProvenance: report.rows.map((row) => ({ lineId: row.lineId, kennziffer: row.kennziffer, providerPath: row.providerPath, exportable: row.exportable })),
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
    // Keep account references from the authoritative report rows. The UI can
    // drill down without reconstructing mappings from account prefixes.
    accountRefs: (row as typeof row & { accountRefs?: string[] }).accountRefs ?? [row.accountNumber],
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
    return { sourceType: 'incoming_invoice', sourceId: key.slice('incoming-invoice:'.length) };
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
