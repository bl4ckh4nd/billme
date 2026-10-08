import { getCatalogForYear, getCatalogManifestForYear } from '@billme/desktop-services/eurCatalog';
import { suggestEurLine, resolveEurCodeToLine } from '@billme/desktop-services/eurSuggestion';
import { listServerEurRules } from './eurRules.js';
import { calculateEurRows, type EurCalculationItem, type EurCalculationLine, type EurExpenseSplit } from '@billme/accounting-shared';
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
const isoForYear = (year: number, date: string | undefined, edge: 'start' | 'end'): string => date ?? `${year}-${edge === 'start' ? '01-01' : '12-31'}`;
const rangeError = (year: number): string => year === 2025 ? 'EUR_RANGE_2025_REQUIRED' : `EUR_RANGE_${year}_REQUIRED`;

export interface ServerEurReportResult {
  taxYear: number;
  from: string;
  to: string;
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
  sourceType: 'transaction' | 'invoice' | 'manual';
  sourceId: string;
  date: string;
  amountGross: number;
  amountNet: number;
  flowType: 'income' | 'expense';
  accountId?: string;
  linkedViaInvoice?: boolean;
  counterparty: string;
  purpose: string;
  vatWarning?: string;
  vatAmountCash?: number;
  suggestedLineId?: string;
  suggestionReason?: string;
  suggestionLayer?: 'rule' | 'counterparty' | 'keyword';
  kind?: 'income' | 'expense' | 'private-withdrawal' | 'private-contribution' | 'pass-through';
  splits?: EurExpenseSplit[];
  classification?: {
    id: string;
    sourceType: 'transaction' | 'invoice' | 'manual';
    sourceId: string;
    taxYear: number;
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
  sourceType: 'transaction' | 'invoice' | 'manual';
  sourceId: string;
  date: string;
  amountGross: number;
  flowType: 'income' | 'expense';
  accountId?: string;
  linkedViaInvoice?: boolean;
  counterparty: string;
  purpose: string;
  invoiceType?: 'outgoing_invoice' | 'incoming_invoice';
  invoiceId?: string;
  classificationSourceIds?: string[];
  sourceNet?: number;
  warning?: string;
};

type EurProduct = 'lite' | 'pro';

const invoiceBasis = async (db: PostgresQueryable, scope: TenantScope, source: CashSource, allocatedGross: number): Promise<{ sourceNet?: number; counterparty?: string; purpose?: string }> => {
  if (source.sourceNet !== undefined) return { sourceNet: source.sourceNet };
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
    sourceNet: gross !== 0 && Number.isFinite(net) ? round(allocatedGross * net / gross) : undefined,
    counterparty: String(row.client ?? ''),
    purpose: `${source.invoiceType === 'outgoing_invoice' ? 'Rechnung' : 'Eingangsrechnung'} ${String(row.number ?? source.invoiceId)}`,
  };
};

/**
 * §11 Abs. 1 S. 2 / Abs. 2 S. 2 EStG: a regelmäßig wiederkehrende payment that flows within 10 days around
 * the year end, and falls due in that window, belongs to the year it is economically for. Returns that
 * year when the rule moves the payment, else undefined. `economic` is the service date the payment is for.
 */
const DAY = 86_400_000;
const tenDayYear = (paid: string, economic: string | undefined, due: string | undefined): number | undefined => {
  if (!economic || !due) return undefined;
  const paidYear = Number(paid.slice(0, 4));
  const economicYear = Number(economic.slice(0, 4));
  if (Math.abs(paidYear - economicYear) !== 1) return undefined;
  const boundary = Date.parse(`${Math.max(paidYear, economicYear)}-01-01T00:00:00Z`);
  // 22.12.–31.12. and 01.01.–10.01. are "kurze Zeit" around the turn of the year.
  const near = (date: string) => { const at = Date.parse(`${date.slice(0, 10)}T00:00:00Z`); return at >= boundary - 10 * DAY && at < boundary + 10 * DAY; };
  return near(paid) && near(due) ? economicYear : undefined;
};
const yearOf = (date: string) => Number(date.slice(0, 4));
const TEN_DAY_NOTE = ' (10-Tage-Regel, § 11 EStG)';

const listCashSources = async (db: PostgresQueryable, scope: TenantScope, from: string, to: string, product: EurProduct = 'pro'): Promise<CashSource[]> => {
  const t = tenant(scope);
  const result: CashSource[] = [];
  const taxYear = yearOf(from);

  if (product === 'lite') {
    const invoices = await q<Record<string, unknown>>(db, `
      SELECT id,date,due_date,service_period,client,number,amount,tax_snapshot_json,payments_json
      FROM invoices
      WHERE tenant_id=$1
      ORDER BY date,id`, [t]);
    for (const invoice of invoices) {
      const payments = (parseJsonArray(invoice.payments_json) ?? []).flatMap((payment) => {
        const parsed = paymentSchema.safeParse(payment);
        return parsed.success ? [parsed.data] : [];
      });
      // ponytail: "regelmäßig wiederkehrend" is read as an invoice for a service period (subscriptions, rent);
      // single-date invoices never move. Replace once invoices carry an explicit recurring marker.
      const period = String(invoice.service_period ?? '').match(/^(\d{4}-\d{2}-\d{2}) bis \d{4}-\d{2}-\d{2}$/)?.[1];
      const attributed = (date: string) => tenDayYear(date, period, invoice.due_date ? String(invoice.due_date) : undefined) ?? yearOf(date);
      // A Skonto entry settles the invoice but is no money received (Zufluss, §11 EStG).
      const inYear = payments.filter((payment) => attributed(payment.date) === taxYear && payment.amount !== 0 && !payment.id.startsWith('skonto:'));
      if (!inYear.length) continue;
      for (const payment of inYear) result.push({
        sourceType: 'invoice',
        sourceId: `${invoice.id}:payment:${payment.id}`,
        date: payment.date,
        amountGross: round(payment.amount),
        flowType: 'income',
        linkedViaInvoice: payment.id.startsWith('transaction-payment:'),
        counterparty: String(invoice.client ?? ''),
        purpose: `Rechnung ${String(invoice.number ?? invoice.id)}${yearOf(payment.date) !== taxYear ? TEN_DAY_NOTE : ''}`,
        invoiceType: 'outgoing_invoice',
        invoiceId: String(invoice.id),
      });
    }

    const banks = await q<Record<string, unknown>>(db, `SELECT * FROM bank_transactions WHERE tenant_id=$1`, [t]);
    const transactions = await q<Record<string, unknown>>(db, `
      SELECT * FROM transactions WHERE tenant_id=$1 AND status='booked'
        AND (deleted_at IS NULL OR deleted_at='') AND date >= $2 AND date <= $3
      ORDER BY date,id`, [t, from, to]);
    const allTransactionIds = new Set((await q<{ id: string }>(db, `SELECT id FROM transactions WHERE tenant_id=$1`, [t])).map((row) => row.id));
    const manual = await q<Record<string, unknown>>(db, `SELECT m.*,b.date AS bank_date,b.account_id,r.receipt_json FROM lite_cash_entries m LEFT JOIN transactions b ON b.tenant_id=m.tenant_id AND b.id=m.matched_transaction_id LEFT JOIN lite_receipts r ON r.tenant_id=m.tenant_id AND r.id=m.receipt_id WHERE m.tenant_id=$1 AND m.deleted_at IS NULL`, [t]);
    const representedManual = new Set(manual.map((row) => row.matched_transaction_id).filter(Boolean));
    for (const row of manual) {
      const date = String(row.bank_date ?? row.cash_date);
      const receipt = parseJson(row.receipt_json);
      // A recurring receipt's service date is the period it pays for and, for rent and the like, also when it is due.
      const serviceDate = receipt?.recurring === true && typeof receipt.serviceDate === 'string' ? receipt.serviceDate : undefined;
      const year = tenDayYear(date, serviceDate, serviceDate) ?? yearOf(date);
      if (year !== taxYear) continue;
      const gross = (row.flow_type === 'expense' ? -1 : 1) * Number(row.amount_cents) / 100;
      const rates = Array.isArray(receipt?.taxBreakdown) ? receipt.taxBreakdown as Array<{ netAmountCents: number; vatAmountCents: number }> : [];
      const receiptNet = rates.reduce((sum, rate) => sum + Number(rate.netAmountCents) + (row.flow_type === 'expense' ? Number(rate.vatAmountCents) * (1 - Number(receipt?.deductiblePercent ?? 0) / 100) : 0), 0);
      const receiptGross = Number(receipt?.grossAmountCents);
      result.push({ sourceType: 'manual', sourceId: String(row.id), date, amountGross: gross, flowType: row.flow_type === 'expense' ? 'expense' : 'income', accountId: row.account_id ? String(row.account_id) : undefined, counterparty: String(row.counterparty), purpose: `${String(row.purpose)}${yearOf(date) !== taxYear ? TEN_DAY_NOTE : ''}`, sourceNet: receipt?.reviewed && receiptGross !== 0 && Number.isFinite(receiptGross) ? round(gross * receiptNet / receiptGross) : undefined });
    }
    for (const bank of transactions) {
      if (representedManual.has(bank.id)) continue;
      const aliases = banks.filter((mirror) => mirror.source_transaction_id === bank.id).map((mirror) => String(mirror.id));
      const invoice = invoices.find((candidate) => candidate.id === bank.linked_invoice_id);
      const payments = parseJsonArray(invoice?.payments_json) ?? [];
      const allocation = payments.flatMap((payment) => {
        const parsed = paymentSchema.safeParse(payment);
        return parsed.success && parsed.data.id === `transaction-payment:${bank.id}` ? [parsed.data] : [];
      });
      const applied = allocation.reduce((sum, payment) => sum + payment.amount, 0);
      const residual = round(Number(bank.amount) - applied);
      if (residual === 0) continue;
      result.push({
        sourceType: 'transaction',
        sourceId: String(bank.id),
        date: String(bank.date),
        amountGross: bank.type === 'expense' ? -residual : residual,
        flowType: bank.type === 'expense' ? 'expense' : 'income',
        accountId: bank.account_id ? String(bank.account_id) : undefined,
        linkedViaInvoice: false,
        counterparty: String(bank.counterparty ?? ''),
        purpose: String(bank.purpose ?? ''),
        classificationSourceIds: aliases,
        warning: bank.linked_invoice_id && allocation.length !== 1 ? `CASH_ALLOCATION_REVIEW_REQUIRED:${bank.id}` : undefined,
      });
    }
    // Imported SQLite classifications can still reference mirror-only cash rows.
    for (const bank of banks) {
      if (allTransactionIds.has(String(bank.source_transaction_id)) || bank.status !== 'booked' || bank.linked_invoice_id || String(bank.date) < from || String(bank.date) > to) continue;
      result.push({ sourceType: 'transaction', sourceId: String(bank.id), date: String(bank.date), amountGross: bank.type === 'expense' ? -Number(bank.amount) : Number(bank.amount), flowType: bank.type === 'expense' ? 'expense' : 'income', accountId: String(bank.account_id), counterparty: String(bank.counterparty ?? ''), purpose: String(bank.purpose ?? '') });
    }
    return result;
  }

  const representedBanks = new Set<string>();
  const payments = await q<Record<string, unknown>>(db, `
    SELECT p.id,p.payment_date,p.amount,p.party_type,p.source_type,p.source_id,
           b.id AS bank_id,b.account_id,b.source_transaction_id,b.counterparty,b.purpose
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
        accountId: payment.account_id ? String(payment.account_id) : undefined,
        linkedViaInvoice: Boolean(invoiceType),
        flowType: allocation.party_type === 'creditor' ? 'expense' : 'income', counterparty: String(payment.counterparty ?? ''), purpose: String(payment.purpose ?? 'OPOS Zahlung'), invoiceType, invoiceId: invoiceType ? String(allocation.source_id) : undefined,
        classificationSourceIds: [payment.bank_id, payment.source_transaction_id].filter((id): id is string => typeof id === 'string' && id.length > 0),
      });
    }
    const residual = Math.max(0, amountGross - allocated);
    if (!allocations.length || residual > 0.005) result.push({
      sourceType: 'transaction', sourceId: allocations.length ? `payment:${payment.id}:residual` : String(payment.bank_id ?? `payment:${payment.id}`), date: String(payment.payment_date), amountGross: allocations.length ? residual : amountGross,
      accountId: payment.account_id ? String(payment.account_id) : undefined,
      linkedViaInvoice: false,
      flowType: payment.party_type === 'creditor' ? 'expense' : 'income', counterparty: String(payment.counterparty ?? ''), purpose: String(payment.purpose ?? 'OPOS Zahlung'),
      classificationSourceIds: [payment.bank_id, payment.source_transaction_id].filter((id): id is string => typeof id === 'string' && id.length > 0),
    });
  }
  const banks = await q<Record<string, unknown>>(db, `SELECT id,account_id,date,amount,type,counterparty,purpose,linked_invoice_id FROM bank_transactions WHERE tenant_id=$1 AND status='booked' AND date >= $2 AND date <= $3 ORDER BY date,id`, [t, from, to]);
  for (const bank of banks) {
    const id = String(bank.id);
    if (representedBanks.has(id)) continue;
    const invoiceId = typeof bank.linked_invoice_id === 'string' && bank.linked_invoice_id ? bank.linked_invoice_id : undefined;
    result.push({ sourceType: 'transaction', sourceId: id, date: String(bank.date), amountGross: Math.abs(Number(bank.amount) || 0), flowType: bank.type === 'expense' ? 'expense' : 'income', accountId: bank.account_id ? String(bank.account_id) : undefined, linkedViaInvoice: Boolean(invoiceId), counterparty: String(bank.counterparty ?? ''), purpose: String(bank.purpose ?? ''), invoiceType: invoiceId ? 'outgoing_invoice' : undefined, invoiceId });
  }
  return result;
};

const toNet = (gross: number, classification: ClassificationRow | undefined, sourceNet: number | undefined, smallBusiness: boolean, sourceId: string): { amountNet: number; warning?: string } => {
  if (smallBusiness) return { amountNet: round(gross) };
  if (sourceNet !== undefined) return { amountNet: sourceNet };
  if (smallBusiness || classification?.vat_mode !== 'default') return { amountNet: round(gross) };
  const rate = classification.vat_rate == null ? NaN : Number(classification.vat_rate);
  if (Number.isFinite(rate) && rate >= 0) return { amountNet: round(gross / (1 + rate / 100)) };
  return { amountNet: round(gross), warning: `VAT_RATE_REQUIRED:${sourceId}` };
};

export const assertServerEurProfile = async (db: PostgresQueryable, scope: TenantScope, args: { taxYear?: number; from?: string; to?: string }): Promise<{ taxYear: number; from: string; to: string; smallBusiness: boolean }> => {
  const year = args.taxYear ?? (args.from ? Number(args.from.slice(0, 4)) : 2025);
  getCatalogForYear(year);
  const from = isoForYear(year, args.from, 'start');
  const to = isoForYear(year, args.to, 'end');
  if (from !== `${year}-01-01` || to !== `${year}-12-31`) throw new Error(rangeError(year));
  const settings = (await q<{ settings_json: string }>(db, `SELECT settings_json FROM server_settings WHERE tenant_id=$1 LIMIT 1`, [tenant(scope)]))[0];
  const settingsJson = parseJson(settings?.settings_json);
  const profile = settingsJson?.businessReportingProfile;
  if (!settingsJson) throw new Error('EUR_SERVER_REPORT_UNAVAILABLE');
  if (!profile || typeof profile !== 'object' || (profile as any).jurisdiction !== 'DE' || !['sole_proprietor', 'gbr', 'ek'].includes((profile as any).legalForm) || (profile as any).profitDetermination !== 'eur' || ((profile as any).fiscalYearStart !== undefined && (profile as any).fiscalYearStart !== '01-01')) {
    throw new Error('EUR_PROFILE_REQUIRED');
  }
  return { taxYear: year, from, to, smallBusiness: Boolean(settingsJson.legal && typeof settingsJson.legal === 'object' && (settingsJson.legal as any).smallBusinessRule === true) };
};

const loadClassifications = async (db: PostgresQueryable, scope: TenantScope, taxYear: number): Promise<Map<string, ClassificationRow>> => {
  const rows = await q<ClassificationRow>(db, `SELECT id,source_type,source_id,eur_line_id,excluded,vat_mode,vat_rate,note,updated_at FROM eur_classifications WHERE tenant_id=$1 AND tax_year=$2`, [tenant(scope), taxYear]);
  return new Map(rows.map((row) => [`${row.source_type}:${row.source_id}`, row]));
};

export const listServerEurCashItems = async (db: PostgresQueryable, scope: TenantScope, args: { taxYear?: number; from?: string; to?: string; product?: EurProduct } = {}): Promise<ServerEurCashItem[]> => {
  const { taxYear, from, to, smallBusiness } = await assertServerEurProfile(db, scope, args);
  const product = args.product ?? 'pro';
  const classifications = await loadClassifications(db, scope, taxYear);
  const facts = new Map((await q<Record<string, unknown>>(db, `SELECT id,source_type,source_id,kind,amount_net,eur_line_id,splits_json FROM eur_cash_facts WHERE tenant_id=$1 AND tax_year=$2`, [tenant(scope), taxYear])).map((fact) => [`${fact.source_type}:${fact.source_id}`, fact]));
  const items: ServerEurCashItem[] = [];
  for (const source of await listCashSources(db, scope, from, to, product)) {
    const basis = await invoiceBasis(db, scope, source, source.amountGross);
    const classification = classifications.get(`${source.sourceType}:${source.sourceId}`)
      ?? (source.classificationSourceIds ?? []).map((sourceId) => classifications.get(`transaction:${sourceId}`)).find(Boolean)
      ?? (source.invoiceId ? classifications.get(`invoice:${source.invoiceId}`) : undefined);
    const net = toNet(source.amountGross, classification, basis.sourceNet, smallBusiness, source.sourceId);
    const fact = facts.get(`${source.sourceType}:${source.sourceId}`)
      ?? (source.classificationSourceIds ?? []).map((sourceId) => facts.get(`transaction:${sourceId}`)).find(Boolean)
      ?? (source.invoiceId ? facts.get(`invoice:${source.invoiceId}`) : undefined);
    const persistedClassification = classification ?? (fact ? { id: String(fact.id), source_type: source.sourceType, source_id: source.sourceId, eur_line_id: fact.eur_line_id ? String(fact.eur_line_id) : null, excluded: false, vat_mode: 'none', vat_rate: null, note: null, updated_at: '' } : undefined);
    const legacyInvoiceFact = product === 'lite' && fact && fact.source_type === 'invoice' && fact.source_id !== source.sourceId;
    items.push({ sourceType: source.sourceType, sourceId: source.sourceId, date: source.date, amountGross: source.amountGross, amountNet: fact && !legacyInvoiceFact ? Number(fact.amount_net) : net.amountNet, flowType: source.flowType, accountId: source.accountId, linkedViaInvoice: source.linkedViaInvoice, counterparty: basis.counterparty ?? source.counterparty, purpose: source.purpose?.endsWith(TEN_DAY_NOTE) && basis.purpose && !basis.purpose.endsWith(TEN_DAY_NOTE) ? `${basis.purpose}${TEN_DAY_NOTE}` : basis.purpose ?? source.purpose, vatWarning: source.warning ?? (legacyInvoiceFact ? `LEGACY_CASH_FACT_REVIEW_REQUIRED:${source.invoiceId}` : net.warning), kind: fact?.kind as ServerEurCashItem['kind'] | undefined, splits: fact?.splits_json && !legacyInvoiceFact ? parseJsonArray(fact.splits_json) as EurExpenseSplit[] : undefined, classification: persistedClassification ? { id: persistedClassification.id, sourceType: source.sourceType, sourceId: source.sourceId, taxYear, eurLineId: persistedClassification.eur_line_id ?? undefined, excluded: Boolean(persistedClassification.excluded), vatMode: persistedClassification.vat_mode === 'default' ? 'default' : 'none', vatRate: persistedClassification.vat_rate == null ? undefined : Number(persistedClassification.vat_rate), note: persistedClassification.note ?? undefined, updatedAt: persistedClassification.updated_at ?? '' } : undefined });
    items[items.length - 1].vatAmountCash = round(source.amountGross - net.amountNet);
  }
  // Both products show the rules button and the suggestion in the EÜR view.
  {
    const lines = getCatalogForYear(taxYear);
    const valid = new Set(lines.map((line) => line.id));
    const rules = (await listServerEurRules(db, scope, taxYear)).filter((rule) => rule.active && valid.has(rule.targetEurLineId));
    for (const item of items) {
      if (item.classification?.eurLineId || item.classification?.excluded) continue;
      const rule = rules.find((rule) => {
        if (lines.find((line) => line.id === rule.targetEurLineId)?.kind !== item.flowType) return false;
        const text = (rule.field === 'counterparty' ? item.counterparty : rule.field === 'purpose' ? item.purpose : `${item.counterparty} ${item.purpose}`).toLocaleLowerCase('de-DE');
        const value = rule.value.toLocaleLowerCase('de-DE');
        return rule.operator === 'equals' ? text === value : rule.operator === 'startsWith' ? text.startsWith(value) : text.includes(value);
      });
      if (rule) { item.suggestedLineId = rule.targetEurLineId; item.suggestionReason = 'Ihre Zuordnungsregel'; item.suggestionLayer = 'rule'; continue; }
      const previous = new Set(items.filter((other) => other.flowType === item.flowType && other.counterparty.trim().toLocaleLowerCase('de-DE') === item.counterparty.trim().toLocaleLowerCase('de-DE') && !other.classification?.excluded).map((other) => other.classification?.eurLineId).filter((id): id is string => !!id && valid.has(id)));
      if (previous.size === 1 && item.counterparty.trim()) { item.suggestedLineId = [...previous][0]; item.suggestionReason = 'Bisherige Zuordnung dieses Geschäftspartners'; item.suggestionLayer = 'counterparty'; continue; }
      if (previous.size > 1) { item.suggestionReason = 'Mehrere bisherige Kategorien: bitte prüfen'; continue; }
      const suggestion = item.flowType === 'income' && item.sourceType === 'invoice'
        ? resolveEurCodeToLine(smallBusiness ? '111' : '112', 'Rechnungszahlung; bitte Kategorie prüfen', lines)
        : suggestEurLine(item, lines);
      item.suggestedLineId = suggestion.lineId; item.suggestionReason = suggestion.reason; item.suggestionLayer = suggestion.lineId ? 'keyword' : undefined;
    }
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
  sourceType: 'transaction' | 'invoice' | 'manual',
  sourceId: string,
  product: EurProduct = 'pro',
  taxYear = 2025,
): Promise<CashSource> => {
  const { from, to } = await assertServerEurProfile(db, scope, { taxYear });
  const sources = await listCashSources(db, scope, from, to, product);
  const normalizedSourceId = sourceId.trim();
  const source = sources.find((candidate) => {
    if (sourceType === 'manual') return candidate.sourceType === 'manual' && candidate.sourceId === normalizedSourceId;
    if (sourceType === 'invoice') return candidate.sourceType === 'invoice' && (candidate.sourceId === normalizedSourceId || candidate.invoiceId === normalizedSourceId);
    return candidate.sourceType === 'transaction' && (candidate.sourceId === normalizedSourceId || (candidate.classificationSourceIds ?? []).includes(normalizedSourceId));
  });
  if (!source) throw new Error('EUR_SOURCE_NOT_FOUND');
  return source;
};

export const getServerEurReport = async (db: PostgresQueryable, scope: TenantScope, args: { taxYear?: number; from?: string; to?: string; product?: EurProduct } = {}): Promise<ServerEurReportResult> => {
  const { taxYear, from, to } = await assertServerEurProfile(db, scope, args);
  const lines = await q<Record<string, unknown>>(db, `SELECT id,tax_year,kennziffer,provider_path,label,kind,exportable,sort_order,computed_from_json,computed_terms_json FROM eur_lines WHERE tax_year=$1 ORDER BY sort_order,id`, [taxYear]);
  // Existing server databases may not have been seeded with the newly bundled
  // 2026 print-form catalog yet.  Use the immutable shared catalog as a
  // read-only fallback for that year; retain the 2025 fail-closed behavior so
  // an unavailable legacy server schema is never silently masked.
  const catalogLines: EurCalculationLine[] = lines.length > 0
    ? lines.map((row) => ({
      id: String(row.id), kennziffer: row.kennziffer ? String(row.kennziffer) : undefined, providerPath: String(row.provider_path ?? 'main'), label: String(row.label), kind: row.kind as EurCalculationLine['kind'], exportable: Boolean(row.exportable), sortOrder: Number(row.sort_order),
      computedFromIds: parseJsonArray(row.computed_from_json)?.filter((id): id is string => typeof id === 'string'),
      computedTerms: parseJsonArray(row.computed_terms_json)?.filter((term): term is { id: string; sign: 1 | -1 } => Boolean(term && typeof term === 'object' && typeof (term as any).id === 'string' && ((term as any).sign === 1 || (term as any).sign === -1))),
    }))
    : taxYear === 2026
      ? getCatalogForYear(2026).map((line, sortOrder) => ({
        id: line.id,
        kennziffer: line.kennziffer || undefined,
        providerPath: line.providerPath ?? 'main',
        label: line.label,
        kind: line.kind,
        exportable: line.exportable,
        sortOrder,
        computedFromIds: line.computedFromIds,
        computedTerms: line.computedTerms,
      }))
      : (() => { throw new Error('EUR_SERVER_REPORT_UNAVAILABLE'); })();
  const sourceItems = await listServerEurCashItems(db, scope, { taxYear, from, to, product: args.product });
  const items: EurCalculationItem[] = [];
  for (const source of sourceItems) items.push({ sourceType: source.sourceType, sourceId: source.sourceId, amountNet: source.amountNet, flowType: source.flowType, kind: source.kind, splits: source.splits, lineId: source.classification?.eurLineId, excluded: source.classification?.excluded, warning: source.vatWarning, date: source.date });
  if (args.product === 'lite') {
    for (const source of sourceItems) {
      if (!source.classification?.eurLineId || source.classification.excluded || ['private-withdrawal', 'private-contribution', 'pass-through'].includes(source.kind ?? '') || !source.vatAmountCash) continue;
      const line = catalogLines.find((line) => line.kennziffer === (source.flowType === 'income' ? '140' : '185'));
      if (line) items.push({ sourceType: source.sourceType, sourceId: `${source.sourceId}:cash-vat`, amountNet: source.vatAmountCash, flowType: source.flowType, lineId: line.id, date: source.date });
    }
  }
  const calculation = calculateEurRows(catalogLines, items, { taxYear, from, to, requireCashDate: true });
  const manifest = getCatalogManifestForYear(taxYear);
  return { taxYear, from, to, ...calculation, catalog: { id: manifest.id, version: manifest.version, sourceHash: manifest.sha256, delivery: manifest.delivery, elsterReady: manifest.elsterReady } };
};
