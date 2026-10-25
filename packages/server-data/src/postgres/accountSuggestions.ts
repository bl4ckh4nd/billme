import {
  buildAccountSuggestionContextFrom,
  type AccountSuggestionContext,
  type AccountSuggestionRuleInput,
} from '@billme/finance-intelligence';
import type { TenantScope } from '@billme/server-core';
import type { PostgresQueryable } from './connection.js';

/** Advanced rule columns to the shared shape; legacy rows have none of them. */
export const advancedRuleFields = (row: { name?: string | null; stage?: string | null; logic?: string | null; conditionsJson?: string | null; actionsJson?: string | null; autoPost?: boolean | null; stopProcessing?: boolean | null }) => ({
  ...(row.name ? { name: row.name } : {}),
  stage: (row.stage === 'override' ? 'override' : 'base') as 'base' | 'override',
  logic: (row.logic === 'or' ? 'or' : 'and') as 'and' | 'or',
  ...(row.conditionsJson ? { conditions: JSON.parse(row.conditionsJson) } : {}),
  ...(row.actionsJson ? { actions: JSON.parse(row.actionsJson) } : {}),
  autoPost: Boolean(row.autoPost),
  stop: Boolean(row.stopProcessing),
});

const q = async <T>(db: PostgresQueryable, text: string, values: unknown[]): Promise<T[]> => (await db.query(text, values)).rows as T[];

/**
 * Loads the inputs of the shared account-suggestion pipeline from Postgres:
 * active rules and keywords of the active chart, posted bank bookings
 * (counterparty memory and Bayes training), and the chart's account numbers
 * for the fallback. Memory learns only the "other side" of a booking: callers
 * pass the role accounts (bank, Geldtransit, tax, receivables, payables), and
 * the tenant's own financial accounts and tax-case accounts are excluded here.
 */
export const loadAccountSuggestionContext = async (db: PostgresQueryable, scope: TenantScope, excludedAccounts: readonly string[] = []): Promise<AccountSuggestionContext> => {
  const tenantId = scope.tenantId;
  const policy = (await q<{ active_chart: string }>(db, `SELECT active_chart FROM accounting_policies WHERE tenant_id=$1`, [tenantId]))[0];
  const chart: 'SKR03' | 'SKR04' = policy?.active_chart === 'SKR04' ? 'SKR04' : 'SKR03';

  const [rules, keywords, bookings, accounts] = await Promise.all([
    q<{ id: string; priority: number; field: string; operator: string; value: string; target_account_number: string; flow_type: string; active: boolean; name: string | null; stage: string | null; logic: string | null; conditions_json: string | null; actions_json: string | null; auto_post: boolean | null; stop_processing: boolean | null }>(
      db,
      `SELECT id,priority,field,operator,value,target_account_number,flow_type,active,name,stage,logic,conditions_json,actions_json,auto_post,stop_processing FROM account_suggestion_rules WHERE tenant_id=$1 AND chart=$2 AND active=true ORDER BY priority,created_at`,
      [tenantId, chart],
    ),
    q<{ keyword: string; account_number: string }>(
      db,
      `SELECT keyword,account_number FROM account_keywords WHERE tenant_id=$1 AND chart=$2 AND active=true`,
      [tenantId, chart],
    ),
    q<{ counterparty: string; purpose: string; account_number: string }>(
      db,
      `SELECT bt.counterparty, bt.purpose, jl.account_number
         FROM journal_entries je
         JOIN journal_lines jl ON jl.entry_id=je.id AND jl.tenant_id=je.tenant_id
         JOIN booking_drafts bd ON bd.id=je.source_draft_id AND bd.tenant_id=je.tenant_id
         JOIN bank_transactions bt ON bt.id=bd.transaction_id AND bt.tenant_id=bd.tenant_id
         JOIN ledger_accounts la ON la.chart=$2 AND la.account_number=jl.account_number
        WHERE je.tenant_id=$1 AND je.status='posted' AND NOT (jl.account_number = ANY($3::text[]))
          AND jl.account_number NOT IN (SELECT default_skr_account_number FROM accounts WHERE tenant_id=$1 AND default_skr_account_number IS NOT NULL)
          AND jl.account_number NOT IN (SELECT account_number FROM tax_case_account_mappings WHERE (tenant_id=$1 OR tenant_id IS NULL) AND chart=$2)
        ORDER BY je.created_at DESC, jl.line_no`,
      [tenantId, chart, [...excludedAccounts]],
    ),
    q<{ account_number: string }>(db, `SELECT account_number FROM ledger_accounts WHERE chart=$1 ORDER BY account_number`, [chart]),
  ]);

  return buildAccountSuggestionContextFrom({
    chart,
    rules: rules.map((rule): AccountSuggestionRuleInput => ({
      chart,
      id: rule.id,
      ...advancedRuleFields({ name: rule.name, stage: rule.stage, logic: rule.logic, conditionsJson: rule.conditions_json, actionsJson: rule.actions_json, autoPost: rule.auto_post, stopProcessing: rule.stop_processing }),
      priority: Number(rule.priority),
      field: rule.field as AccountSuggestionRuleInput['field'],
      operator: rule.operator as AccountSuggestionRuleInput['operator'],
      value: rule.value,
      targetAccountNumber: rule.target_account_number,
      flowType: rule.flow_type as AccountSuggestionRuleInput['flowType'],
      active: Boolean(rule.active),
    })),
    keywords: keywords.map((row) => ({ keyword: row.keyword, accountNumber: row.account_number })),
    postedBankBookings: bookings.map((row) => ({ counterparty: row.counterparty ?? '', purpose: row.purpose ?? '', accountNumber: row.account_number })),
    chartAccountNumbers: accounts.map((row) => row.account_number),
  });
};
