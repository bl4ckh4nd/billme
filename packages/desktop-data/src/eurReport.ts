import type Database from 'better-sqlite3';
import { and, asc, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { listEurClassificationsMap, type EurClassification, type EurSourceType, upsertEurClassification } from './eurClassificationRepo';
import { listEurLines, type EurLine } from './eurCatalogRepo';
import { getCatalogManifestForYear } from '@billme/desktop-services/eurCatalog';
import type { AppSettings } from '@billme/desktop-core/types';
import { buildPipelineContext, classifyItem, type SuggestionLayer } from './eurClassificationPipeline';
import { createDrizzle, schema } from './drizzle';
import { calculateEurRows } from '@billme/accounting-shared';
import { listEurCashFacts, type EurCashFact } from './eurFacts';

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
  providerPath?: string;
  label: string;
  kind: 'income' | 'expense' | 'computed';
  exportable: boolean;
  total: number;
  sortOrder: number;
}

export interface EurReportCatalogProvenance {
  id: string;
  version: string;
  sourceHash: string;
  delivery: 'print-form-only' | 'elster-ready';
  elsterReady: boolean;
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
  catalog: EurReportCatalogProvenance;
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
  kind?: 'income' | 'expense' | 'private-withdrawal' | 'private-contribution' | 'pass-through';
  splits?: EurClassificationSplit[];
  cashDate?: string;
}

export interface EurClassificationSplit {
  amountNet: number;
  deductibility?: 'deductible' | 'non-deductible';
  classification?: 'deductible' | 'non-deductible';
  deductible?: boolean;
  lineId?: string;
  reason?: string;
  auditId?: string;
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
  const facts = new Map(listEurCashFacts(db, params.taxYear).map((fact) => [`${fact.sourceType}:${fact.sourceId}`, fact]));
  const rawItems = listRawEurItems(db, from, to, params.product ?? 'lite');
  const pipelineCtx = buildPipelineContext(db, params.taxYear, lines);

  let items = rawItems.map((item) => {
    const classification = classifications.get(`${item.sourceType}:${item.sourceId}`)
      ?? (item.classificationFallbackId ? classifications.get(`invoice:${item.classificationFallbackId}`) : undefined)
      ?? (item.legacyPaymentSourceIds ?? []).map((sourceId) => classifications.get(`transaction:${sourceId}`)).find(Boolean);
    const { sourceNet: _sourceNet, classificationFallbackId: _classificationFallbackId, legacyPaymentSourceIds: _legacyPaymentSourceIds, ...publicItem } = item;
    const line = classification?.eurLineId ? linesById.get(classification.eurLineId) : undefined;
    const suggestion = classifyItem(pipelineCtx, {
      flowType: item.flowType,
      counterparty: item.counterparty,
      purpose: item.purpose,
    });
    return {
      ...publicItem,
      ...toNet(item.amountGross, classification, params.settings, item, params.product ?? 'lite'),
      ...(facts.get(`${item.sourceType}:${item.sourceId}`) ? factProjection(facts.get(`${item.sourceType}:${item.sourceId}`)!) : {}),
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
      const factClassified = Boolean(item.kind || item.splits?.length);
      if (status === 'unclassified') return !item.classification?.eurLineId && !item.classification?.excluded && !factClassified;
      if (status === 'classified') return (Boolean(item.classification?.eurLineId) || factClassified) && !item.classification?.excluded;
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
    return items.filter((item) => !item.classification?.eurLineId && !item.classification?.excluded && !item.kind && !item.splits?.length);
  }

  return items;
};

export const getEurReport = (db: Database.Database, params: EurReportParams): EurReportResult => {
  const { from, to } = fallbackDateRange(params.taxYear, params.from, params.to);
  const lines = listEurLines(db, params.taxYear);
  const items = listEurItems(db, {
    taxYear: params.taxYear,
    from,
    to,
    settings: params.settings,
    product: params.product,
  });

  const calculation = calculateEurRows(lines, items.map((item) => ({
    sourceType: item.sourceType,
    sourceId: item.sourceId,
    amountNet: item.amountNet,
    flowType: item.flowType,
    lineId: item.classification?.eurLineId,
    excluded: item.classification?.excluded,
    warning: item.vatWarning,
    kind: item.kind,
    date: item.cashDate ?? item.date,
    splits: item.splits,
  })), { taxYear: params.taxYear, from, to, requireCashDate: true });
  const rows: EurReportRow[] = calculation.rows.map((line) => ({
    lineId: line.id,
    kennziffer: line.kennziffer,
    providerPath: line.providerPath,
    label: line.label,
    kind: line.kind,
    exportable: line.exportable,
    total: line.total,
    sortOrder: line.sortOrder,
  }));

  return {
    taxYear: params.taxYear,
    from,
    to,
    rows,
    summary: {
      incomeTotal: calculation.summary.incomeTotal,
      expenseTotal: calculation.summary.expenseTotal,
      surplus: calculation.summary.surplus,
    },
    unclassifiedCount: calculation.unclassifiedCount,
    warnings: calculation.warnings,
    catalog: (() => {
      const manifest = getCatalogManifestForYear(params.taxYear);
      return {
        id: manifest.id,
        version: manifest.version,
        sourceHash: manifest.sha256,
        delivery: manifest.delivery,
        elsterReady: manifest.elsterReady,
      };
    })(),
  };
};

const factProjection = (fact: EurCashFact): Pick<EurListItem, 'kind' | 'splits' | 'cashDate' | 'amountNet'> => ({
  kind: fact.kind,
  splits: fact.splits,
  cashDate: undefined,
  amountNet: fact.amountNet,
});

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
    reason: string;
    actor: string;
    product: 'lite' | 'pro';
    settings: AppSettings;
  },
): EurClassification => {
  const source = listEurItems(db, {
    taxYear: input.taxYear,
    settings: input.settings,
    sourceType: input.sourceType,
    product: input.product,
  }).find((item) => item.sourceId === input.sourceId);
  if (!source) throw new Error('EUR_CLASSIFICATION_SOURCE_NOT_FOUND');

  if (input.eurLineId) {
    const line = getEurReport(db, {
      taxYear: input.taxYear,
      settings: input.settings,
      product: input.product,
    }).rows.find((row) => row.lineId === input.eurLineId);
    if (!line) throw new Error('EUR_CLASSIFICATION_LINE_NOT_FOUND');
    if (line.kind === 'computed') throw new Error('EUR_CLASSIFICATION_COMPUTED_LINE_FORBIDDEN');
    if (line.kind !== source.flowType) throw new Error('EUR_CLASSIFICATION_FLOW_MISMATCH');
  }

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
  if (Number.isFinite(rate) && rate >= 0) return { amountNet: round2(amountGross / (1 + rate / 100)) };
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
  legacyPaymentSourceIds?: string[];
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

  const paymentsByInvoice = new Map<string, {
    date: string;
    amountGross: number;
    client: string;
    number: string;
  }>();
  for (const row of invoicePayments) {
    const current = paymentsByInvoice.get(row.invoice_id);
    const isLatest = !current || row.date >= current.date;
    paymentsByInvoice.set(row.invoice_id, {
      date: isLatest ? row.date : current.date,
      amountGross: (current?.amountGross ?? 0) + Math.abs(Number(row.amount) || 0),
      client: isLatest ? row.client : current.client,
      number: isLatest ? row.number : current.number,
    });
  }

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

  for (const [invoiceId, row] of paymentsByInvoice) {
    result.push({
      sourceType: 'invoice',
      sourceId: invoiceId,
      date: row.date,
      amountGross: row.amountGross,
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
    legacyPaymentSourceIds?: string[];
  }> = [];

  if (tableExists('open_item_payments')) {
    const payments = db.prepare(`
      SELECT p.id, p.payment_date, p.amount, p.party_type, p.source_type, p.source_id,
             b.account_id, b.counterparty AS bank_counterparty, b.purpose AS bank_purpose,
             b.source_transaction_id AS bank_source_transaction_id
      FROM open_item_payments p
      LEFT JOIN bank_transactions b ON b.id = p.source_id AND p.source_type = 'bank_transaction'
      WHERE p.payment_date >= ? AND p.payment_date <= ?
        AND (p.source_type <> 'bank_transaction' OR b.status = 'booked') ${bankDeleted}
      ORDER BY p.payment_date DESC, p.id
    `).all(from, to) as Array<Record<string, unknown>>;

    for (const payment of payments) {
      const bankId = typeof payment.source_id === 'string' && payment.source_type === 'bank_transaction' ? payment.source_id : undefined;
      const paymentSourceIds = [
        `payment:${String(payment.id)}`,
        ...(bankId ? [bankId] : []),
        ...(typeof payment.bank_source_transaction_id === 'string' && payment.bank_source_transaction_id.trim()
          ? [payment.bank_source_transaction_id]
          : []),
      ];
      if (bankId) representedBanks.add(bankId);
      const amountGross = Math.abs(Number(payment.amount) || 0);
      const allocations = tableExists('open_item_allocations') && tableExists('open_items')
        ? db.prepare(`
            SELECT oa.id, oa.amount, oi.source_type, oi.source_id
            FROM open_item_allocations oa JOIN open_items oi ON oi.id = oa.open_item_id
            WHERE oa.payment_id = ? ORDER BY oa.created_at, oa.id
          `).all(payment.id) as Array<{ id: string; amount: number; source_type: string; source_id: string }>
        : [];
      let allocated = 0;
      for (const allocation of allocations) {
        const gross = Math.max(0, Math.min(amountGross - allocated, Number(allocation.amount) || 0));
        if (gross <= 0) continue;
        allocated += gross;
        const invoiceId = allocation.source_type === 'outgoing_invoice' || allocation.source_type === 'incoming_invoice' ? allocation.source_id : undefined;
        const basis = invoiceId ? invoiceCashBasis(db, allocation.source_type, invoiceId, gross) : undefined;
        result.push({
          sourceType: 'transaction',
          sourceId: `payment:${String(payment.id)}:allocation:${allocation.id}`,
          date: String(payment.payment_date),
          amountGross: gross,
          flowType: payment.party_type === 'creditor' ? 'expense' : 'income',
          accountId: typeof payment.account_id === 'string' ? payment.account_id : undefined,
          linkedViaInvoice: Boolean(invoiceId),
          counterparty: String(payment.bank_counterparty ?? basis?.counterparty ?? invoiceId ?? ''),
          purpose: String(payment.bank_purpose ?? basis?.purpose ?? (invoiceId ? `OPOS ${invoiceId}` : 'OPOS Zahlung')),
          sourceNet: basis?.sourceNet,
          classificationFallbackId: invoiceId,
          legacyPaymentSourceIds: paymentSourceIds,
        });
      }
      const residual = Math.max(0, amountGross - allocated);
      if (!allocations.length || residual > 0.005) {
        result.push({
          sourceType: 'transaction',
          sourceId: allocations.length ? `payment:${String(payment.id)}:residual` : `payment:${String(payment.id)}`,
          date: String(payment.payment_date),
          amountGross: allocations.length ? residual : amountGross,
          flowType: payment.party_type === 'creditor' ? 'expense' : 'income',
          accountId: typeof payment.account_id === 'string' ? payment.account_id : undefined,
          linkedViaInvoice: false,
          counterparty: String(payment.bank_counterparty ?? ''),
          purpose: String(payment.bank_purpose ?? 'OPOS Zahlung'),
          legacyPaymentSourceIds: paymentSourceIds,
        });
      }
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
      sourceNet: typeof bank.linked_invoice_id === 'string' && tableExists('invoices')
        ? invoiceCashBasis(db, 'outgoing_invoice', bank.linked_invoice_id, Math.abs(Number(bank.amount) || 0)).sourceNet
        : undefined,
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
        sourceNet: invoiceCashBasis(db, 'outgoing_invoice', invoiceId, Math.abs(Number(payment.amount) || 0)).sourceNet,
        classificationFallbackId: invoiceId,
      });
    }
  }

  return result.sort((a, b) => a.date === b.date ? a.sourceId.localeCompare(b.sourceId) : (a.date > b.date ? -1 : 1));
};

const invoiceCashBasis = (
  db: Database.Database,
  sourceType: string,
  sourceId: string,
  allocatedGross: number,
): { sourceNet?: number; counterparty?: string; purpose?: string } => {
  if (sourceType === 'outgoing_invoice') {
    const row = db.prepare('SELECT client, number, amount, tax_snapshot_json FROM invoices WHERE id = ?').get(sourceId) as { client?: string; number?: string; amount?: number; tax_snapshot_json?: string | null } | undefined;
    const snapshot = parseJsonObject(row?.tax_snapshot_json);
    const gross = Number(snapshot?.grossAmount);
    const net = Number(snapshot?.netAmount);
    return {
      sourceNet: gross > 0 && Number.isFinite(net) ? allocatedGross * net / gross : undefined,
      counterparty: row?.client,
      purpose: row?.number ? `Rechnung ${row.number}` : undefined,
    };
  }
  const row = db.prepare(`
    SELECT i.number, i.gross_amount, i.net_amount, i.accounting_snapshot_json, v.name
    FROM incoming_invoices i LEFT JOIN vendors v ON v.id = i.vendor_id
    WHERE i.id = ?
  `).get(sourceId) as { number?: string; gross_amount?: number; net_amount?: number; accounting_snapshot_json?: string | null; name?: string } | undefined;
  const snapshot = parseJsonObject(row?.accounting_snapshot_json);
  const gross = Number(snapshot?.grossAmount ?? row?.gross_amount);
  const net = Number(snapshot?.netAmount ?? row?.net_amount);
  return {
    sourceNet: gross > 0 && Number.isFinite(net) ? allocatedGross * net / gross : undefined,
    counterparty: row?.name,
    purpose: row?.number ? `Eingangsrechnung ${row.number}` : undefined,
  };
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
