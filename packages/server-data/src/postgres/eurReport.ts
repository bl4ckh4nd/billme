import { EUR_CATALOG_MANIFEST_2025 } from '@billme/desktop-services/eurCatalog';
import { calculateEurRows, type EurCalculationItem, type EurCalculationLine } from '@billme/accounting-shared';
import { paymentSchema, type TenantScope } from '@billme/server-core';
import type { PostgresQueryable } from './connection.js';

const q = async <T = Record<string, unknown>>(db: PostgresQueryable, text: string, values: unknown[] = []): Promise<T[]> => (await db.query(text, values)).rows as T[];
const tenant = (scope: TenantScope): string => scope.tenantId;
const round = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
const parseJson = (value: unknown): Record<string, unknown> | undefined => {
  if (!value) return undefined;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
};
const parseJsonArray = (value: unknown): unknown[] | undefined => {
  if (!value) return undefined;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : undefined;
  } catch { return undefined; }
};
const iso2025 = (date: string | undefined, fallback: string): string => date ?? fallback;

export interface ServerEurReportResult {
  taxYear: 2025;
  from: '2025-01-01';
  to: '2025-12-31';
  rows: Array<EurCalculationLine & { total: number }>;
  summary: { incomeTotal: number; expenseTotal: number; surplus: number };
  unclassifiedCount: number;
  warnings: string[];
  catalog: {
    id: string;
    version: string;
    sourceHash: string;
    delivery: 'print-form-only' | 'elster-ready';
    elsterReady: boolean;
  };
}

export interface ServerEurCashItem {
  sourceType: 'transaction' | 'invoice';
  sourceId: string;
  date: string;
  amountGross: number;
  amountNet: number;
  flowType: 'income' | 'expense';
  counterparty: string;
  purpose: string;
  vatWarning?: string;
  classification?: {
    id: string;
    sourceType: 'transaction' | 'invoice';
    sourceId: string;
    taxYear: 2025;
    eurLineId?: string;
    excluded: boolean;
    vatMode: 'none' | 'default';
    vatRate?: number;
    note?: string;
    updatedAt: string;
  };
}

type ClassificationRow = {
  id: string;
  source_type: string;
  source_id: string;
  eur_line_id: string | null;
  excluded: boolean;
  vat_mode: string;
  vat_rate: string | number | null;
  note?: string | null;
  updated_at?: string;
};

type CashSource = {
  sourceType: string;
  sourceId: string;
  date: string;
  amountGross: number;
  flowType: 'income' | 'expense';
  counterparty: string;
  purpose: string;
  invoiceType?: 'outgoing_invoice' | 'incoming_invoice';
  invoiceId?: string;
  classificationSourceIds?: string[];
};

type EurProduct = 'lite' | 'pro';

const invoiceBasis = async (db: PostgresQueryable, scope: TenantScope, source: CashSource, allocatedGross: number): Promise<{ sourceNet?: number; counterparty?: string; purpose?: string }> => {
  if (!source.invoiceId || !source.invoiceType) return {};
  const rows = await q<Record<string, unknown>>(db, source.invoiceType === 'outgoing_invoice'
    ? `SELECT client,number,amount,tax_snapshot_json FROM invoices WHERE tenant_id=$1 AND id=$2`
    : `SELECT number,gross_amount,net_amount,accounting_snapshot_json FROM incoming_invoices WHERE tenant_id=$1 AND id=$2`, [tenant(scope), source.invoiceId]);
  const row = rows[0];
  if (!row) return {};
  const snapshot = parseJson(row.tax_snapshot_json ?? row.accounting_snapshot_json);
  const gross = Number(snapshot?.grossAmount ?? row.amount ?? row.gross_amount);
  const net = Number(snapshot?.netAmount ?? row.net_amount);
  return {
    sourceNet: gross > 0 && Number.isFinite(net) ? round(allocatedGross * net / gross) : undefined,
    counterparty: String(row.client ?? ''),
    purpose: `${source.invoiceType === 'outgoing_invoice' ? 'Rechnung' : 'Eingangsrechnung'} ${String(row.number ?? source.invoiceId)}`,
  };
};

const listCashSources = async (db: PostgresQueryable, scope: TenantScope, from: string, to: string, product: EurProduct = 'pro'): Promise<CashSource[]> => {
  const t = tenant(scope);
  const result: CashSource[] = [];

  if (product === 'lite') {
    const invoices = await q<Record<string, unknown>>(db, `
      SELECT id,date,client,number,amount,tax_snapshot_json,payments_json
      FROM invoices
      WHERE tenant_id=$1
      ORDER BY date,id`, [t]);
    for (const invoice of invoices) {
      const payments = (parseJsonArray(invoice.payments_json) ?? []).flatMap((payment) => {
        const parsed = paymentSchema.safeParse(payment);
        return parsed.success ? [parsed.data] : [];
      });
      const inYear = payments.filter((payment) => payment.date >= from && payment.date <= to && payment.amount !== 0);
      if (!inYear.length) continue;
      const amountGross = round(inYear.reduce((sum, payment) => sum + Math.abs(Number(payment.amount)), 0));
      result.push({
        sourceType: 'invoice',
        sourceId: String(invoice.id),
        date: inYear.map((payment) => String(payment.date)).sort()[0] ?? String(invoice.date),
        amountGross,
        flowType: 'income',
        counterparty: String(invoice.client ?? ''),
        purpose: `Rechnung ${String(invoice.number ?? invoice.id)}`,
        invoiceType: 'outgoing_invoice',
        invoiceId: String(invoice.id),
      });
    }

    const banks = await q<Record<string, unknown>>(db, `
      SELECT id,date,amount,type,counterparty,purpose,source_transaction_id
      FROM bank_transactions
      WHERE tenant_id=$1 AND status='booked' AND linked_invoice_id IS NULL
        AND date >= $2 AND date <= $3
      ORDER BY date,id`, [t, from, to]);
    for (const bank of banks) {
      const sourceTransactionId = typeof bank.source_transaction_id === 'string' && bank.source_transaction_id.trim()
        ? bank.source_transaction_id
        : undefined;
      result.push({
        sourceType: 'transaction',
        sourceId: String(bank.id),
        date: String(bank.date),
        amountGross: Math.abs(Number(bank.amount) || 0),
        flowType: bank.type === 'expense' ? 'expense' : 'income',
        counterparty: String(bank.counterparty ?? ''),
        purpose: String(bank.purpose ?? ''),
        classificationSourceIds: sourceTransactionId ? [sourceTransactionId] : undefined,
      });
    }
    return result;
  }

  const representedBanks = new Set<string>();
  const payments = await q<Record<string, unknown>>(db, `
    SELECT p.id,p.payment_date,p.amount,p.party_type,p.source_type,p.source_id,
           b.id AS bank_id,b.source_transaction_id,b.counterparty,b.purpose
    FROM open_item_payments p
    LEFT JOIN bank_transactions b ON b.tenant_id=p.tenant_id AND b.id=p.source_id AND p.source_type='bank_transaction'
    WHERE p.tenant_id=$1 AND p.payment_date >= $2 AND p.payment_date <= $3
      AND (p.source_type <> 'bank_transaction' OR b.status='booked')
    ORDER BY p.payment_date,p.id`, [t, from, to]);
  for (const payment of payments) {
    const allocations = await q<Record<string, unknown>>(db, `
      SELECT oa.id,oa.amount,oi.party_type,oi.source_type,oi.source_id
      FROM open_item_allocations oa JOIN open_items oi ON oi.tenant_id=oa.tenant_id AND oi.id=oa.open_item_id
      WHERE oa.tenant_id=$1 AND oa.payment_id=$2 ORDER BY oa.created_at,oa.id`, [t, payment.id]);
    const amountGross = Math.abs(Number(payment.amount) || 0);
    let allocated = 0;
    if (payment.bank_id) representedBanks.add(String(payment.bank_id));
    for (const allocation of allocations) {
      const gross = Math.max(0, Math.min(amountGross - allocated, Number(allocation.amount) || 0));
      if (gross <= 0) continue;
      allocated += gross;
      const sourceType = String(allocation.source_type);
      const invoiceType = sourceType === 'outgoing_invoice' || sourceType === 'incoming_invoice' ? sourceType : undefined;
      result.push({
        sourceType: 'transaction', sourceId: `payment:${payment.id}:allocation:${allocation.id}`, date: String(payment.payment_date), amountGross: gross,
        flowType: allocation.party_type === 'creditor' ? 'expense' : 'income', counterparty: String(payment.counterparty ?? ''), purpose: String(payment.purpose ?? 'OPOS Zahlung'), invoiceType, invoiceId: invoiceType ? String(allocation.source_id) : undefined,
        classificationSourceIds: [payment.bank_id, payment.source_transaction_id].filter((id): id is string => typeof id === 'string' && id.length > 0),
      });
    }
    const residual = Math.max(0, amountGross - allocated);
    if (!allocations.length || residual > 0.005) result.push({
      sourceType: 'transaction', sourceId: allocations.length ? `payment:${payment.id}:residual` : String(payment.bank_id ?? `payment:${payment.id}`), date: String(payment.payment_date), amountGross: allocations.length ? residual : amountGross,
      flowType: payment.party_type === 'creditor' ? 'expense' : 'income', counterparty: String(payment.counterparty ?? ''), purpose: String(payment.purpose ?? 'OPOS Zahlung'),
      classificationSourceIds: [payment.bank_id, payment.source_transaction_id].filter((id): id is string => typeof id === 'string' && id.length > 0),
    });
  }
  const banks = await q<Record<string, unknown>>(db, `SELECT id,date,amount,type,counterparty,purpose,linked_invoice_id FROM bank_transactions WHERE tenant_id=$1 AND status='booked' AND date >= $2 AND date <= $3 ORDER BY date,id`, [t, from, to]);
  for (const bank of banks) {
    const id = String(bank.id);
    if (representedBanks.has(id)) continue;
    const invoiceId = typeof bank.linked_invoice_id === 'string' && bank.linked_invoice_id ? bank.linked_invoice_id : undefined;
    result.push({ sourceType: 'transaction', sourceId: id, date: String(bank.date), amountGross: Math.abs(Number(bank.amount) || 0), flowType: bank.type === 'expense' ? 'expense' : 'income', counterparty: String(bank.counterparty ?? ''), purpose: String(bank.purpose ?? ''), invoiceType: invoiceId ? 'outgoing_invoice' : undefined, invoiceId });
  }
  return result;
};

const toNet = (gross: number, classification: ClassificationRow | undefined, sourceNet: number | undefined, smallBusiness: boolean, sourceId: string): { amountNet: number; warning?: string } => {
  if (sourceNet !== undefined) return { amountNet: sourceNet };
  if (smallBusiness || classification?.vat_mode !== 'default') return { amountNet: round(gross) };
  const rate = Number(classification.vat_rate);
  if (Number.isFinite(rate) && rate >= 0) return { amountNet: round(gross / (1 + rate / 100)) };
  return { amountNet: round(gross), warning: `VAT_RATE_REQUIRED:${sourceId}` };
};

export const assertServerEurProfile = async (db: PostgresQueryable, scope: TenantScope, args: { from?: string; to?: string }): Promise<{ from: '2025-01-01'; to: '2025-12-31'; smallBusiness: boolean }> => {
  const from = iso2025(args.from, '2025-01-01');
  const to = iso2025(args.to, '2025-12-31');
  if (from !== '2025-01-01' || to !== '2025-12-31') throw new Error('EUR_RANGE_2025_REQUIRED');
  const settings = (await q<{ settings_json: string }>(db, `SELECT settings_json FROM server_settings WHERE tenant_id=$1 LIMIT 1`, [tenant(scope)]))[0];
  const settingsJson = parseJson(settings?.settings_json);
  const profile = settingsJson?.businessReportingProfile;
  if (!settingsJson) throw new Error('EUR_SERVER_REPORT_UNAVAILABLE');
  if (!profile || typeof profile !== 'object' || (profile as any).jurisdiction !== 'DE' || (profile as any).legalForm !== 'sole_proprietor' || (profile as any).profitDetermination !== 'eur' || ((profile as any).fiscalYearStart !== undefined && (profile as any).fiscalYearStart !== '01-01')) {
    throw new Error('EUR_PROFILE_REQUIRED');
  }
  return { from: '2025-01-01', to: '2025-12-31', smallBusiness: Boolean(settingsJson.legal && typeof settingsJson.legal === 'object' && (settingsJson.legal as any).smallBusinessRule === true) };
};

const loadClassifications = async (db: PostgresQueryable, scope: TenantScope): Promise<Map<string, ClassificationRow>> => {
  const rows = await q<ClassificationRow>(db, `SELECT id,source_type,source_id,eur_line_id,excluded,vat_mode,vat_rate,note,updated_at FROM eur_classifications WHERE tenant_id=$1 AND tax_year=2025`, [tenant(scope)]);
  return new Map(rows.map((row) => [`${row.source_type}:${row.source_id}`, row]));
};

export const listServerEurCashItems = async (db: PostgresQueryable, scope: TenantScope, args: { from?: string; to?: string; product?: EurProduct } = {}): Promise<ServerEurCashItem[]> => {
  const { from, to, smallBusiness } = await assertServerEurProfile(db, scope, args);
  const product = args.product ?? 'pro';
  const classifications = await loadClassifications(db, scope);
  const items: ServerEurCashItem[] = [];
  for (const source of await listCashSources(db, scope, from, to, product)) {
    const basis = await invoiceBasis(db, scope, source, source.amountGross);
    const classification = classifications.get(`${source.sourceType}:${source.sourceId}`)
      ?? (source.classificationSourceIds ?? []).map((sourceId) => classifications.get(`transaction:${sourceId}`)).find(Boolean)
      ?? (source.invoiceId ? classifications.get(`invoice:${source.invoiceId}`) : undefined);
    const net = toNet(source.amountGross, classification, basis.sourceNet, smallBusiness, source.sourceId);
    items.push({ sourceType: source.sourceType as ServerEurCashItem['sourceType'], sourceId: source.sourceId, date: source.date, amountGross: source.amountGross, amountNet: net.amountNet, flowType: source.flowType, counterparty: basis.counterparty ?? source.counterparty, purpose: basis.purpose ?? source.purpose, vatWarning: net.warning, classification: classification ? { id: classification.id, sourceType: classification.source_type as ServerEurCashItem['sourceType'], sourceId: classification.source_id, taxYear: 2025, eurLineId: classification.eur_line_id ?? undefined, excluded: Boolean(classification.excluded), vatMode: classification.vat_mode === 'default' ? 'default' : 'none', vatRate: classification.vat_rate == null ? undefined : Number(classification.vat_rate), note: classification.note ?? undefined, updatedAt: classification.updated_at ?? '' } : undefined });
  }
  return items.sort((left, right) => left.date === right.date ? left.sourceId.localeCompare(right.sourceId) : left.date.localeCompare(right.date));
};

/**
 * Ensure a classification targets a currently visible cash source.  Payment
 * rows deliberately expose synthetic ids for allocations/residuals, while
 * imported classifications may use the canonical bank transaction id (or an
 * invoice id for the invoice basis).  Accept those aliases, but never allow a
 * tenant to create a classification for an arbitrary id.
 */
export const assertServerEurCashSource = async (
  db: PostgresQueryable,
  scope: TenantScope,
  sourceType: 'transaction' | 'invoice',
  sourceId: string,
  product: EurProduct = 'pro',
): Promise<CashSource> => {
  const { from, to } = await assertServerEurProfile(db, scope, {});
  const sources = await listCashSources(db, scope, from, to, product);
  const source = sources.find((candidate) => {
    if (sourceType === 'invoice') return candidate.invoiceType !== undefined && candidate.invoiceId === sourceId;
    return candidate.sourceId === sourceId || (candidate.classificationSourceIds ?? []).includes(sourceId);
  });
  if (!source) throw new Error('EUR_SOURCE_NOT_FOUND');
  return source;
};

export const getServerEurReport = async (db: PostgresQueryable, scope: TenantScope, args: { from?: string; to?: string; product?: EurProduct } = {}): Promise<ServerEurReportResult> => {
  const { from, to } = await assertServerEurProfile(db, scope, args);
  const lines = await q<Record<string, unknown>>(db, `SELECT id,tax_year,kennziffer,provider_path,label,kind,exportable,sort_order,computed_from_json,computed_terms_json FROM eur_lines WHERE tax_year=2025 ORDER BY sort_order,id`);
  if (!lines.length) throw new Error('EUR_SERVER_REPORT_UNAVAILABLE');
  const catalogLines: EurCalculationLine[] = lines.map((row) => ({
    id: String(row.id), kennziffer: row.kennziffer ? String(row.kennziffer) : undefined, providerPath: String(row.provider_path ?? 'main'), label: String(row.label), kind: row.kind as EurCalculationLine['kind'], exportable: Boolean(row.exportable), sortOrder: Number(row.sort_order),
    computedFromIds: parseJsonArray(row.computed_from_json)?.filter((id): id is string => typeof id === 'string'),
    computedTerms: parseJsonArray(row.computed_terms_json)?.filter((term): term is { id: string; sign: 1 | -1 } => Boolean(term && typeof term === 'object' && typeof (term as any).id === 'string' && ((term as any).sign === 1 || (term as any).sign === -1))),
  }));
  const sourceItems = await listServerEurCashItems(db, scope, { from, to, product: args.product });
  const items: EurCalculationItem[] = [];
  for (const source of sourceItems) items.push({ sourceType: source.sourceType, sourceId: source.sourceId, amountNet: source.amountNet, flowType: source.flowType, lineId: source.classification?.eurLineId, excluded: source.classification?.excluded, warning: source.vatWarning });
  const calculation = calculateEurRows(catalogLines, items);
  return { taxYear: 2025, from, to, ...calculation, catalog: { id: EUR_CATALOG_MANIFEST_2025.id, version: EUR_CATALOG_MANIFEST_2025.version, sourceHash: EUR_CATALOG_MANIFEST_2025.sha256, delivery: EUR_CATALOG_MANIFEST_2025.delivery, elsterReady: EUR_CATALOG_MANIFEST_2025.elsterReady } };
};
