import type {
  AccountingSourceFact,
  AccrualInput,
  AccrualPeriod,
  AccrualSchedule,
  CarryForwardInput,
  CarryForwardResult,
  ClosingDomainError,
  ClosingDomainResult,
  FiscalCloseInput,
  FiscalCloseResult,
  FxValuationInput,
  FxValuationResult,
  InventoryClosingInput,
  InventoryClosingResult,
  InventoryClosingValuation,
  JournalCommand,
  LoanSchedule,
  LoanScheduleInput,
  LoanSchedulePeriod,
  PayrollBatchInput,
  PayrollBatchValidation,
  ProvisionInput,
  RollForwardInput,
  RollForwardReconciliation,
  ShareholderFlowInput,
  ShareholderFlowValidation,
  SourceFactLine,
} from '@billme/accounting-shared';
import { fiscalYearForDate } from '@billme/accounting-shared';
import type { JournalEntry, LedgerBalance } from '@billme/accounting-shared';

const CENTS = 100;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

const error = (code: ClosingDomainError['code'], message: string, field?: string): ClosingDomainError => ({
  code,
  message,
  field,
  blocking: true,
});

const cents = (value: number): number | null => {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value * CENTS);
  return Math.abs(value * CENTS - rounded) < 1e-7 ? rounded : null;
};

const euros = (value: number): number => value / CENTS;

const dateValue = (value: string): Date | null => {
  if (!ISO_DATE.test(value)) return null;
  const result = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(result.getTime()) || result.toISOString().slice(0, 10) !== value ? null : result;
};

const periodForDate = (value: string): string => value.slice(0, 7);

const fiscalBoundaryErrors = (
  date: string,
  fiscalYear: number,
  fiscalYearStart: string | undefined,
): ClosingDomainError[] => {
  if (!Number.isInteger(fiscalYear) || fiscalYear < 1 || !dateValue(date)) return [];
  try {
    if (fiscalYearForDate(date, fiscalYearStart ?? '01-01') !== fiscalYear) {
      return [error('PERIOD_MISMATCH', 'Fiscal year does not contain the posting date.', 'fiscalYear')];
    }
  } catch {
    return [error('INVALID_FISCAL_YEAR', 'Fiscal year start must be a valid MM-DD date.', 'fiscalYearStart')];
  }
  return [];
};

const currency = (value: string): boolean => /^[A-Z]{3}$/.test(value);

/**
 * Identity values are framed instead of concatenated.  The length prefix is
 * deliberately boring: unlike a delimiter, it remains injective for source
 * values that contain punctuation (and it works in every runtime importing
 * the pure accounting engine).
 */
const frame = (value: string): string => `${value.length}:${value}`;

export interface JournalIdentityContext {
  tenantId?: string;
}

export const journalSourceIdentity = (
  tenantId: string | undefined,
  sourceType: string,
  sourceId: string,
  sourceRevision: string,
): string => `source:${[tenantId ?? 'default', sourceType, sourceId, sourceRevision].map(frame).join('')}`;

const sourceKey = (
  sourceType: string,
  sourceId: string,
  sourceRevision: string,
  context: JournalIdentityContext = {},
): string => journalSourceIdentity(context.tenantId, sourceType, sourceId, sourceRevision);

const invalidResult = <T>(errors: ClosingDomainError[], idempotencyKey?: string): ClosingDomainResult<T> => ({
  status: 'rejected',
  errors,
  idempotencyKey,
});

const accountMap = (balances: readonly LedgerBalance[]): Map<string, number> => {
  const map = new Map<string, number>();
  for (const balance of balances) {
    const amount = cents(balance.closingBalance ?? (balance.openingBalance + balance.debitTurnover - balance.creditTurnover));
    if (amount === null) continue;
    map.set(balance.accountNumber, (map.get(balance.accountNumber) ?? 0) + amount);
  }
  return map;
};

const netMovement = (balance: LedgerBalance): number =>
  (balance.debitTurnover ?? 0) - (balance.creditTurnover ?? 0);

const line = (accountNumber: string, debitCents: number, creditCents: number, memo?: string): SourceFactLine => ({
  accountNumber,
  debitAmount: euros(debitCents),
  creditAmount: euros(creditCents),
  memo,
});

const sourceFactErrors = (fact: AccountingSourceFact): ClosingDomainError[] => {
  const issues: ClosingDomainError[] = [];
  if (!fact.sourceId.trim()) issues.push(error('MISSING_SOURCE_ID', 'Source id is required.', 'sourceId'));
  if (!fact.sourceRevision.trim()) issues.push(error('MISSING_SOURCE_REVISION', 'Source revision is required.', 'sourceRevision'));
  if (!dateValue(fact.effectiveDate) || !dateValue(fact.postingDate)) issues.push(error('INVALID_DATE', 'Effective and posting dates must be valid ISO dates.', 'effectiveDate'));
  if (!ISO_PERIOD.test(fact.period)) issues.push(error('INVALID_PERIOD', 'Period must use YYYY-MM.', 'period'));
  if (ISO_DATE.test(fact.postingDate) && ISO_PERIOD.test(fact.period) && periodForDate(fact.postingDate) !== fact.period) {
    issues.push(error('PERIOD_MISMATCH', 'Posting date does not belong to period.', 'period'));
  }
  if (!Number.isInteger(fact.fiscalYear) || fact.fiscalYear < 1) issues.push(error('INVALID_FISCAL_YEAR', 'Fiscal year must be positive.', 'fiscalYear'));
  else issues.push(...fiscalBoundaryErrors(fact.postingDate, fact.fiscalYear, fact.fiscalYearStart));
  if (!currency(fact.currency)) issues.push(error('INVALID_CURRENCY', 'Currency must be a three-letter uppercase ISO code.', 'currency'));
  if (!fact.bookingText.trim()) issues.push(error('INVALID_LINE', 'Booking text is required.', 'bookingText'));
  if (!fact.lines.length) issues.push(error('INVALID_LINE', 'At least one journal line is required.', 'lines'));

  let debit = 0;
  let credit = 0;
  fact.lines.forEach((item, index) => {
    const debitCents = cents(item.debitAmount);
    const creditCents = cents(item.creditAmount);
    if (!item.accountNumber.trim()) issues.push(error('INVALID_ACCOUNT', 'Account number is required.', `lines.${index}.accountNumber`));
    if (debitCents === null || creditCents === null) {
      issues.push(error('INVALID_AMOUNT', 'Journal amounts must be finite cent values.', `lines.${index}`));
      return;
    }
    if (debitCents < 0 || creditCents < 0) issues.push(error('NEGATIVE_AMOUNT', 'Journal amounts cannot be negative.', `lines.${index}`));
    if ((debitCents > 0) === (creditCents > 0)) issues.push(error('INVALID_LINE', 'A line must contain either debit or credit.', `lines.${index}`));
    debit += debitCents;
    credit += creditCents;
  });
  if (debit !== credit) issues.push(error('UNBALANCED_ENTRY', 'Debit and credit must match exactly to the cent.'));
  return issues;
};

export const validateSourceFact = (fact: AccountingSourceFact): ClosingDomainError[] => sourceFactErrors(fact);

/** Build a deterministic, immutable journal command from any source fact. */
export const buildJournalCommand = (
  fact: AccountingSourceFact,
  existingIdempotencyKeys: readonly string[] = [],
  context: JournalIdentityContext = {},
): ClosingDomainResult<JournalCommand> => {
  const idempotencyKey = sourceKey(fact.sourceType, fact.sourceId, fact.sourceRevision, context);
  const issues = sourceFactErrors(fact);
  if (issues.length) return invalidResult(issues, idempotencyKey);
  if (existingIdempotencyKeys.includes(idempotencyKey)) return { status: 'duplicate', errors: [], idempotencyKey };

  const commandId = `journal-command:${idempotencyKey.slice('source:'.length)}`;
  const entry: JournalEntry = {
    id: commandId,
    postingDate: fact.postingDate,
    documentDate: fact.effectiveDate,
    bookingText: fact.bookingText,
    reference: fact.reference,
    period: fact.period,
    fiscalYear: fact.fiscalYear,
    status: 'posted',
    sourceType: fact.sourceType,
    // Journal source identity includes the immutable revision.  A schedule
    // emits several entries for one source id, so source id alone collides
    // with the append-only journal uniqueness constraint.
    sourceKey: idempotencyKey,
    lines: fact.lines.map((item, index) => ({
      id: `${commandId}:line:${index + 1}`,
      accountNumber: item.accountNumber,
      debitAmount: euros(cents(item.debitAmount)!),
      creditAmount: euros(cents(item.creditAmount)!),
      memo: item.memo,
    })),
  };
  return {
    status: 'ready',
    errors: [],
    idempotencyKey,
    value: {
      commandId,
      idempotencyKey,
      immutableRevision: fact.sourceRevision,
      effectiveDate: fact.effectiveDate,
      currency: fact.currency,
      source: { sourceType: fact.sourceType, sourceId: fact.sourceId, sourceRevision: fact.sourceRevision },
      entry,
    },
  };
};

export const validateAndBuildJournalCommand = buildJournalCommand;
export const buildSourcePostingCommand = buildJournalCommand;

const source = (
  type: AccountingSourceFact['sourceType'],
  id: string,
  revision: string,
  effectiveDate: string,
  period: string,
  fiscalYear: number,
  currencyCode: string,
  lines: readonly SourceFactLine[],
  bookingText: string,
  fiscalYearStart?: string,
): AccountingSourceFact => ({
  sourceType: type,
  sourceId: id,
  sourceRevision: revision,
  effectiveDate,
  postingDate: effectiveDate,
  period,
  fiscalYear,
  fiscalYearStart,
  currency: currencyCode,
  lines,
  bookingText,
});

const mapError = <T>(result: ClosingDomainResult<JournalCommand>, value?: T): ClosingDomainResult<T> => ({
  status: result.status,
  errors: result.errors,
  idempotencyKey: result.idempotencyKey,
  ...(result.status === 'ready' && value !== undefined ? { value } : {}),
});

const mapBalances = (balances: readonly LedgerBalance[], accountNumbers: readonly string[]): Map<string, number> => {
  const selected = new Set(accountNumbers);
  return new Map([...accountMap(balances)].filter(([account]) => selected.has(account)));
};

/** Return exact account differences for opening + movements = closing. */
export const reconcileRollForward = (input: RollForwardInput): RollForwardReconciliation => {
  const opening = accountMap(input.opening);
  const movements = new Map<string, number>();
  for (const balance of input.movements) {
    movements.set(balance.accountNumber, (movements.get(balance.accountNumber) ?? 0) + Math.round(netMovement(balance) * CENTS));
  }
  const closing = accountMap(input.closing);
  const accounts = new Set([...opening.keys(), ...movements.keys(), ...closing.keys()]);
  const differences: Array<{ accountNumber: string; difference: number }> = [];
  for (const account of accounts) {
    const difference = (opening.get(account) ?? 0) + (movements.get(account) ?? 0) - (closing.get(account) ?? 0);
    if (difference) differences.push({ accountNumber: account, difference: euros(difference) });
  }
  return { balanced: differences.length === 0, differences };
};

export const buildFiscalClose = (input: FiscalCloseInput, context: JournalIdentityContext = {}): ClosingDomainResult<FiscalCloseResult> => {
  const errors: ClosingDomainError[] = [];
  if (!dateValue(input.closingDate)) errors.push(error('INVALID_DATE', 'Closing date must be valid.', 'closingDate'));
  if (!ISO_PERIOD.test(input.period) || periodForDate(input.closingDate) !== input.period) errors.push(error('PERIOD_MISMATCH', 'Closing date does not belong to period.', 'period'));
  if (!Number.isInteger(input.fiscalYear) || input.fiscalYear < 1) errors.push(error('INVALID_FISCAL_YEAR', 'Fiscal year must be positive.', 'fiscalYear'));
  else errors.push(...fiscalBoundaryErrors(input.closingDate, input.fiscalYear, input.fiscalYearStart));
  if (!currency(input.currency)) errors.push(error('INVALID_CURRENCY', 'Currency must be a three-letter uppercase ISO code.', 'currency'));
  if (!input.retainedEarningsAccount.trim()) errors.push(error('INVALID_ACCOUNT', 'Retained earnings account is required.', 'retainedEarningsAccount'));
  if (errors.length) return invalidResult(errors);

  const revenue = mapBalances(input.balances, input.revenueAccounts);
  const expense = mapBalances(input.balances, input.expenseAccounts);
  const lines: SourceFactLine[] = [];
  let netResultCents = 0;
  for (const [account, amount] of revenue) {
    if (amount < 0) {
      lines.push(line(account, -amount, 0, 'Fiscal close revenue'));
      netResultCents -= amount;
    } else if (amount > 0) {
      lines.push(line(account, 0, amount, 'Fiscal close revenue correction'));
      netResultCents -= amount;
    }
  }
  for (const [account, amount] of expense) {
    if (amount > 0) {
      lines.push(line(account, 0, amount, 'Fiscal close expense'));
      netResultCents -= amount;
    } else if (amount < 0) {
      lines.push(line(account, -amount, 0, 'Fiscal close expense correction'));
      netResultCents -= amount;
    }
  }
  if (!lines.length) return { status: 'noop', errors: [], value: { netResult: 0, command: undefined, reconciliation: { balanced: true, differences: [] } } };
  if (netResultCents > 0) lines.push(line(input.retainedEarningsAccount, 0, netResultCents, 'Fiscal close result'));
  if (netResultCents < 0) lines.push(line(input.retainedEarningsAccount, -netResultCents, 0, 'Fiscal close loss'));

  const command = buildJournalCommand(source('fiscal_close', input.sourceId, input.sourceRevision, input.closingDate, input.period, input.fiscalYear, input.currency, lines, `Fiscal year ${input.fiscalYear} close`, input.fiscalYearStart), [], context);
  if (command.status !== 'ready' || !command.value) return mapError(command);
  const check = reconcileRollForward({ opening: input.balances, movements: [], closing: input.balances });
  return { status: 'ready', errors: [], value: { netResult: euros(netResultCents), command: command.value, reconciliation: check }, idempotencyKey: command.idempotencyKey };
};

export const closeFiscalYear = buildFiscalClose;

export const buildCarryForward = (input: CarryForwardInput, context: JournalIdentityContext = {}): ClosingDomainResult<CarryForwardResult> => {
  const errors: ClosingDomainError[] = [];
  if (!dateValue(input.effectiveDate)) errors.push(error('INVALID_DATE', 'Effective date must be valid.', 'effectiveDate'));
  if (!ISO_PERIOD.test(input.period) || periodForDate(input.effectiveDate) !== input.period) errors.push(error('PERIOD_MISMATCH', 'Effective date does not belong to period.', 'period'));
  if (!Number.isInteger(input.fiscalYear) || input.fiscalYear < 1) errors.push(error('INVALID_FISCAL_YEAR', 'Fiscal year must be positive.', 'fiscalYear'));
  else errors.push(...fiscalBoundaryErrors(input.effectiveDate, input.fiscalYear, input.fiscalYearStart));
  if (!currency(input.currency)) errors.push(error('INVALID_CURRENCY', 'Currency must be a three-letter uppercase ISO code.', 'currency'));
  if (!input.openingBalanceAccount.trim()) errors.push(error('INVALID_ACCOUNT', 'Opening balance account is required.', 'openingBalanceAccount'));
  if (errors.length) return invalidResult(errors);

  const selected = mapBalances(input.balances, input.balanceSheetAccounts);
  const lines: SourceFactLine[] = [];
  let debit = 0;
  let credit = 0;
  for (const [account, amount] of selected) {
    if (amount > 0) {
      lines.push(line(account, amount, 0, 'Carry-forward'));
      debit += amount;
    } else if (amount < 0) {
      lines.push(line(account, 0, -amount, 'Carry-forward'));
      credit -= amount;
    }
  }
  if (debit > credit) lines.push(line(input.openingBalanceAccount, 0, debit - credit, 'Carry-forward clearing'));
  if (credit > debit) lines.push(line(input.openingBalanceAccount, credit - debit, 0, 'Carry-forward clearing'));
  if (!lines.length) return { status: 'noop', errors: [], value: { lines: [], command: undefined, reconciliation: { balanced: true, differences: [] } } };
  const command = buildJournalCommand(source('carry_forward', input.sourceId, input.sourceRevision, input.effectiveDate, input.period, input.fiscalYear, input.currency, lines, `Carry-forward ${input.fiscalYear}`, input.fiscalYearStart), [], context);
  if (command.status !== 'ready' || !command.value) return mapError(command);
  return {
    status: 'ready',
    errors: [],
    idempotencyKey: command.idempotencyKey,
    value: {
      lines,
      command: command.value,
      reconciliation: { balanced: true, differences: [] },
    },
  };
};

export const buildProvisionCommand = (input: ProvisionInput, context: JournalIdentityContext = {}): ClosingDomainResult<JournalCommand> => {
  const previous = cents(input.previousAmount);
  const target = cents(input.targetAmount);
  const errors: ClosingDomainError[] = [];
  if (previous === null || target === null) errors.push(error('INVALID_AMOUNT', 'Provision amounts must be cent values.'));
  if (previous !== null && previous < 0 || target !== null && target < 0) errors.push(error('NEGATIVE_AMOUNT', 'Provision amounts cannot be negative.'));
  if (!dateValue(input.effectiveDate)) errors.push(error('INVALID_DATE', 'Effective date must be valid.', 'effectiveDate'));
  if (!ISO_PERIOD.test(input.period) || periodForDate(input.effectiveDate) !== input.period) errors.push(error('PERIOD_MISMATCH', 'Effective date does not belong to period.', 'period'));
  if (!Number.isInteger(input.fiscalYear) || input.fiscalYear < 1) errors.push(error('INVALID_FISCAL_YEAR', 'Fiscal year must be positive.', 'fiscalYear'));
  else errors.push(...fiscalBoundaryErrors(input.effectiveDate, input.fiscalYear, input.fiscalYearStart));
  if (!currency(input.currency)) errors.push(error('INVALID_CURRENCY', 'Currency must be a three-letter uppercase ISO code.', 'currency'));
  if (!input.expenseAccount.trim() || !input.provisionAccount.trim()) errors.push(error('INVALID_ACCOUNT', 'Provision accounts are required.'));
  if (errors.length) return invalidResult(errors);
  const adjustment = target! - previous!;
  if (adjustment === 0) return { status: 'noop', errors: [] };
  const lines = adjustment > 0
    ? [line(input.expenseAccount, adjustment, 0, 'Provision increase'), line(input.provisionAccount, 0, adjustment, 'Provision increase')]
    : [line(input.provisionAccount, -adjustment, 0, 'Provision release'), line(input.expenseAccount, 0, -adjustment, 'Provision release')];
  return buildJournalCommand(source('provision', input.sourceId, input.sourceRevision, input.effectiveDate, input.period, input.fiscalYear, input.currency, lines, input.bookingText ?? 'Provision adjustment', input.fiscalYearStart), [], context);
};

const monthStart = (value: string): Date | null => {
  const date = dateValue(value);
  return date ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)) : null;
};

const monthDate = (date: Date): string => `${date.getUTCFullYear().toString().padStart(4, '0')}-${(date.getUTCMonth() + 1).toString().padStart(2, '0')}-01`;

const monthsInclusive = (start: Date, end: Date): Date[] => {
  const result: Date[] = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCMonth(cursor.getUTCMonth() + 1)) result.push(new Date(cursor));
  return result;
};

export const planAccrualSchedule = (input: AccrualInput, context: JournalIdentityContext = {}): ClosingDomainResult<AccrualSchedule> => {
  const start = monthStart(input.startDate);
  const end = monthStart(input.endDate);
  const total = cents(input.totalAmount);
  const errors: ClosingDomainError[] = [];
  if (!start || !end) errors.push(error('INVALID_DATE', 'Accrual dates must be valid ISO dates.'));
  if (start && end && start > end) errors.push(error('INVALID_RANGE', 'Accrual start must not follow end.', 'startDate'));
  if (!ISO_PERIOD.test(input.period) || (start && monthDate(start).slice(0, 7) !== input.period)) errors.push(error('PERIOD_MISMATCH', 'Accrual start date does not belong to period.', 'period'));
  if (total === null) errors.push(error('INVALID_AMOUNT', 'Accrual total must be a cent value.', 'totalAmount'));
  if (total !== null && total < 0) errors.push(error('NEGATIVE_AMOUNT', 'Accrual total cannot be negative.', 'totalAmount'));
  if (!Number.isInteger(input.fiscalYear) || input.fiscalYear < 1) errors.push(error('INVALID_FISCAL_YEAR', 'Fiscal year must be positive.', 'fiscalYear'));
  else if (start) errors.push(...fiscalBoundaryErrors(monthDate(start), input.fiscalYear, input.fiscalYearStart));
  if (!currency(input.currency)) errors.push(error('INVALID_CURRENCY', 'Currency must be a three-letter uppercase ISO code.', 'currency'));
  if (errors.length) return invalidResult(errors);
  const dates = monthsInclusive(start!, end!);
  const base = Math.floor(total! / dates.length);
  let remainder = total! - base * dates.length;
  const periods: AccrualPeriod[] = dates.map((date) => {
    const amount = base + (remainder-- > 0 ? 1 : 0);
    return { period: monthDate(date).slice(0, 7), date: monthDate(date), amount: euros(amount) };
  });
  const commands: JournalCommand[] = [];
  for (const [index, item] of periods.entries()) {
    if (!item.amount) continue;
    const itemFiscalYear = fiscalYearForDate(item.date, input.fiscalYearStart ?? '01-01');
    const command = buildJournalCommand(source(
      'accrual', input.sourceId, `${input.sourceRevision}:${index + 1}`, item.date, item.period, itemFiscalYear,
      input.currency,
      [line(input.expenseAccount, cents(item.amount)!, 0, 'Accrual release'), line(input.deferralAccount, 0, cents(item.amount)!, 'Accrual release')],
      `Accrual ${input.sourceId} ${item.period}`,
      input.fiscalYearStart,
    ), [], context);
    if (command.status !== 'ready' || !command.value) return mapError(command);
    commands.push(command.value);
  }
  return { status: 'ready', errors: [], value: { periods, totalAmount: euros(total!), commands } };
};

export const buildAccrualSchedule = (input: AccrualInput, context: JournalIdentityContext = {}): AccrualSchedule => {
  const result = planAccrualSchedule(input, context);
  if (result.status !== 'ready' || !result.value) throw new Error(result.errors[0]?.message ?? 'Unable to build accrual schedule');
  return result.value;
};

export const buildInventoryClosingValuation = (input: InventoryClosingInput, context: JournalIdentityContext = {}): ClosingDomainResult<InventoryClosingResult> => {
  const errors: ClosingDomainError[] = [];
  if (!dateValue(input.effectiveDate)) errors.push(error('INVALID_DATE', 'Effective date must be valid.', 'effectiveDate'));
  if (!ISO_PERIOD.test(input.period) || periodForDate(input.effectiveDate) !== input.period) errors.push(error('PERIOD_MISMATCH', 'Effective date does not belong to period.', 'period'));
  if (!Number.isInteger(input.fiscalYear) || input.fiscalYear < 1) errors.push(error('INVALID_FISCAL_YEAR', 'Fiscal year must be positive.', 'fiscalYear'));
  else errors.push(...fiscalBoundaryErrors(input.effectiveDate, input.fiscalYear, input.fiscalYearStart));
  if (!currency(input.currency)) errors.push(error('INVALID_CURRENCY', 'Currency must be a three-letter uppercase ISO code.', 'currency'));
  if (!input.items.length) errors.push(error('INVALID_LINE', 'At least one inventory item is required.', 'items'));
  const valuations: InventoryClosingValuation[] = [];
  for (const [index, item] of input.items.entries()) {
    const quantity = cents(item.quantity);
    const unitCost = cents(item.unitCost);
    const market = cents(item.unitMarketValue);
    if (!item.id.trim() || !item.inventoryAccount.trim() || !item.expenseAccount.trim()) errors.push(error('INVALID_ACCOUNT', 'Inventory item ids and accounts are required.', `items.${index}`));
    if (quantity === null || unitCost === null || market === null) errors.push(error('INVALID_AMOUNT', 'Inventory values must be cent values.', `items.${index}`));
    if (quantity !== null && quantity <= 0 || unitCost !== null && unitCost < 0 || market !== null && market < 0) errors.push(error('NEGATIVE_AMOUNT', 'Inventory quantity and values must be positive.', `items.${index}`));
    if (quantity === null || unitCost === null || market === null) continue;
    const cost = Math.round(quantity * unitCost / CENTS);
    const marketValue = Math.round(quantity * market / CENTS);
    const closingValue = Math.min(cost, marketValue);
    valuations.push({ id: item.id, cost: euros(cost), marketValue: euros(marketValue), closingValue: euros(closingValue), writeDown: euros(cost - closingValue) });
  }
  if (errors.length) return invalidResult(errors);
  const totalCost = valuations.reduce((sum, item) => sum + item.cost, 0);
  const totalClosingValue = valuations.reduce((sum, item) => sum + item.closingValue, 0);
  const totalWriteDown = valuations.reduce((sum, item) => sum + item.writeDown, 0);
  let command: JournalCommand | undefined;
  if (totalWriteDown > 0) {
    const expense = new Map<string, number>();
    const inventory = new Map<string, number>();
    input.items.forEach((item, index) => {
      const amount = cents(valuations[index]!.writeDown)!;
      if (!amount) return;
      expense.set(item.expenseAccount, (expense.get(item.expenseAccount) ?? 0) + amount);
      inventory.set(item.inventoryAccount, (inventory.get(item.inventoryAccount) ?? 0) + amount);
    });
    const lines = [...expense].map(([account, amount]) => line(account, amount, 0, 'Inventory lower-of-cost valuation'));
    lines.push(...[...inventory].map(([account, amount]) => line(account, 0, amount, 'Inventory lower-of-cost valuation')));
    const built = buildJournalCommand(source('inventory_closing', input.sourceId, input.sourceRevision, input.effectiveDate, input.period, input.fiscalYear, input.currency, lines, 'Inventory closing valuation', input.fiscalYearStart), [], context);
    if (built.status !== 'ready' || !built.value) return mapError(built);
    command = built.value;
  }
  return { status: totalWriteDown ? 'ready' : 'noop', errors: [], value: { valuations, totalCost, totalClosingValue, totalWriteDown, command } };
};

export const buildFxValuation = (input: FxValuationInput, context: JournalIdentityContext = {}): ClosingDomainResult<FxValuationResult> => {
  const errors: ClosingDomainError[] = [];
  if (!dateValue(input.effectiveDate)) errors.push(error('INVALID_DATE', 'Valuation date must be valid.', 'effectiveDate'));
  if (!ISO_PERIOD.test(input.period) || periodForDate(input.effectiveDate) !== input.period) errors.push(error('PERIOD_MISMATCH', 'Valuation date does not belong to period.', 'period'));
  if (!Number.isInteger(input.fiscalYear) || input.fiscalYear < 1) errors.push(error('INVALID_FISCAL_YEAR', 'Fiscal year must be positive.', 'fiscalYear'));
  else errors.push(...fiscalBoundaryErrors(input.effectiveDate, input.fiscalYear, input.fiscalYearStart));
  if (!currency(input.foreignCurrency) || !currency(input.functionalCurrency) || input.foreignCurrency === input.functionalCurrency) errors.push(error('INVALID_CURRENCY', 'Foreign and functional currencies must be distinct ISO codes.', 'foreignCurrency'));
  const foreign = cents(input.foreignAmount);
  const carrying = cents(input.carryingAmount);
  if (foreign === null || carrying === null || foreign < 0 || carrying < 0) errors.push(error('INVALID_AMOUNT', 'FX amounts must be non-negative cent values.'));
  if (!Number.isFinite(input.closingRate) || input.closingRate <= 0) errors.push(error('INVALID_RATE', 'Closing FX rate must be positive.', 'closingRate'));
  if (errors.length) return invalidResult(errors);
  const translated = Math.round(foreign! * input.closingRate);
  const difference = translated - carrying!;
  if (!difference) return { status: 'noop', errors: [], value: { translatedAmount: euros(translated), difference: 0 } };
  const positive = difference > 0;
  const gain = input.position === 'asset' ? positive : !positive;
  const amount = Math.abs(difference);
  const lines = input.position === 'asset'
    ? gain
      ? [line(input.positionAccount, amount, 0, 'FX valuation'), line(input.gainAccount, 0, amount, 'FX valuation')]
      : [line(input.lossAccount, amount, 0, 'FX valuation'), line(input.positionAccount, 0, amount, 'FX valuation')]
    : gain
      ? [line(input.positionAccount, amount, 0, 'FX valuation'), line(input.gainAccount, 0, amount, 'FX valuation')]
      : [line(input.lossAccount, amount, 0, 'FX valuation'), line(input.positionAccount, 0, amount, 'FX valuation')];
  const built = buildJournalCommand(source('fx_valuation', input.sourceId, input.sourceRevision, input.effectiveDate, input.period, input.fiscalYear, input.functionalCurrency, lines, 'FX closing valuation', input.fiscalYearStart), [], context);
  if (built.status !== 'ready' || !built.value) return mapError(built);
  return { status: 'ready', errors: [], idempotencyKey: built.idempotencyKey, value: { translatedAmount: euros(translated), difference: euros(difference), command: built.value } };
};

const addMonths = (value: string, months: number): string => {
  const date = dateValue(value)!;
  const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  return monthDate(result);
};

export const planLoanSchedule = (input: LoanScheduleInput, context: JournalIdentityContext = {}): ClosingDomainResult<LoanSchedule> => {
  const principal = cents(input.principal);
  const errors: ClosingDomainError[] = [];
  if (!dateValue(input.startDate)) errors.push(error('INVALID_DATE', 'Loan start date must be valid.', 'startDate'));
  if (!ISO_PERIOD.test(input.period) || periodForDate(input.startDate) !== input.period) errors.push(error('PERIOD_MISMATCH', 'Loan start date does not belong to period.', 'period'));
  if (!Number.isInteger(input.fiscalYear) || input.fiscalYear < 1) errors.push(error('INVALID_FISCAL_YEAR', 'Fiscal year must be positive.', 'fiscalYear'));
  else errors.push(...fiscalBoundaryErrors(input.startDate, input.fiscalYear, input.fiscalYearStart));
  if (principal === null || principal <= 0) errors.push(error('INVALID_AMOUNT', 'Loan principal must be positive cents.', 'principal'));
  if (!Number.isFinite(input.annualInterestRate) || input.annualInterestRate < 0) errors.push(error('INVALID_RATE', 'Interest rate cannot be negative.', 'annualInterestRate'));
  if (!Number.isInteger(input.termMonths) || input.termMonths <= 0) errors.push(error('INVALID_RANGE', 'Loan term must be a positive number of months.', 'termMonths'));
  if (!currency(input.currency)) errors.push(error('INVALID_CURRENCY', 'Currency must be a three-letter uppercase ISO code.', 'currency'));
  if (errors.length) return invalidResult(errors);
  const monthlyRate = input.annualInterestRate / 100 / 12;
  const payment = monthlyRate === 0
    ? Math.floor(principal! / input.termMonths)
    : Math.round(principal! * monthlyRate / (1 - Math.pow(1 + monthlyRate, -input.termMonths)));
  const periods: LoanSchedulePeriod[] = [];
  const commands: JournalCommand[] = [];
  let opening = principal!;
  for (let index = 0; index < input.termMonths; index += 1) {
    const interest = Math.round(opening * monthlyRate);
    const scheduledPayment = index === input.termMonths - 1 ? opening + interest : payment;
    const principalPart = scheduledPayment - interest;
    const closing = Math.max(0, opening - principalPart);
    const item: LoanSchedulePeriod = {
      period: index + 1,
      date: addMonths(input.startDate, index + 1),
      openingBalance: euros(opening),
      payment: euros(scheduledPayment),
      interest: euros(interest),
      principal: euros(principalPart),
      closingBalance: euros(closing),
    };
    periods.push(item);
    const loanLines = [
      interest ? line(input.interestAccount, interest, 0, 'Loan interest') : undefined,
      principalPart ? line(input.liabilityAccount, principalPart, 0, 'Loan principal') : undefined,
      scheduledPayment ? line(input.cashAccount, 0, scheduledPayment, 'Loan payment') : undefined,
    ].filter((item): item is SourceFactLine => Boolean(item));
    const built = buildJournalCommand(source(
      'loan_schedule', input.sourceId, `${input.sourceRevision}:${index + 1}`, item.date, item.date.slice(0, 7), fiscalYearForDate(item.date, input.fiscalYearStart ?? '01-01'), input.currency,
      loanLines,
      `Loan payment ${index + 1}/${input.termMonths}`,
      input.fiscalYearStart,
    ), [], context);
    if (built.status !== 'ready' || !built.value) return mapError(built);
    commands.push(built.value);
    opening = closing;
  }
  return { status: 'ready', errors: [], value: { periods, commands } };
};

export const buildLoanSchedule = (input: LoanScheduleInput, context: JournalIdentityContext = {}): LoanSchedule => {
  const result = planLoanSchedule(input, context);
  if (result.status !== 'ready' || !result.value) throw new Error(result.errors[0]?.message ?? 'Unable to build loan schedule');
  return result.value;
};

export const validatePayrollBatch = (input: PayrollBatchInput): PayrollBatchValidation => {
  const errors: ClosingDomainError[] = [];
  if (!input.batchId.trim()) errors.push(error('MISSING_SOURCE_ID', 'Payroll batch id is required.', 'batchId'));
  if (!input.lines.length) errors.push(error('INVALID_LINE', 'Payroll batch must contain at least one employee.'));
  if (!dateValue(input.effectiveDate)) errors.push(error('INVALID_DATE', 'Payroll effective date must be valid.', 'effectiveDate'));
  if (!ISO_PERIOD.test(input.period) || periodForDate(input.effectiveDate) !== input.period) errors.push(error('PERIOD_MISMATCH', 'Payroll effective date does not belong to period.', 'period'));
  if (!Number.isInteger(input.fiscalYear) || input.fiscalYear < 1) errors.push(error('INVALID_FISCAL_YEAR', 'Fiscal year must be positive.', 'fiscalYear'));
  else errors.push(...fiscalBoundaryErrors(input.effectiveDate, input.fiscalYear, input.fiscalYearStart));
  if (!currency(input.currency)) errors.push(error('INVALID_CURRENCY', 'Currency must be a three-letter uppercase ISO code.', 'currency'));
  let gross = 0;
  let employeeTaxes = 0;
  let otherDeductions = 0;
  let net = 0;
  let employerContributions = 0;
  for (const [index, item] of input.lines.entries()) {
    const values = [item.gross, item.employeeTaxes, item.otherDeductions, item.net, item.employerContributions ?? 0].map(cents);
    if (values.some((value) => value === null)) {
      errors.push(error('INVALID_AMOUNT', 'Payroll values must be cent values.', `lines.${index}`));
      continue;
    }
    const [grossCents, taxCents, deductionCents, netCents, employerCents] = values as number[];
    if ([grossCents, taxCents, deductionCents, netCents, employerCents].some((value) => value < 0)) errors.push(error('NEGATIVE_AMOUNT', 'Payroll values cannot be negative.', `lines.${index}`));
    if (grossCents - taxCents - deductionCents !== netCents) errors.push(error('GROSS_TO_NET_MISMATCH', 'Gross minus employee taxes and deductions must equal net.', `lines.${index}`));
    gross += grossCents;
    employeeTaxes += taxCents;
    otherDeductions += deductionCents;
    net += netCents;
    employerContributions += employerCents;
  }
  const controlTotals = {
    employeeCount: input.lines.length,
    gross: euros(gross),
    employeeTaxes: euros(employeeTaxes),
    otherDeductions: euros(otherDeductions),
    net: euros(net),
    employerContributions: euros(employerContributions),
    totalEmployerCost: euros(gross + employerContributions),
  };
  return { controlTotals, errors, status: errors.length ? 'invalid' : 'valid' };
};

export const validateShareholderFlow = (input: ShareholderFlowInput): ShareholderFlowValidation => {
  const conflicts: ClosingDomainError[] = [];
  if (!input.flowId.trim() || !input.shareholderId.trim() || !input.companyId.trim()) conflicts.push(error('MISSING_SOURCE_ID', 'Flow, shareholder, and company ids are required.'));
  const amount = cents(input.amount);
  if (amount === null || amount <= 0) conflicts.push(error('INVALID_AMOUNT', 'Shareholder flow amount must be positive cents.'));
  if (input.shareholderId === input.companyId || input.counterpartyId === input.companyId) conflicts.push(error('SHAREHOLDER_CONFLICT', 'Company cannot be its own shareholder counterparty.'));
  if ((input.flowType === 'private_withdrawal' || input.flowType === 'private_expense') && !input.approved) conflicts.push(error('SHAREHOLDER_CONFLICT', 'Private shareholder flows require an explicit approval.'));
  if (input.flowType === 'distribution' && !input.approved) conflicts.push(error('APPROVAL_REQUIRED', 'Distributions require an explicit approval.'));
  if (input.counterpartyId === input.shareholderId && input.flowType === 'private_expense') conflicts.push(error('SHAREHOLDER_CONFLICT', 'Expense paid to the shareholder is a related-party conflict.'));
  if (conflicts.some((item) => item.code === 'SHAREHOLDER_CONFLICT')) return { classification: 'conflict', conflicts };
  if (conflicts.some((item) => item.code === 'APPROVAL_REQUIRED')) return { classification: 'requires_approval', conflicts };
  if (input.counterpartyId === input.shareholderId || input.flowType === 'loan_to_company' || input.flowType === 'loan_from_company') return { classification: 'related_party', conflicts };
  return { classification: 'allowed', conflicts };
};
