import { normalizeGermanText, normalizeLooseText } from './text';
import { predictNaiveBayes, trainNaiveBayes, type NaiveBayesModel } from './naiveBayes';

/**
 * Account suggestion for a bank transaction, in fixed precedence:
 * explicit rule > remembered counterparty > naive Bayes > keyword > fallback.
 * Pure: callers load the context from their own store (SQLite desktop repo,
 * Postgres server repo) and pass it in.
 */

type FlowType = 'income' | 'expense';

export type AccountSuggestionLayer = 'rule' | 'counterparty' | 'bayes' | 'keyword' | 'fallback';

export interface AccountSuggestion {
  accountNumber?: string;
  reason?: string;
  layer?: AccountSuggestionLayer;
  confidence?: number;
}

export interface AccountSuggestionRuleInput {
  chart: 'SKR03' | 'SKR04';
  priority: number;
  field: 'counterparty' | 'purpose' | 'any';
  operator: 'contains' | 'equals' | 'startsWith';
  value: string;
  targetAccountNumber: string;
  flowType: 'income' | 'expense' | 'any';
  active: boolean;
}

export interface AccountSuggestionContext {
  chart: 'SKR03' | 'SKR04';
  rules: AccountSuggestionRuleInput[];
  keywordMap: Map<string, string[]>;
  counterpartyMemory: Map<string, string>;
  bayesModel: NaiveBayesModel | null;
  fallbackIncomeAccount?: string;
  fallbackExpenseAccount?: string;
}

/** Raw inputs as a store returns them; `buildAccountSuggestionContextFrom` shapes them. */
export interface AccountSuggestionSources {
  chart: 'SKR03' | 'SKR04';
  rules: AccountSuggestionRuleInput[];
  keywords: Array<{ keyword: string; accountNumber: string }>;
  /** Posted bookings from bank transactions, newest first. */
  postedBankBookings: Array<{ counterparty: string; purpose: string; accountNumber: string }>;
  /** Account numbers of the chart, ascending. */
  chartAccountNumbers: string[];
}

export const MIN_BAYES_TRAINING_EXAMPLES = 20;
const MIN_BAYES_CONFIDENCE = 0.6;

export const normalizeSuggestionText = (value: string): string => normalizeLooseText(normalizeGermanText(value));

export const buildAccountSuggestionContextFrom = (sources: AccountSuggestionSources): AccountSuggestionContext => {
  const keywordMap = new Map<string, string[]>();
  for (const row of sources.keywords) {
    const key = normalizeSuggestionText(row.keyword);
    if (!key) continue;
    const list = keywordMap.get(key) ?? [];
    if (!list.includes(row.accountNumber)) list.push(row.accountNumber);
    keywordMap.set(key, list);
  }
  const counterpartyMemory = new Map<string, string>();
  for (const row of sources.postedBankBookings) {
    const key = normalizeSuggestionText(row.counterparty);
    if (key && !counterpartyMemory.has(key)) counterpartyMemory.set(key, row.accountNumber);
  }
  const training = sources.postedBankBookings.map((row) => ({
    text: `${row.counterparty || ''} ${row.purpose || ''}`.trim(),
    classId: row.accountNumber,
  }));
  const firstWith = (prefixes: string[]) => sources.chartAccountNumbers.find((n) => prefixes.some((p) => n.startsWith(p)));
  return {
    chart: sources.chart,
    rules: sources.rules.filter((rule) => rule.active && rule.chart === sources.chart).sort((a, b) => a.priority - b.priority),
    keywordMap,
    counterpartyMemory,
    bayesModel: trainNaiveBayes(training, MIN_BAYES_TRAINING_EXAMPLES),
    fallbackIncomeAccount: firstWith(['8', '9']),
    fallbackExpenseAccount: firstWith(['4', '5', '6', '7']),
  };
};

type Item = { flowType: FlowType; counterparty: string; purpose: string };

/** Whether a rule's condition fits a bank item; shared by suggestion and hit statistics. */
export const accountSuggestionRuleMatches = (
  rule: Pick<AccountSuggestionRuleInput, 'field' | 'operator' | 'value' | 'flowType'>,
  item: Item,
): boolean => {
  if (rule.flowType !== 'any' && rule.flowType !== item.flowType) return false;
  const fields: string[] = [];
  if (rule.field === 'counterparty' || rule.field === 'any') fields.push(item.counterparty);
  if (rule.field === 'purpose' || rule.field === 'any') fields.push(item.purpose);
  const needle = normalizeSuggestionText(rule.value);
  return fields.some((fieldValue) => {
    const hay = normalizeSuggestionText(fieldValue);
    if (rule.operator === 'contains') return hay.includes(needle);
    if (rule.operator === 'equals') return hay === needle;
    return hay.startsWith(needle);
  });
};

const byRule = (ctx: AccountSuggestionContext, item: Item): AccountSuggestion => {
  for (const rule of ctx.rules) {
    if (accountSuggestionRuleMatches(rule, item)) return { accountNumber: rule.targetAccountNumber, reason: `Regel: "${rule.value}"`, layer: 'rule', confidence: 0.99 };
  }
  return {};
};

const byCounterpartyMemory = (ctx: AccountSuggestionContext, counterparty: string): AccountSuggestion => {
  const accountNumber = ctx.counterpartyMemory.get(normalizeSuggestionText(counterparty));
  return accountNumber
    ? { accountNumber, reason: `Gemerkte Gegenpartei: "${counterparty}"`, layer: 'counterparty', confidence: 0.9 }
    : {};
};

const byBayes = (ctx: AccountSuggestionContext, item: Item): AccountSuggestion => {
  if (!ctx.bayesModel) return {};
  const result = predictNaiveBayes(ctx.bayesModel, `${item.counterparty || ''} ${item.purpose || ''}`.trim(), MIN_BAYES_CONFIDENCE);
  return result
    ? { accountNumber: result.classId, reason: `KI-Vorschlag (${Math.round(result.confidence * 100)}%)`, layer: 'bayes', confidence: result.confidence }
    : {};
};

const byKeyword = (ctx: AccountSuggestionContext, item: Item): AccountSuggestion => {
  const text = normalizeSuggestionText(`${item.counterparty || ''} ${item.purpose || ''}`);
  if (!text) return {};
  const hits = new Map<string, number>();
  for (const [keyword, accounts] of ctx.keywordMap.entries()) {
    if (!text.includes(keyword)) continue;
    for (const acc of accounts) hits.set(acc, (hits.get(acc) ?? 0) + 1);
  }
  const best = [...hits.entries()].sort((a, b) => (a[1] !== b[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))[0];
  return best
    ? { accountNumber: best[0], reason: `Stichworttreffer (${best[1]})`, layer: 'keyword', confidence: Math.min(0.85, 0.45 + best[1] * 0.1) }
    : {};
};

const byFallback = (ctx: AccountSuggestionContext, flowType: FlowType): AccountSuggestion => {
  const accountNumber = flowType === 'income' ? ctx.fallbackIncomeAccount : ctx.fallbackExpenseAccount;
  return accountNumber ? { accountNumber, reason: 'Fallback nach Buchungstyp', layer: 'fallback', confidence: 0.3 } : {};
};

export const suggestAccountForTransaction = (ctx: AccountSuggestionContext, item: Item): AccountSuggestion => {
  const fromRule = byRule(ctx, item);
  if (fromRule.accountNumber) return fromRule;
  const fromMemory = byCounterpartyMemory(ctx, item.counterparty);
  if (fromMemory.accountNumber) return fromMemory;
  const fromBayes = byBayes(ctx, item);
  if (fromBayes.accountNumber) return fromBayes;
  const fromKeyword = byKeyword(ctx, item);
  if (fromKeyword.accountNumber) return fromKeyword;
  return byFallback(ctx, item.flowType);
};
