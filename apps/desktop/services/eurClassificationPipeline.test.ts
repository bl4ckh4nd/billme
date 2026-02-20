import { describe, expect, it } from 'vitest';
import {
  classifyItem,
  trainNaiveBayes,
  predictNaiveBayes,
  tokenize,
  type PipelineContext,
  type NaiveBayesModel,
} from './eurClassificationPipeline';
import type { EurLine } from '../db/eurCatalogRepo';
import type { EurRule } from '../db/eurRulesRepo';

const makeLine = (id: string, kennziffer: string, kind: 'income' | 'expense'): EurLine => ({
  id,
  taxYear: 2025,
  kennziffer,
  label: `Line ${kennziffer}`,
  kind,
  exportable: true,
  sortOrder: 0,
  computedFromIds: [],
  sourceVersion: 'test',
});

const lines: EurLine[] = [
  makeLine('E2025_KZ112', '112', 'income'),
  makeLine('E2025_KZ183', '183', 'expense'),
  makeLine('E2025_KZ150', '150', 'expense'),
  makeLine('E2025_KZ280', '280', 'expense'),
];

const makeRule = (overrides: Partial<EurRule> & Pick<EurRule, 'field' | 'operator' | 'value' | 'targetEurLineId'>): EurRule => ({
  id: 'r1',
  taxYear: 2025,
  priority: 10,
  active: true,
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

const emptyCtx = (overrides?: Partial<PipelineContext>): PipelineContext => ({
  rules: [],
  counterpartyMemory: new Map(),
  bayesModel: null,
  lines,
  ...overrides,
});

describe('Layer 1: Rules Engine', () => {
  it('matches "contains" operator', () => {
    const ctx = emptyCtx({
      rules: [makeRule({ field: 'counterparty', operator: 'contains', value: 'Telekom', targetEurLineId: 'E2025_KZ280' })],
    });
    const result = classifyItem(ctx, { flowType: 'expense', counterparty: 'Deutsche Telekom GmbH', purpose: 'Rechnung 123' });
    expect(result.lineId).toBe('E2025_KZ280');
    expect(result.layer).toBe('rule');
  });

  it('matches "equals" operator case-insensitively', () => {
    const ctx = emptyCtx({
      rules: [makeRule({ field: 'counterparty', operator: 'equals', value: 'telekom', targetEurLineId: 'E2025_KZ280' })],
    });
    const result = classifyItem(ctx, { flowType: 'expense', counterparty: 'Telekom', purpose: '' });
    expect(result.lineId).toBe('E2025_KZ280');
    expect(result.layer).toBe('rule');
  });

  it('matches "startsWith" operator', () => {
    const ctx = emptyCtx({
      rules: [makeRule({ field: 'purpose', operator: 'startsWith', value: 'Miete', targetEurLineId: 'E2025_KZ150' })],
    });
    const result = classifyItem(ctx, { flowType: 'expense', counterparty: 'Vermieter', purpose: 'Miete Büro Januar' });
    expect(result.lineId).toBe('E2025_KZ150');
    expect(result.layer).toBe('rule');
  });

  it('field "any" checks both counterparty and purpose', () => {
    const ctx = emptyCtx({
      rules: [makeRule({ field: 'any', operator: 'contains', value: 'hosting', targetEurLineId: 'E2025_KZ280' })],
    });
    const result = classifyItem(ctx, { flowType: 'expense', counterparty: 'Hetzner', purpose: 'Server Hosting' });
    expect(result.lineId).toBe('E2025_KZ280');
    expect(result.layer).toBe('rule');
  });

  it('respects priority ordering (lower number wins)', () => {
    const ctx = emptyCtx({
      rules: [
        makeRule({ id: 'r2', priority: 20, field: 'counterparty', operator: 'contains', value: 'Telekom', targetEurLineId: 'E2025_KZ183' }),
        makeRule({ id: 'r1', priority: 5, field: 'counterparty', operator: 'contains', value: 'Telekom', targetEurLineId: 'E2025_KZ280' }),
      ],
    });
    // Rules should be sorted by priority, lower first
    ctx.rules.sort((a, b) => a.priority - b.priority);
    const result = classifyItem(ctx, { flowType: 'expense', counterparty: 'Telekom', purpose: '' });
    expect(result.lineId).toBe('E2025_KZ280');
  });

  it('does not match when value is not found', () => {
    const ctx = emptyCtx({
      rules: [makeRule({ field: 'counterparty', operator: 'contains', value: 'Amazon', targetEurLineId: 'E2025_KZ280' })],
    });
    const result = classifyItem(ctx, { flowType: 'expense', counterparty: 'Telekom', purpose: '' });
    // Falls through to keyword layer
    expect(result.layer).not.toBe('rule');
  });
});

describe('Layer 2: Counterparty Memory', () => {
  it('returns stored line for known counterparty', () => {
    const memory = new Map<string, string>();
    memory.set('deutsche telekom gmbh', 'E2025_KZ280');
    const ctx = emptyCtx({ counterpartyMemory: memory });

    const result = classifyItem(ctx, { flowType: 'expense', counterparty: 'Deutsche Telekom GmbH', purpose: 'Rechnung' });
    expect(result.lineId).toBe('E2025_KZ280');
    expect(result.layer).toBe('counterparty');
  });

  it('normalizes whitespace for matching', () => {
    const memory = new Map<string, string>();
    memory.set('test company', 'E2025_KZ183');
    const ctx = emptyCtx({ counterpartyMemory: memory });

    const result = classifyItem(ctx, { flowType: 'expense', counterparty: '  Test  Company  ', purpose: '' });
    expect(result.lineId).toBe('E2025_KZ183');
    expect(result.layer).toBe('counterparty');
  });

  it('falls through for unknown counterparty', () => {
    const ctx = emptyCtx({ counterpartyMemory: new Map() });
    const result = classifyItem(ctx, { flowType: 'expense', counterparty: 'Unknown Corp', purpose: '' });
    expect(result.layer).not.toBe('counterparty');
  });
});

describe('Layer 3: Naive Bayes', () => {
  it('returns null when fewer than 20 training examples', () => {
    const data = Array.from({ length: 10 }, (_, i) => ({
      counterparty: `Company ${i}`,
      purpose: 'Payment',
      eurLineId: 'E2025_KZ183',
    }));
    const model = trainNaiveBayes(data);
    expect(model).toBeNull();
  });

  it('trains and predicts correctly on a simple dataset', () => {
    const data: Array<{ counterparty: string; purpose: string; eurLineId: string }> = [];

    // 15 telecom entries
    for (let i = 0; i < 15; i++) {
      data.push({ counterparty: `Telekom Provider ${i}`, purpose: 'Internet Rechnung', eurLineId: 'E2025_KZ280' });
    }
    // 15 rent entries
    for (let i = 0; i < 15; i++) {
      data.push({ counterparty: `Vermieter ${i}`, purpose: 'Miete Büro', eurLineId: 'E2025_KZ150' });
    }

    const model = trainNaiveBayes(data);
    expect(model).not.toBeNull();
    expect(model!.totalDocs).toBe(30);

    const prediction = predictNaiveBayes(model!, 'Telekom Provider Internet');
    expect(prediction).not.toBeNull();
    expect(prediction!.lineId).toBe('E2025_KZ280');
  });

  it('returns null for low confidence predictions', () => {
    // When all classes have equal representation with similar words, confidence should be low
    const data: Array<{ counterparty: string; purpose: string; eurLineId: string }> = [];
    for (let i = 0; i < 10; i++) {
      data.push({ counterparty: 'Same Company', purpose: 'Same Purpose', eurLineId: 'E2025_KZ280' });
    }
    for (let i = 0; i < 10; i++) {
      data.push({ counterparty: 'Same Company', purpose: 'Same Purpose', eurLineId: 'E2025_KZ150' });
    }
    const model = trainNaiveBayes(data);
    expect(model).not.toBeNull();

    const prediction = predictNaiveBayes(model!, 'Same Company Same Purpose');
    // With identical training data for both classes, confidence should be ~0.5 (below threshold)
    expect(prediction).toBeNull();
  });

  it('tokenize filters out single-char words', () => {
    const tokens = tokenize('a bc def g hi');
    expect(tokens).toEqual(['bc', 'def', 'hi']);
  });
});

describe('Pipeline integration', () => {
  it('rule trumps counterparty memory', () => {
    const memory = new Map<string, string>();
    memory.set('telekom', 'E2025_KZ183');
    const ctx = emptyCtx({
      rules: [makeRule({ field: 'counterparty', operator: 'contains', value: 'Telekom', targetEurLineId: 'E2025_KZ280' })],
      counterpartyMemory: memory,
    });

    const result = classifyItem(ctx, { flowType: 'expense', counterparty: 'Telekom', purpose: '' });
    expect(result.lineId).toBe('E2025_KZ280');
    expect(result.layer).toBe('rule');
  });

  it('counterparty memory trumps keyword', () => {
    const memory = new Map<string, string>();
    memory.set('some company', 'E2025_KZ150');
    const ctx = emptyCtx({ counterpartyMemory: memory });

    const result = classifyItem(ctx, { flowType: 'expense', counterparty: 'Some Company', purpose: 'Internet Rechnung' });
    expect(result.lineId).toBe('E2025_KZ150');
    expect(result.layer).toBe('counterparty');
  });

  it('falls through to keyword when no upper layers match', () => {
    const ctx = emptyCtx();
    const result = classifyItem(ctx, { flowType: 'expense', counterparty: 'Random', purpose: 'Miete Büro' });
    expect(result.layer).toBe('keyword');
    expect(result.lineId).toBe('E2025_KZ150');
  });

  it('keyword fallback provides income default', () => {
    const ctx = emptyCtx();
    const result = classifyItem(ctx, { flowType: 'income', counterparty: 'Kunde', purpose: 'Zahlung' });
    expect(result.layer).toBe('keyword');
    expect(result.lineId).toBe('E2025_KZ112');
  });
});
