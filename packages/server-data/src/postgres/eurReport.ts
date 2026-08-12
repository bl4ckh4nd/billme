import { EUR_CATALOG_MANIFEST_2025 } from '@billme/desktop-services/eurCatalog';
import { calculateEurRows, type EurCalculationItem, type EurCalculationLine } from '@billme/accounting-shared';
import type { TenantScope } from '@billme/server-core';
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

type ClassificationRow = {
  source_type: string;
  source_id: string;
  eur_line_id: string | null;
  excluded: boolean;
  vat_mode: string;
  vat_rate: string | number | null;
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

const listCashSources = async (db: PostgresQueryable, scope: TenantScope, from: string, to: string): Promise<CashSource[]> => {
  const t = tenant(scope);
  const result: CashSource[] = [];
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

export const getServerEurReport = async (db: PostgresQueryable, scope: TenantScope, args: { from?: string; to?: string } = {}): Promise<ServerEurReportResult> => {
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
  const lines = await q<Record<string, unknown>>(db, `SELECT id,tax_year,kennziffer,provider_path,label,kind,exportable,sort_order,computed_from_json,computed_terms_json FROM eur_lines WHERE tax_year=2025 ORDER BY sort_order,id`);
  if (!lines.length) throw new Error('EUR_SERVER_REPORT_UNAVAILABLE');
  const catalogLines: EurCalculationLine[] = lines.map((row) => ({
    id: String(row.id), kennziffer: row.kennziffer ? String(row.kennziffer) : undefined, providerPath: String(row.provider_path ?? 'main'), label: String(row.label), kind: row.kind as EurCalculationLine['kind'], exportable: Boolean(row.exportable), sortOrder: Number(row.sort_order),
    computedFromIds: parseJsonArray(row.computed_from_json)?.filter((id): id is string => typeof id === 'string'),
    computedTerms: parseJsonArray(row.computed_terms_json)?.filter((term): term is { id: string; sign: 1 | -1 } => Boolean(term && typeof term === 'object' && typeof (term as any).id === 'string' && ((term as any).sign === 1 || (term as any).sign === -1))),
  }));
  const classifications = await q<ClassificationRow>(db, `SELECT source_type,source_id,eur_line_id,excluded,vat_mode,vat_rate FROM eur_classifications WHERE tenant_id=$1 AND tax_year=2025`, [tenant(scope)]);
  const classificationMap = new Map(classifications.map((row) => [`${row.source_type}:${row.source_id}`, row]));
  const smallBusiness = Boolean(settingsJson?.legal && typeof settingsJson.legal === 'object' && (settingsJson.legal as any).smallBusinessRule === true);
  const items: EurCalculationItem[] = [];
  for (const source of await listCashSources(db, scope, from, to)) {
    const basis = await invoiceBasis(db, scope, source, source.amountGross);
    const classification = classificationMap.get(`${source.sourceType}:${source.sourceId}`)
      ?? (source.classificationSourceIds ?? []).map((sourceId) => classificationMap.get(`transaction:${sourceId}`)).find(Boolean)
      ?? (source.invoiceId ? classificationMap.get(`invoice:${source.invoiceId}`) : undefined);
    const net = toNet(source.amountGross, classification, basis.sourceNet, smallBusiness, source.sourceId);
    items.push({ sourceType: source.sourceType, sourceId: source.sourceId, amountNet: net.amountNet, flowType: source.flowType, lineId: classification?.eur_line_id ?? undefined, excluded: classification?.excluded, warning: net.warning });
  }
  const calculation = calculateEurRows(catalogLines, items);
  return { taxYear: 2025, from, to, ...calculation, catalog: { id: EUR_CATALOG_MANIFEST_2025.id, version: EUR_CATALOG_MANIFEST_2025.version, sourceHash: EUR_CATALOG_MANIFEST_2025.sha256, delivery: EUR_CATALOG_MANIFEST_2025.delivery, elsterReady: EUR_CATALOG_MANIFEST_2025.elsterReady } };
};
