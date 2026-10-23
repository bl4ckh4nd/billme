import { normalizeGermanText, normalizeLooseText } from './text';

/**
 * Booking rules: conditions on a bank line, and a result that is a full
 * Buchungssatz proposal (account, tax case, deductible share, flow type, memo).
 *
 * Two stages, in priority order:
 * - base: the first matching base rule sets the proposal; lower layers
 *   (memory, Bayes, keywords) only run when no base rule set an account.
 * - override: every matching override then changes the fields it sets, in
 *   priority order, on top of whatever the base stage or a lower layer proposed.
 * A matching rule with `stop` ends the chain. The trace lists every active rule.
 */

export type RuleConditionField = 'counterparty' | 'purpose' | 'any' | 'iban' | 'amount' | 'account';
export type RuleConditionOperator = 'contains' | 'equals' | 'startsWith' | 'regex' | 'gte' | 'lte' | 'between';

export interface RuleCondition {
  field: RuleConditionField;
  operator: RuleConditionOperator;
  value: string;
  /** Upper bound for `between`. */
  valueTo?: string;
}

export interface BookingRuleActions {
  accountNumber?: string;
  taxCaseKey?: string;
  /** Share of the Vorsteuer that is deductible, 0–100. The rest stays on the expense. */
  deductiblePercent?: number;
  /** Income or expense side, when it differs from the sign (e.g. a refund on an expense account). */
  flowType?: 'income' | 'expense';
  /** Booking text; `{Gegenpartei}` and `{Verwendungszweck}` are filled in. */
  memo?: string;
}

export interface BookingRule {
  id?: string;
  name?: string;
  priority: number;
  stage?: 'base' | 'override';
  logic?: 'and' | 'or';
  /** Sign of the bank line: income = money in. */
  flowType: 'income' | 'expense' | 'any';
  conditions?: RuleCondition[];
  actions?: BookingRuleActions;
  autoPost?: boolean;
  stop?: boolean;
  active: boolean;
  /** Legacy single condition and target, still stored for the older rule list. */
  field?: 'counterparty' | 'purpose' | 'any';
  operator?: 'contains' | 'equals' | 'startsWith';
  value?: string;
  targetAccountNumber?: string;
}

export interface BookingRuleItem {
  flowType: 'income' | 'expense';
  counterparty: string;
  purpose: string;
  /** Signed bank amount. */
  amount?: number;
  /** Own financial account id. */
  accountId?: string;
  counterpartyIban?: string | null;
}

export interface RuleTraceEntry {
  ruleId?: string;
  name: string;
  stage: 'base' | 'override';
  matched: boolean;
  applied: Array<keyof BookingRuleActions>;
  skipped?: 'stopped' | 'base_already_set';
}

export interface BookingRuleOutcome {
  actions: BookingRuleActions;
  /** The rule that set the account, if any. */
  accountRule?: BookingRule;
  matchedRules: BookingRule[];
  trace: RuleTraceEntry[];
}

const MAX_REGEX_LENGTH = 200;
const MAX_TEXT_LENGTH = 500;

const normalize = (value: string): string => normalizeLooseText(normalizeGermanText(value));

/** German or plain decimal ("1.234,50", "1234.5") to cents; NaN when unreadable. */
export const parseRuleAmount = (value: string): number => {
  const text = value.trim().replace(/\s|€/g, '');
  const decimal = /,\d{1,2}$/.test(text) ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  return Math.round(Number(decimal) * 100);
};

/** Rejects patterns the engine would refuse at match time, so the editor can say why. */
export const ruleRegexError = (pattern: string): string | undefined => {
  if (pattern.length > MAX_REGEX_LENGTH) return `Höchstens ${MAX_REGEX_LENGTH} Zeichen.`;
  // Nested quantifiers like (a+)+ can backtrack for minutes; rules run on the shared server.
  if (/\([^)]*[+*}][^)]*\)\s*[+*{]/.test(pattern)) return 'Verschachtelte Wiederholungen wie (a+)+ sind nicht erlaubt.';
  try {
    new RegExp(pattern, 'iu');
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'Ungültiger regulärer Ausdruck.';
  }
};

export const ruleConditions = (rule: BookingRule): RuleCondition[] =>
  rule.conditions?.length
    ? rule.conditions
    : rule.field && rule.operator && rule.value ? [{ field: rule.field, operator: rule.operator, value: rule.value }] : [];

export const ruleActions = (rule: BookingRule): BookingRuleActions =>
  rule.actions ?? (rule.targetAccountNumber ? { accountNumber: rule.targetAccountNumber } : {});

export const ruleName = (rule: BookingRule): string => rule.name?.trim() || rule.value || 'Regel';

const textMatches = (condition: RuleCondition, text: string): boolean => {
  const raw = text.slice(0, MAX_TEXT_LENGTH);
  if (condition.operator === 'regex') {
    if (ruleRegexError(condition.value)) return false;
    return new RegExp(condition.value, 'iu').test(raw) || new RegExp(condition.value, 'iu').test(normalize(raw));
  }
  const hay = normalize(raw);
  const needle = normalize(condition.value);
  if (!needle) return false;
  if (condition.operator === 'contains') return hay.includes(needle);
  if (condition.operator === 'equals') return hay === needle;
  if (condition.operator === 'startsWith') return hay.startsWith(needle);
  return false;
};

const conditionMatches = (condition: RuleCondition, item: BookingRuleItem): boolean => {
  switch (condition.field) {
    case 'counterparty':
      return textMatches(condition, item.counterparty);
    case 'purpose':
      return textMatches(condition, item.purpose);
    case 'any':
      return textMatches(condition, item.counterparty) || textMatches(condition, item.purpose);
    case 'iban':
      return Boolean(item.counterpartyIban) && (item.counterpartyIban ?? '').replace(/\s/g, '').toUpperCase() === condition.value.replace(/\s/g, '').toUpperCase();
    case 'account':
      return item.accountId === condition.value;
    case 'amount': {
      if (item.amount === undefined) return false;
      const amount = Math.abs(Math.round(item.amount * 100));
      const value = parseRuleAmount(condition.value);
      if (Number.isNaN(value)) return false;
      if (condition.operator === 'gte') return amount >= value;
      if (condition.operator === 'lte') return amount <= value;
      if (condition.operator === 'between') {
        const upper = parseRuleAmount(condition.valueTo ?? '');
        return !Number.isNaN(upper) && amount >= value && amount <= upper;
      }
      return amount === value;
    }
    default:
      return false;
  }
};

/** Whether a rule's conditions fit a bank line; shared by suggestion, hit statistics and the editor's live test. */
export const bookingRuleMatches = (rule: BookingRule, item: BookingRuleItem): boolean => {
  if (rule.flowType !== 'any' && rule.flowType !== item.flowType) return false;
  const conditions = ruleConditions(rule);
  if (conditions.length === 0) return false;
  return rule.logic === 'or'
    ? conditions.some((condition) => conditionMatches(condition, item))
    : conditions.every((condition) => conditionMatches(condition, item));
};

const setFields = (actions: BookingRuleActions): Array<keyof BookingRuleActions> =>
  (['accountNumber', 'taxCaseKey', 'deductiblePercent', 'flowType', 'memo'] as const).filter((key) => actions[key] !== undefined && actions[key] !== '');

/** Runs base stage then overrides; `rules` must be active rules of one chart. */
export const evaluateBookingRules = (rules: readonly BookingRule[], item: BookingRuleItem): BookingRuleOutcome => {
  const sorted = [...rules].filter((rule) => rule.active).sort((a, b) => a.priority - b.priority);
  const trace: RuleTraceEntry[] = [];
  const matchedRules: BookingRule[] = [];
  let actions: BookingRuleActions = {};
  let accountRule: BookingRule | undefined;
  let stopped = false;
  let baseDone = false;

  for (const stage of ['base', 'override'] as const) {
    for (const rule of sorted.filter((candidate) => (candidate.stage ?? 'base') === stage)) {
      const entry: RuleTraceEntry = { ruleId: rule.id, name: ruleName(rule), stage, matched: false, applied: [] };
      trace.push(entry);
      if (stopped) { entry.skipped = 'stopped'; continue; }
      if (stage === 'base' && baseDone) { entry.skipped = 'base_already_set'; continue; }
      if (!bookingRuleMatches(rule, item)) continue;
      entry.matched = true;
      matchedRules.push(rule);
      const own = ruleActions(rule);
      entry.applied = setFields(own);
      for (const key of entry.applied) (actions as Record<string, unknown>)[key] = own[key];
      if (own.accountNumber) accountRule = rule;
      if (stage === 'base') baseDone = true;
      if (rule.stop) stopped = true;
    }
  }
  return { actions, accountRule, matchedRules, trace };
};

export const fillRuleMemo = (memo: string, item: Pick<BookingRuleItem, 'counterparty' | 'purpose'>): string =>
  memo.replaceAll('{Gegenpartei}', item.counterparty).replaceAll('{Verwendungszweck}', item.purpose).replace(/\s+/g, ' ').trim();
