import type Database from 'better-sqlite3';
import { listEurClassificationsMap, type EurClassification, type EurSourceType, upsertEurClassification } from '../db/eurClassificationRepo';
import { listEurLines, type EurLine } from '../db/eurCatalogRepo';
import type { AppSettings } from '../types';
import { suggestEurLine } from './eurSuggestion';

export interface EurReportParams {
  taxYear: number;
  from?: string;
  to?: string;
  settings: AppSettings;
}

export interface EurReportRow {
  lineId: string;
  kennziffer?: string;
  label: string;
  kind: 'income' | 'expense' | 'computed';
  exportable: boolean;
  total: number;
  sortOrder: number;
}

export interface EurReportResult {
  taxYear: number;
  from: string;
  to: string;
  rows: EurReportRow[];
  summary: {
    incomeTotal: number;
    expenseTotal: number;
    surplus: number;
  };
  unclassifiedCount: number;
  warnings: string[];
}

export interface EurListItem {
  sourceType: EurSourceType;
  sourceId: string;
  date: string;
  amountGross: number;
  amountNet: number;
  flowType: 'income' | 'expense';
  accountId?: string;
  linkedViaInvoice?: boolean;
  counterparty: string;
  purpose: string;
  suggestedLineId?: string;
  suggestionReason?: string;
  classification?: EurClassification;
  line?: EurLine;
}

export interface EurListItemsParams {
  taxYear: number;
  from?: string;
  to?: string;
  settings: AppSettings;
  onlyUnclassified?: boolean;
  sourceType?: EurSourceType;
  flowType?: 'income' | 'expense';
  status?: 'all' | 'unclassified' | 'classified' | 'excluded';
  search?: string;
  accountId?: string;
  limit?: number;
  offset?: number;
}

const fallbackDateRange = (taxYear: number, from?: string, to?: string): { from: string; to: string } => ({
  from: from ?? `${taxYear}-01-01`,
  to: to ?? `${taxYear}-12-31`,
});

export const listEurItems = (db: Database.Database, params: EurListItemsParams): EurListItem[] => {
  const { from, to } = fallbackDateRange(params.taxYear, params.from, params.to);
  const lines = listEurLines(db, params.taxYear);
  const linesById = new Map(lines.map((line) => [line.id, line]));
  const classifications = listEurClassificationsMap(db, params.taxYear);
  const rawItems = listRawEurItems(db, from, to);

  let items = rawItems.map((item) => {
    const classification = classifications.get(`${item.sourceType}:${item.sourceId}`);
    const line = classification?.eurLineId ? linesById.get(classification.eurLineId) : undefined;
    const suggestion = suggestEurLine(
      {
        flowType: item.flowType,
        counterparty: item.counterparty,
        purpose: item.purpose,
      },
      lines,
    );
    return {
      ...item,
      amountNet: toNet(item.amountGross, classification, params.settings),
      suggestedLineId: suggestion.lineId,
      suggestionReason: suggestion.reason,
      classification,
      line,
    } as EurListItem;
  });

  if (params.sourceType) {
    items = items.filter((item) => item.sourceType === params.sourceType);
  }

  if (params.flowType) {
    items = items.filter((item) => item.flowType === params.flowType);
  }

  if (params.accountId) {
    items = items.filter((item) => item.accountId === params.accountId);
  }

  const status = params.onlyUnclassified ? 'unclassified' : params.status;
  if (status && status !== 'all') {
    items = items.filter((item) => {
      if (status === 'unclassified') return !item.classification?.eurLineId && !item.classification?.excluded;
      if (status === 'classified') return Boolean(item.classification?.eurLineId) && !item.classification?.excluded;
      return Boolean(item.classification?.excluded);
    });
  }

  if (params.search && params.search.trim().length > 0) {
    const needle = params.search.trim().toLowerCase();
    items = items.filter((item) =>
      item.counterparty.toLowerCase().includes(needle)
      || item.purpose.toLowerCase().includes(needle)
      || item.date.includes(needle)
      || String(item.amountGross).includes(needle),
    );
  }

  const offset = Math.max(0, params.offset ?? 0);
  if (params.limit && params.limit > 0) {
    items = items.slice(offset, offset + params.limit);
  } else if (offset > 0) {
    items = items.slice(offset);
  }

  if (params.onlyUnclassified) {
    return items.filter((item) => !item.classification?.eurLineId && !item.classification?.excluded);
  }

  return items;
};

export const getEurReport = (db: Database.Database, params: EurReportParams): EurReportResult => {
  const { from, to } = fallbackDateRange(params.taxYear, params.from, params.to);
  const lines = listEurLines(db, params.taxYear);
  const linesById = new Map(lines.map((line) => [line.id, line]));
  const totals = new Map<string, number>();
  const warnings: string[] = [];
  let unclassifiedCount = 0;

  for (const line of lines) {
    totals.set(line.id, 0);
  }

  const items = listEurItems(db, {
    taxYear: params.taxYear,
    from,
    to,
    settings: params.settings,
  });

  for (const item of items) {
    const cls = item.classification;
    if (cls?.excluded) continue;
    if (!cls?.eurLineId) {
      unclassifiedCount += 1;
      continue;
    }

    const line = linesById.get(cls.eurLineId);
    if (!line) {
      warnings.push(`Unknown EÜR line for ${item.sourceType}:${item.sourceId}: ${cls.eurLineId}`);
      unclassifiedCount += 1;
      continue;
    }

    if (line.kind === 'computed') {
      warnings.push(`Computed line cannot be used for classification: ${line.id}`);
      unclassifiedCount += 1;
      continue;
    }

    if (line.kind !== item.flowType) {
      warnings.push(`Flow mismatch for ${item.sourceType}:${item.sourceId}: line ${line.id} is ${line.kind}`);
      unclassifiedCount += 1;
      continue;
    }

    totals.set(line.id, round2((totals.get(line.id) ?? 0) + item.amountNet));
  }

  const computedMemo = new Map<string, number>();
  const resolveTotal = (lineId: string): number => {
    if (computedMemo.has(lineId)) return computedMemo.get(lineId)!;
    const line = linesById.get(lineId);
    if (!line) return 0;
    if (line.kind !== 'computed') {
      const direct = totals.get(lineId) ?? 0;
      computedMemo.set(lineId, direct);
      return direct;
    }

    const value = round2((line.computedFromIds ?? []).reduce((sum, childId) => sum + resolveTotal(childId), 0));
    computedMemo.set(lineId, value);
    totals.set(lineId, value);
    return value;
  };

  for (const line of lines) {
    resolveTotal(line.id);
  }

  const rows: EurReportRow[] = lines.map((line) => ({
    lineId: line.id,
    kennziffer: line.kennziffer,
    label: line.label,
    kind: line.kind,
    exportable: line.exportable,
    total: round2(totals.get(line.id) ?? 0),
    sortOrder: line.sortOrder,
  }));

  const incomeTotal = round2(rows.filter((row) => row.kind === 'income').reduce((sum, row) => sum + row.total, 0));
  const expenseTotal = round2(rows.filter((row) => row.kind === 'expense').reduce((sum, row) => sum + row.total, 0));

  return {
    taxYear: params.taxYear,
    from,
    to,
    rows,
    summary: {
      incomeTotal,
      expenseTotal,
      surplus: round2(incomeTotal - expenseTotal),
    },
    unclassifiedCount,
    warnings,
  };
};

export const upsertEurItemClassification = (
  db: Database.Database,
  input: {
    sourceType: EurSourceType;
    sourceId: string;
    taxYear: number;
    eurLineId?: string;
    excluded?: boolean;
    vatMode?: 'none' | 'default';
    note?: string;
  },
): EurClassification => {
  return upsertEurClassification(db, input);
};

export const buildEurCsv = (report: EurReportResult): string => {
  const header = ['Kennziffer', 'Bezeichnung', 'Betrag'].join(';');
  const rows = report.rows
    .filter((row) => row.exportable)
    .map((row) => [row.kennziffer ?? '', escapeCsv(row.label), formatDe(row.total)].join(';'));
  return `\uFEFF${[header, ...rows].join('\n')}`;
};

const escapeCsv = (value: string): string => {
  if (value.includes(';') || value.includes('"') || value.includes('\n')) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
};

const formatDe = (amount: number): string => round2(amount).toFixed(2).replace('.', ',');

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const toNet = (
  amountGross: number,
  classification: EurClassification | undefined,
  settings: AppSettings,
): number => {
  if (settings.legal.smallBusinessRule) return round2(amountGross);
  if ((classification?.vatMode ?? 'none') !== 'default') return round2(amountGross);
  const rate = Number(settings.legal.defaultVatRate) || 0;
  if (rate <= 0) return round2(amountGross);
  return round2(amountGross / (1 + rate / 100));
};

const listRawEurItems = (
  db: Database.Database,
  from: string,
  to: string,
): Array<{
  sourceType: EurSourceType;
  sourceId: string;
  date: string;
  amountGross: number;
  flowType: 'income' | 'expense';
  accountId?: string;
  linkedViaInvoice?: boolean;
  counterparty: string;
  purpose: string;
}> => {
  const invoicePayments = db
    .prepare(
      `
      SELECT ip.invoice_id, ip.date, ip.amount, i.client, i.number
      FROM invoice_payments ip
      INNER JOIN invoices i ON i.id = ip.invoice_id
      WHERE ip.date >= ? AND ip.date <= ?
    `,
    )
    .all(from, to) as Array<{
    invoice_id: string;
    date: string;
    amount: number;
    client: string;
    number: string;
  }>;

  const transactions = db
    .prepare(
      `
      SELECT id, date, amount, type, counterparty, purpose
           , account_id, linked_invoice_id
      FROM transactions
      WHERE status = 'booked'
        AND date >= ?
        AND date <= ?
        AND (deleted_at IS NULL OR deleted_at = '')
        AND (
          type = 'expense'
          OR (
            type = 'income'
            AND (linked_invoice_id IS NULL OR linked_invoice_id = '')
          )
        )
    `,
    )
    .all(from, to) as Array<{
    id: string;
    date: string;
    amount: number;
    type: 'income' | 'expense';
    account_id: string;
    linked_invoice_id: string | null;
    counterparty: string;
    purpose: string;
  }>;

  const result: Array<{
    sourceType: EurSourceType;
    sourceId: string;
    date: string;
    amountGross: number;
    flowType: 'income' | 'expense';
    accountId?: string;
    linkedViaInvoice?: boolean;
    counterparty: string;
    purpose: string;
  }> = [];

  for (const row of invoicePayments) {
    result.push({
      sourceType: 'invoice',
      sourceId: row.invoice_id,
      date: row.date,
      amountGross: Math.abs(Number(row.amount) || 0),
      flowType: 'income',
      linkedViaInvoice: false,
      counterparty: row.client,
      purpose: `Rechnung ${row.number}`,
    });
  }

  for (const row of transactions) {
    result.push({
      sourceType: 'transaction',
      sourceId: row.id,
      date: row.date,
      amountGross: Math.abs(Number(row.amount) || 0),
      flowType: row.type,
      accountId: row.account_id ?? undefined,
      linkedViaInvoice: Boolean(row.linked_invoice_id),
      counterparty: row.counterparty,
      purpose: row.purpose,
    });
  }

  result.sort((a, b) => {
    if (a.date === b.date) return a.sourceId.localeCompare(b.sourceId);
    return a.date > b.date ? -1 : 1;
  });

  return result;
};
