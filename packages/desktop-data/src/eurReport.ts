import type Database from 'better-sqlite3';
import { and, asc, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { listEurClassificationsMap, type EurClassification, type EurSourceType, upsertEurClassification } from './eurClassificationRepo';
import { listEurLines, type EurLine } from './eurCatalogRepo';
import type { AppSettings } from '@billme/desktop-core/types';
import { buildPipelineContext, classifyItem, type SuggestionLayer } from './eurClassificationPipeline';
import { createDrizzle, schema } from './drizzle';

export interface EurReportParams {
  taxYear: number;
  from?: string;
  to?: string;
  settings: AppSettings;
  product?: 'lite' | 'pro';
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
  suggestionLayer?: SuggestionLayer;
  classification?: EurClassification;
  line?: EurLine;
  vatWarning?: string;
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
  product?: 'lite' | 'pro';
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
  const rawItems = listRawEurItems(db, from, to, params.product ?? 'lite');
  const pipelineCtx = buildPipelineContext(db, params.taxYear, lines);

  let items = rawItems.map((item) => {
    const classification = classifications.get(`${item.sourceType}:${item.sourceId}`)
      ?? (item.classificationFallbackId ? classifications.get(`invoice:${item.classificationFallbackId}`) : undefined);
    const { sourceNet: _sourceNet, classificationFallbackId: _classificationFallbackId, ...publicItem } = item;
    const line = classification?.eurLineId ? linesById.get(classification.eurLineId) : undefined;
    const suggestion = classifyItem(pipelineCtx, {
      flowType: item.flowType,
      counterparty: item.counterparty,
      purpose: item.purpose,
    });
    return {
      ...publicItem,
      ...toNet(item.amountGross, classification, params.settings, item, params.product ?? 'lite'),
      suggestedLineId: suggestion.lineId,
      suggestionReason: suggestion.reason,
      suggestionLayer: suggestion.layer,
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
    product: params.product,
  });

  for (const item of items) {
    if (item.vatWarning) warnings.push(item.vatWarning);
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
    vatRate?: number;
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
  raw: { sourceId: string; sourceNet?: number },
  product: 'lite' | 'pro',
): { amountNet: number; vatWarning?: string } => {
  if (raw.sourceNet !== undefined) return { amountNet: round2(raw.sourceNet) };
  if (settings.legal.smallBusinessRule) return { amountNet: round2(amountGross) };
  if ((classification?.vatMode ?? 'none') !== 'default') return { amountNet: round2(amountGross) };
  const rate = Number(classification?.vatRate);
  if (product === 'lite') {
    const legacyRate = Number(settings.legal.defaultVatRate) || 0;
    return { amountNet: legacyRate > 0 ? round2(amountGross / (1 + legacyRate / 100)) : round2(amountGross) };
  }
  if (Number.isFinite(rate) && rate > 0) return { amountNet: round2(amountGross / (1 + rate / 100)) };
  return { amountNet: round2(amountGross), vatWarning: `VAT_RATE_REQUIRED:${raw.sourceId}` };
};

const listRawEurItems = (
  db: Database.Database,
  from: string,
  to: string,
  product: 'lite' | 'pro' = 'lite',
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
  sourceNet?: number;
  classificationFallbackId?: string;
}> => {
  if (product === 'pro') return listProRawEurItems(db, from, to);
  const drizzle = createDrizzle(db);
  const invoicePayments = drizzle.select({
    invoice_id: schema.invoicePayments.invoiceId,
    date: schema.invoicePayments.date,
    amount: schema.invoicePayments.amount,
    client: schema.invoices.client,
    number: schema.invoices.number,
  }).from(schema.invoicePayments).innerJoin(schema.invoices, eq(schema.invoices.id, schema.invoicePayments.invoiceId))
    .where(and(gte(schema.invoicePayments.date, from), lte(schema.invoicePayments.date, to))).all() as Array<{
    invoice_id: string; date: string; amount: number; client: string; number: string;
  }>;

  const transactions = drizzle.select({
    id: schema.transactions.id,
    date: schema.transactions.date,
    amount: schema.transactions.amount,
    type: schema.transactions.type,
    counterparty: schema.transactions.counterparty,
    purpose: schema.transactions.purpose,
    account_id: schema.transactions.accountId,
    linked_invoice_id: schema.transactions.linkedInvoiceId,
  }).from(schema.transactions).where(and(
    eq(schema.transactions.status, 'booked'),
    gte(schema.transactions.date, from),
    lte(schema.transactions.date, to),
    or(isNull(schema.transactions.deletedAt), eq(schema.transactions.deletedAt, '')),
    or(
      eq(schema.transactions.type, 'expense'),
      and(eq(schema.transactions.type, 'income'), or(isNull(schema.transactions.linkedInvoiceId), eq(schema.transactions.linkedInvoiceId, ''))),
    ),
  )).all() as Array<{
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

const listProRawEurItems = (
  db: Database.Database,
  from: string,
  to: string,
): Array<{
  sourceType: EurSourceType;
  sourceId: string;
  date: string;
  amountGross: number;
  amountNet?: number;
  flowType: 'income' | 'expense';
  accountId?: string;
  linkedViaInvoice?: boolean;
  counterparty: string;
  purpose: string;
  sourceNet?: number;
  classificationFallbackId?: string;
}> => {
  const tableExists = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const hasBankDeletedAt = db.prepare('PRAGMA table_info(bank_transactions)').all().some((row) => (row as { name: string }).name === 'deleted_at');
  const bankDeleted = hasBankDeletedAt ? "AND (b.deleted_at IS NULL OR b.deleted_at = '')" : '';
  const representedBanks = new Set<string>();
  const result: Array<{
    sourceType: EurSourceType;
    sourceId: string;
    date: string;
    amountGross: number;
    amountNet?: number;
    flowType: 'income' | 'expense';
    accountId?: string;
    linkedViaInvoice?: boolean;
    counterparty: string;
    purpose: string;
    sourceNet?: number;
    classificationFallbackId?: string;
  }> = [];

  if (tableExists('open_item_payments')) {
    const payments = db.prepare(`
      SELECT p.id, p.payment_date, p.amount, p.party_type, p.source_type, p.source_id,
             b.account_id, b.counterparty AS bank_counterparty, b.purpose AS bank_purpose,
             MAX(CASE WHEN oi.source_type IN ('outgoing_invoice', 'incoming_invoice') THEN oi.source_type END) AS item_source_type,
             MAX(CASE WHEN oi.source_type IN ('outgoing_invoice', 'incoming_invoice') THEN oi.source_id END) AS item_source_id,
             COALESCE(SUM(oa.amount), 0) AS allocated_amount
      FROM open_item_payments p
      LEFT JOIN bank_transactions b ON b.id = p.source_id AND p.source_type = 'bank_transaction'
      LEFT JOIN open_item_allocations oa ON oa.payment_id = p.id
      LEFT JOIN open_items oi ON oi.id = oa.open_item_id
      WHERE p.payment_date >= ? AND p.payment_date <= ?
        AND (p.source_type <> 'bank_transaction' OR b.status = 'booked')
      GROUP BY p.id, p.payment_date, p.amount, p.party_type, p.source_type, p.source_id,
               b.account_id, b.counterparty, b.purpose
      ORDER BY p.payment_date DESC, p.id
    `).all(from, to) as Array<Record<string, unknown>>;

    for (const payment of payments) {
      const bankId = typeof payment.source_id === 'string' && payment.source_type === 'bank_transaction' ? payment.source_id : undefined;
      if (bankId) representedBanks.add(bankId);
      const invoiceId = typeof payment.item_source_id === 'string'
        && (payment.item_source_type === 'outgoing_invoice' || payment.item_source_type === 'incoming_invoice')
        ? payment.item_source_id : undefined;
      const amountGross = Math.abs(Number(payment.amount) || 0);
      const allocated = Math.min(amountGross, Math.max(0, Number(payment.allocated_amount) || 0));
      let sourceNet: number | undefined;
      if (invoiceId && tableExists('invoices') && payment.item_source_type === 'outgoing_invoice') {
        const invoice = db.prepare('SELECT amount, tax_snapshot_json FROM invoices WHERE id = ?').get(invoiceId) as { amount?: number; tax_snapshot_json?: string | null } | undefined;
        const snapshot = parseJsonObject(invoice?.tax_snapshot_json);
        const gross = Number(snapshot?.grossAmount ?? invoice?.amount) || 0;
        const net = Number(snapshot?.netAmount);
        if (gross > 0 && Number.isFinite(net)) sourceNet = allocated * net / gross + Math.max(0, amountGross - allocated);
      }
      result.push({
        sourceType: 'transaction',
        sourceId: `payment:${String(payment.id)}`,
        date: String(payment.payment_date),
        amountGross,
        flowType: payment.party_type === 'creditor' ? 'expense' : 'income',
        accountId: typeof payment.account_id === 'string' ? payment.account_id : undefined,
        linkedViaInvoice: Boolean(invoiceId),
        counterparty: String(payment.bank_counterparty ?? invoiceId ?? ''),
        purpose: String(payment.bank_purpose ?? (invoiceId ? `OPOS ${invoiceId}` : 'OPOS Zahlung')),
        sourceNet,
        classificationFallbackId: invoiceId,
      });
    }
  }

  const bankRows = db.prepare(`
    SELECT b.id, b.account_id, b.date, b.amount, b.type, b.counterparty, b.purpose, b.linked_invoice_id
    FROM bank_transactions b
    WHERE b.status = 'booked' AND b.date >= ? AND b.date <= ? ${bankDeleted}
    ORDER BY b.date DESC, b.id
  `).all(from, to) as Array<Record<string, unknown>>;
  for (const bank of bankRows) {
    const id = String(bank.id);
    if (representedBanks.has(id)) continue;
    result.push({
      sourceType: 'transaction',
      sourceId: id,
      date: String(bank.date),
      amountGross: Math.abs(Number(bank.amount) || 0),
      flowType: bank.type === 'expense' ? 'expense' : 'income',
      accountId: typeof bank.account_id === 'string' ? bank.account_id : undefined,
      linkedViaInvoice: Boolean(bank.linked_invoice_id),
      counterparty: String(bank.counterparty ?? ''),
      purpose: String(bank.purpose ?? ''),
      classificationFallbackId: typeof bank.linked_invoice_id === 'string' ? bank.linked_invoice_id : undefined,
    });
  }

  if (tableExists('invoice_payments')) {
    const invoicePayments = db.prepare(`
      SELECT p.id, p.invoice_id, p.date, p.amount, i.client, i.number
      FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id
      WHERE p.date >= ? AND p.date <= ?
      ORDER BY p.date DESC, p.id
    `).all(from, to) as Array<Record<string, unknown>>;
    const representedInvoices = new Set(result.filter((item) => item.linkedViaInvoice && item.classificationFallbackId).map((item) => item.classificationFallbackId));
    for (const payment of invoicePayments) {
      const invoiceId = String(payment.invoice_id);
      if (representedInvoices.has(invoiceId)) continue;
      result.push({
        sourceType: 'invoice',
        sourceId: `invoice_payment:${String(payment.id)}`,
        date: String(payment.date),
        amountGross: Math.abs(Number(payment.amount) || 0),
        flowType: 'income',
        linkedViaInvoice: true,
        counterparty: String(payment.client ?? ''),
        purpose: `Rechnung ${String(payment.number ?? invoiceId)}`,
        classificationFallbackId: invoiceId,
      });
    }
  }

  return result.sort((a, b) => a.date === b.date ? a.sourceId.localeCompare(b.sourceId) : (a.date > b.date ? -1 : 1));
};

const parseJsonObject = (value: string | null | undefined): Record<string, unknown> | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
};
