import {
  buildAccountSuggestionContextFrom,
  type AccountSuggestionContext,
  type AccountSuggestionRuleInput,
} from '@billme/finance-intelligence';
import type { TenantScope } from '@billme/server-core';
import type { PostgresQueryable } from './connection.js';

const q = async <T>(db: PostgresQueryable, text: string, values: unknown[]): Promise<T[]> => (await db.query(text, values)).rows as T[];

/**
 * Loads the inputs of the shared account-suggestion pipeline from Postgres:
 * active rules and keywords of the active chart, posted bank bookings on
 * revenue/expense accounts (counterparty memory and Bayes training), and the
 * chart's account numbers for the fallback. Mirrors the desktop SQLite loader.
 */
export const loadAccountSuggestionContext = async (db: PostgresQueryable, scope: TenantScope): Promise<AccountSuggestionContext> => {
  const tenantId = scope.tenantId;
  const policy = (await q<{ active_chart: string }>(db, `SELECT active_chart FROM accounting_policies WHERE tenant_id=$1`, [tenantId]))[0];
  const chart: 'SKR03' | 'SKR04' = policy?.active_chart === 'SKR04' ? 'SKR04' : 'SKR03';

  const [rules, keywords, bookings, accounts] = await Promise.all([
    q<{ priority: number; field: string; operator: string; value: string; target_account_number: string; flow_type: string; active: boolean }>(
      db,
      `SELECT priority,field,operator,value,target_account_number,flow_type,active FROM account_suggestion_rules WHERE tenant_id=$1 AND chart=$2 AND active=true ORDER BY priority,created_at`,
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
        WHERE je.tenant_id=$1 AND je.status='posted' AND (jl.account_number LIKE '4%' OR jl.account_number LIKE '8%')
        ORDER BY je.created_at DESC`,
      [tenantId, chart],
    ),
    q<{ account_number: string }>(db, `SELECT account_number FROM ledger_accounts WHERE chart=$1 ORDER BY account_number`, [chart]),
  ]);

  return buildAccountSuggestionContextFrom({
    chart,
    rules: rules.map((rule): AccountSuggestionRuleInput => ({
      chart,
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
