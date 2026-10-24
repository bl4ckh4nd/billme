import type { PostgresQueryable } from './connection.js';

/**
 * Which ledger account a tax case books on, per role. One place for revenue, VAT (due, not yet due under Ist),
 * input VAT, granted Skonto and customer advances, so the issuing path, the payment path, the settlement
 * commands and the bank draft ask the same question and get the same answer.
 *
 * Every account is a role of `accounting_account_mappings` with a chart default below, so a tenant can map it
 * to another account of its chart; a `tax_case_account_mappings` row for the case and role wins over both.
 * Numbers are those of the shipped SKR catalogue (canonicalLedgerCatalog.ts, migrations 0029, 0045 and 0047).
 * Self-assessed purchases (§ 13b, innergemeinschaftlicher Erwerb) book the USt the buyer owes and the same amount as
 * Vorsteuer: `output_tax`/`input_tax` of those cases resolve to the § 13b and Erwerb accounts.
 */
export type LedgerChart = 'SKR03' | 'SKR04';

export const ACCOUNT_ROLE_DEFAULTS: Record<LedgerChart, Record<string, string>> = {
  SKR03: {
    accounts_receivable: '1400', accounts_payable: '1600', bank: '1200', revenue: '8400', expense: '4900', asset: '0480',
    output_vat: '1776', output_vat_deferred: '1765', input_vat: '1576', cash: '1000',
    output_vat_7: '1771', output_vat_deferred_7: '1760', input_vat_7: '1571',
    revenue_7: '8300', revenue_small_business: '8195', revenue_exempt: '8100', revenue_rc_13b: '8337', revenue_eu_supply: '8125',
    revenue_eu_service: '8336', revenue_export: '8120', revenue_outside_scope: '8338',
    cash_discount_granted: '8736', cash_discount_granted_7: '8731',
    customer_advances: '1718', customer_advances_7: '1711',
    dunning_fees: '2700', late_interest: '2650',
    input_vat_rc_13b: '1577', output_vat_rc_13b: '1787', input_vat_ige: '1574', output_vat_ige: '1774', input_vat_ige_7: '1572', output_vat_ige_7: '1772',
  },
  SKR04: {
    accounts_receivable: '1200', accounts_payable: '3300', bank: '1800', revenue: '4400', expense: '6300', asset: '0670',
    output_vat: '3806', output_vat_deferred: '3815', input_vat: '1406', cash: '1600',
    output_vat_7: '3801', output_vat_deferred_7: '3810', input_vat_7: '1401',
    revenue_7: '4300', revenue_small_business: '4185', revenue_exempt: '4100', revenue_rc_13b: '4337', revenue_eu_supply: '4125',
    revenue_eu_service: '4336', revenue_export: '4120', revenue_outside_scope: '4338',
    cash_discount_granted: '4736', cash_discount_granted_7: '4731',
    customer_advances: '3272', customer_advances_7: '3260',
    dunning_fees: '4830', late_interest: '7100',
    input_vat_rc_13b: '1407', output_vat_rc_13b: '3837', input_vat_ige: '1404', output_vat_ige: '3804', input_vat_ige_7: '1402', output_vat_ige_7: '3802',
  },
};

export const accountRoleMappings = async (db: PostgresQueryable, tenantId: string, chart: LedgerChart): Promise<Record<string, string>> => {
  const rows = (await db.query(`SELECT role,account_number FROM accounting_account_mappings WHERE tenant_id=$1 AND chart=$2`, [tenantId, chart])).rows as Array<{ role: string; account_number: string }>;
  const out = { ...ACCOUNT_ROLE_DEFAULTS[chart] };
  for (const row of rows) if (row.role in out) out[row.role] = row.account_number;
  return out;
};

/** The account kinds a tax case answers for. */
export type TaxAccountRole = 'output_tax' | 'input_tax' | 'output_tax_deferred' | 'revenue' | 'cash_discount' | 'customer_advance';

const BASE_ROLE: Record<TaxAccountRole, string> = {
  output_tax: 'output_vat', input_tax: 'input_vat', output_tax_deferred: 'output_vat_deferred', revenue: 'revenue', cash_discount: 'cash_discount_granted', customer_advance: 'customer_advances',
};
const SELF_ASSESSED_OUTPUT = { DE_RC_13B_DOMESTIC: 'output_vat_rc_13b', EU_B2B_SERVICE_RC: 'output_vat_rc_13b', NON_EU_SERVICE_RC: 'output_vat_rc_13b', EU_IGE_GOODS_RC: 'output_vat_ige' };
const SELF_ASSESSED_INPUT = { DE_RC_13B_DOMESTIC: 'input_vat_rc_13b', EU_B2B_SERVICE_RC: 'input_vat_rc_13b', NON_EU_SERVICE_RC: 'input_vat_rc_13b', EU_IGE_GOODS_RC: 'input_vat_ige' };
const ROLE_BY_CASE: Record<TaxAccountRole, Record<string, string>> = {
  output_tax: { DE_STD_7: 'output_vat_7', ...SELF_ASSESSED_OUTPUT },
  input_tax: { DE_STD_7: 'input_vat_7', ...SELF_ASSESSED_INPUT },
  output_tax_deferred: { DE_STD_7: 'output_vat_deferred_7' },
  revenue: {
    DE_STD_7: 'revenue_7', DE_KU19: 'revenue_small_business', DE_ZERO_EXEMPT: 'revenue_exempt', DE_RC_13B_DOMESTIC: 'revenue_rc_13b',
    EU_IGL_GOODS_0: 'revenue_eu_supply', EU_B2B_SERVICE_RC: 'revenue_eu_service', NON_EU_EXPORT_0: 'revenue_export', NON_EU_SERVICE_OUTSIDE_SCOPE: 'revenue_outside_scope',
  },
  cash_discount: { DE_STD_7: 'cash_discount_granted_7' },
  customer_advance: { DE_STD_7: 'customer_advances_7' },
};
/** Skonto on a sale without German VAT reduces that sale's own revenue account (no Skonto account per case). */
const CASH_DISCOUNT_CASES = new Set(['DE_STD_19', 'DE_STD_7']);

/**
 * The account of `role` for a tax case on `date`: a tax-case mapping (tenant, then global), else the role of the
 * case (e.g. `input_vat_7` for DE_STD_7), else `fallback` for output/input tax (the caller's general VAT account),
 * else the base role. Callers that only know the general account (`m.input_vat`, `m.output_vat`) still get the
 * 7 % account for DE_STD_7.
 */
export const taxCaseAccount = async (db: PostgresQueryable, tenantId: string, chart: string, taxCaseKey: string | undefined, role: TaxAccountRole, fallback?: string, date?: string, rate?: number): Promise<string> => {
  const roles = await accountRoleMappings(db, tenantId, chart === 'SKR04' ? 'SKR04' : 'SKR03');
  if (taxCaseKey) {
    const rows = (await db.query(`SELECT account_number FROM tax_case_account_mappings WHERE (tenant_id=$1 OR tenant_id IS NULL) AND chart=$2 AND tax_case_key=$3 AND role=$4 AND (valid_from IS NULL OR valid_from <= COALESCE($5,CURRENT_DATE::text)) AND (valid_to IS NULL OR valid_to >= COALESCE($5,CURRENT_DATE::text)) ORDER BY (tenant_id IS NULL) ASC, valid_from DESC NULLS LAST, updated_at DESC LIMIT 1`, [tenantId, chart, taxCaseKey, role, date ?? null])).rows as Array<{ account_number: string }>;
    if (rows[0]?.account_number) return rows[0].account_number;
    if (role === 'cash_discount' && !CASH_DISCOUNT_CASES.has(taxCaseKey)) return taxCaseAccount(db, tenantId, chart, taxCaseKey, 'revenue', undefined, date, rate);
    // The Erwerb at 7 % has its own pair of accounts; the case alone does not say which rate it is.
    const caseRole = rate === 7 && taxCaseKey === 'EU_IGE_GOODS_RC' && (role === 'output_tax' || role === 'input_tax') ? `${ROLE_BY_CASE[role][taxCaseKey]}_7` : ROLE_BY_CASE[role][taxCaseKey];
    if (caseRole && roles[caseRole]) return roles[caseRole];
  }
  return fallback ?? roles[BASE_ROLE[role]];
};
