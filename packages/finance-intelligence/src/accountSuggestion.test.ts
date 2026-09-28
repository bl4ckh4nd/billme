import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAccountSuggestionContextFrom,
  suggestAccountForTransaction,
  type AccountSuggestionRuleInput,
  type AccountSuggestionSources,
} from './accountSuggestion.js';

const rule = (overrides: Partial<AccountSuggestionRuleInput> = {}): AccountSuggestionRuleInput => ({
  chart: 'SKR03',
  priority: 10,
  field: 'any',
  operator: 'contains',
  value: 'telekom',
  targetAccountNumber: '4920',
  flowType: 'any',
  active: true,
  ...overrides,
});

const sources = (overrides: Partial<AccountSuggestionSources> = {}): AccountSuggestionSources => ({
  chart: 'SKR03',
  rules: [],
  keywords: [],
  postedBankBookings: [],
  chartAccountNumbers: ['1200', '4100', '4920', '8400'],
  ...overrides,
});

const trainingBookings = (count: number) =>
  Array.from({ length: count }, (_, index) => index % 2 === 0
    ? { counterparty: `Lieferant ${index}`, purpose: 'Mobilfunk Vertrag Rechnung', accountNumber: '4920' }
    : { counterparty: `Lieferant ${index}`, purpose: 'Bueromaterial Papier Toner', accountNumber: '4930' });

const expense = (counterparty: string, purpose = '') => ({ flowType: 'expense' as const, counterparty, purpose });

test('an explicit rule beats counterparty memory, Bayes, and keywords', () => {
  const ctx = buildAccountSuggestionContextFrom(sources({
    rules: [rule({ value: 'mobilfunk', targetAccountNumber: '4977' })],
    keywords: [{ keyword: 'mobilfunk', accountNumber: '4999' }],
    postedBankBookings: [
      { counterparty: 'Telekom', purpose: 'x', accountNumber: '4911' },
      ...trainingBookings(20),
    ],
  }));
  const result = suggestAccountForTransaction(ctx, expense('Telekom', 'Mobilfunk Vertrag'));
  assert.equal(result.layer, 'rule');
  assert.equal(result.accountNumber, '4977');
  assert.equal(result.confidence, 0.99);
});

test('rules apply by ascending priority and skip inactive, other-chart, and wrong-flow rules', () => {
  const ctx = buildAccountSuggestionContextFrom(sources({
    rules: [
      rule({ priority: 1, targetAccountNumber: '4001', active: false }),
      rule({ priority: 2, targetAccountNumber: '4002', chart: 'SKR04' }),
      rule({ priority: 3, targetAccountNumber: '4003', flowType: 'income' }),
      rule({ priority: 9, targetAccountNumber: '4009' }),
      rule({ priority: 5, targetAccountNumber: '4005' }),
    ],
  }));
  assert.equal(suggestAccountForTransaction(ctx, expense('Telekom')).accountNumber, '4005');
});

test('rule operators and fields match on normalized text', () => {
  const ctx = buildAccountSuggestionContextFrom(sources({
    rules: [
      rule({ priority: 1, field: 'counterparty', operator: 'equals', value: 'Müller  GmbH', targetAccountNumber: '4101' }),
      rule({ priority: 2, field: 'purpose', operator: 'startsWith', value: 'Miete', targetAccountNumber: '4102' }),
    ],
  }));
  assert.equal(suggestAccountForTransaction(ctx, expense('mueller gmbh')).accountNumber, '4101');
  assert.equal(suggestAccountForTransaction(ctx, expense('Mueller GmbH & Co')).layer, 'fallback');
  assert.equal(suggestAccountForTransaction(ctx, expense('Vermieter', 'Miete Mai')).accountNumber, '4102');
  assert.equal(suggestAccountForTransaction(ctx, expense('Vermieter', 'Mai Miete')).layer, 'fallback');
});

test('a remembered counterparty beats Bayes and keywords, and the newest booking wins', () => {
  const ctx = buildAccountSuggestionContextFrom(sources({
    keywords: [{ keyword: 'mobilfunk', accountNumber: '4999' }],
    postedBankBookings: [
      { counterparty: 'Stadtwerke Köln', purpose: 'Strom', accountNumber: '4240' },
      { counterparty: 'Stadtwerke Köln', purpose: 'Strom', accountNumber: '4250' },
      ...trainingBookings(20),
    ],
  }));
  const result = suggestAccountForTransaction(ctx, expense('STADTWERKE KOELN', 'Mobilfunk Vertrag'));
  assert.equal(result.layer, 'counterparty');
  assert.equal(result.accountNumber, '4240');
  assert.equal(result.confidence, 0.9);
});

test('Bayes beats keywords once enough posted bookings exist', () => {
  const ctx = buildAccountSuggestionContextFrom(sources({
    keywords: [{ keyword: 'mobilfunk', accountNumber: '4999' }],
    postedBankBookings: trainingBookings(20),
  }));
  const result = suggestAccountForTransaction(ctx, expense('Neue Firma GmbH', 'Mobilfunk Vertrag'));
  assert.equal(result.layer, 'bayes');
  assert.equal(result.accountNumber, '4920');
});

test('Bayes is not trained below 20 posted bookings, so keywords answer', () => {
  const ctx = buildAccountSuggestionContextFrom(sources({
    keywords: [{ keyword: 'mobilfunk', accountNumber: '4999' }],
    postedBankBookings: trainingBookings(19),
  }));
  assert.equal(ctx.bayesModel, null);
  const result = suggestAccountForTransaction(ctx, expense('Neue Firma GmbH', 'Mobilfunk Vertrag'));
  assert.equal(result.layer, 'keyword');
  assert.equal(result.accountNumber, '4999');
});

test('keyword layer picks the account with most hits, breaks ties by account number, and scales confidence', () => {
  const ctx = buildAccountSuggestionContextFrom(sources({
    keywords: [
      { keyword: 'Büro', accountNumber: '4930' },
      { keyword: 'papier', accountNumber: '4930' },
      { keyword: 'papier', accountNumber: '4910' },
      { keyword: 'toner', accountNumber: '4900' },
    ],
  }));
  const twoHits = suggestAccountForTransaction(ctx, expense('Shop', 'Bueropapier'));
  assert.equal(twoHits.accountNumber, '4930');
  assert.equal(twoHits.reason, 'Stichworttreffer (2)');
  assert.equal(twoHits.confidence, 0.65);
  const tie = suggestAccountForTransaction(ctx, expense('Shop', 'Papier Toner'));
  assert.equal(tie.accountNumber, '4900');
  assert.equal(tie.confidence, 0.55);
});

test('fallback uses the first chart account of the flow type and nothing when none exists', () => {
  const ctx = buildAccountSuggestionContextFrom(sources({ chartAccountNumbers: ['1200', '4100', '4920', '8400', '9000'] }));
  const income = suggestAccountForTransaction(ctx, { flowType: 'income', counterparty: 'Kunde', purpose: '' });
  assert.equal(income.layer, 'fallback');
  assert.equal(income.accountNumber, '8400');
  assert.equal(suggestAccountForTransaction(ctx, expense('Lieferant')).accountNumber, '4100');

  const empty = buildAccountSuggestionContextFrom(sources({ chartAccountNumbers: ['1200'] }));
  assert.deepEqual(suggestAccountForTransaction(empty, expense('Lieferant')), {});
});
