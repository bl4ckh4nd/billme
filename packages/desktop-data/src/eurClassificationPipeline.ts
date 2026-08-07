import type Database from 'better-sqlite3';
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import type { EurLine } from './eurCatalogRepo';
import { listEurRules, type EurRule } from './eurRulesRepo';
import { suggestEurLine } from '@billme/desktop-services/eurSuggestion';
import {
  normalizeLooseText,
  predictNaiveBayes as predictSharedNaiveBayes,
  tokenize as tokenizeShared,
  trainNaiveBayes as trainSharedNaiveBayes,
  type NaiveBayesModel as SharedNaiveBayesModel,
} from '@billme/finance-intelligence';
import { createDrizzle, schema } from './drizzle';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SuggestionLayer = 'rule' | 'counterparty' | 'bayes' | 'keyword';

export interface PipelineSuggestion {
  lineId?: string;
  reason?: string;
  layer?: SuggestionLayer;
}

export interface PipelineContext {
  rules: EurRule[];
  counterpartyMemory: Map<string, string>;
  bayesModel: NaiveBayesModel | null;
  lines: EurLine[];
}

interface ClassifyInput {
  flowType: 'income' | 'expense';
  counterparty: string;
  purpose: string;
}

// ---------------------------------------------------------------------------
// Pipeline entry point
// ---------------------------------------------------------------------------

export const classifyItem = (ctx: PipelineContext, item: ClassifyInput): PipelineSuggestion => {
  const ruleResult = applyRules(ctx.rules, item);
  if (ruleResult.lineId) return ruleResult;

  const memoryResult = applyCounterpartyMemory(ctx.counterpartyMemory, item);
  if (memoryResult.lineId) return memoryResult;

  if (ctx.bayesModel) {
    const bayesResult = applyBayes(ctx.bayesModel, item);
    if (bayesResult.lineId) return bayesResult;
  }

  const kwResult = suggestEurLine(item, ctx.lines);
  return {
    lineId: kwResult.lineId,
    reason: kwResult.reason,
    layer: kwResult.lineId ? 'keyword' : undefined,
  };
};

// ---------------------------------------------------------------------------
// Context builder (called once per listEurItems)
// ---------------------------------------------------------------------------

export const buildPipelineContext = (
  db: Database.Database,
  taxYear: number,
  lines: EurLine[],
): PipelineContext => {
  const rules = listEurRules(db, taxYear);
  const counterpartyMemory = buildCounterpartyMemory(db, taxYear);
  const trainingData = buildBayesTrainingData(db, taxYear);
  const bayesModel = trainNaiveBayes(trainingData);
  return { rules, counterpartyMemory, bayesModel, lines };
};

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

const normalizeText = (value: string): string => normalizeLooseText(value);

// ---------------------------------------------------------------------------
// Layer 1: User-defined rules
// ---------------------------------------------------------------------------

const applyRules = (rules: EurRule[], item: ClassifyInput): PipelineSuggestion => {
  for (const rule of rules) {
    const fields: string[] = [];
    if (rule.field === 'counterparty' || rule.field === 'any') fields.push(item.counterparty);
    if (rule.field === 'purpose' || rule.field === 'any') fields.push(item.purpose);

    const needle = normalizeText(rule.value);
    const matched = fields.some((f) => {
      const haystack = normalizeText(f);
      if (rule.operator === 'contains') return haystack.includes(needle);
      if (rule.operator === 'equals') return haystack === needle;
      if (rule.operator === 'startsWith') return haystack.startsWith(needle);
      return false;
    });

    if (matched) {
      return {
        lineId: rule.targetEurLineId,
        reason: `Regel: „${rule.value}" (${rule.field}/${rule.operator})`,
        layer: 'rule',
      };
    }
  }
  return {};
};

// ---------------------------------------------------------------------------
// Layer 2: Counterparty memory
// ---------------------------------------------------------------------------

const applyCounterpartyMemory = (
  memory: Map<string, string>,
  item: ClassifyInput,
): PipelineSuggestion => {
  const key = normalizeText(item.counterparty);
  const lineId = memory.get(key);
  if (lineId) {
    return {
      lineId,
      reason: `Bisherige Zuordnung für „${item.counterparty}"`,
      layer: 'counterparty',
    };
  }
  return {};
};

export const buildCounterpartyMemory = (
  db: Database.Database,
  taxYear: number,
): Map<string, string> => {
  const rows = createDrizzle(db).select({
    counterparty: schema.transactions.counterparty,
    eur_line_id: schema.eurClassifications.eurLineId,
    latest: schema.eurClassifications.updatedAt,
  }).from(schema.eurClassifications)
    .innerJoin(schema.transactions, and(
      eq(schema.transactions.id, schema.eurClassifications.sourceId),
      eq(schema.eurClassifications.sourceType, 'transaction'),
    )).where(and(
      eq(schema.eurClassifications.taxYear, taxYear),
      eq(schema.eurClassifications.excluded, 0),
      isNotNull(schema.eurClassifications.eurLineId),
    )).orderBy(desc(schema.eurClassifications.updatedAt)).all() as Array<{ counterparty: string; eur_line_id: string; latest: string }>;

  const map = new Map<string, string>();
  for (const row of rows) {
    const key = normalizeText(row.counterparty);
    if (!map.has(key)) map.set(key, row.eur_line_id);
  }
  return map;
};

// ---------------------------------------------------------------------------
// Layer 3: Naive Bayes classifier
// ---------------------------------------------------------------------------

export type NaiveBayesModel = SharedNaiveBayesModel;

const MIN_TRAINING_EXAMPLES = 20;
const MIN_CONFIDENCE = 0.6;

export const tokenize = (text: string): string[] => tokenizeShared(text);

export const trainNaiveBayes = (
  trainingData: Array<{ counterparty: string; purpose: string; eurLineId: string }>,
): NaiveBayesModel | null => {
  return trainSharedNaiveBayes(
    trainingData.map((item) => ({
      text: `${item.counterparty} ${item.purpose}`,
      classId: item.eurLineId,
    })),
    MIN_TRAINING_EXAMPLES,
  );
};

export const predictNaiveBayes = (
  model: NaiveBayesModel,
  text: string,
): { lineId: string; confidence: number } | null => {
  const result = predictSharedNaiveBayes(model, text, MIN_CONFIDENCE);
  if (!result) {
    return null;
  }
  return { lineId: result.classId, confidence: result.confidence };
};

const applyBayes = (model: NaiveBayesModel, item: ClassifyInput): PipelineSuggestion => {
  const result = predictNaiveBayes(model, `${item.counterparty} ${item.purpose}`);
  if (result) {
    return {
      lineId: result.lineId,
      reason: `KI-Vorschlag (${Math.round(result.confidence * 100)}% Konfidenz)`,
      layer: 'bayes',
    };
  }
  return {};
};

// ---------------------------------------------------------------------------
// Training data builder
// ---------------------------------------------------------------------------

export const buildBayesTrainingData = (
  db: Database.Database,
  taxYear: number,
): Array<{ counterparty: string; purpose: string; eurLineId: string }> => {
  const drizzle = createDrizzle(db);
  const transactionRows = drizzle.select({
    counterparty: schema.transactions.counterparty,
    purpose: schema.transactions.purpose,
    eur_line_id: schema.eurClassifications.eurLineId,
  }).from(schema.eurClassifications).innerJoin(schema.transactions, and(
    eq(schema.transactions.id, schema.eurClassifications.sourceId),
    eq(schema.eurClassifications.sourceType, 'transaction'),
  )).where(and(
    eq(schema.eurClassifications.taxYear, taxYear),
    eq(schema.eurClassifications.excluded, 0),
    isNotNull(schema.eurClassifications.eurLineId),
  )).all() as Array<{ counterparty: string; purpose: string; eur_line_id: string }>;
  const invoiceRows = drizzle.select({
    counterparty: schema.invoices.client,
    purpose: schema.invoices.number,
    eur_line_id: schema.eurClassifications.eurLineId,
  }).from(schema.eurClassifications).innerJoin(schema.invoices, and(
    eq(schema.invoices.id, schema.eurClassifications.sourceId),
    eq(schema.eurClassifications.sourceType, 'invoice'),
  )).where(and(
    eq(schema.eurClassifications.taxYear, taxYear),
    eq(schema.eurClassifications.excluded, 0),
    isNotNull(schema.eurClassifications.eurLineId),
  )).all() as Array<{ counterparty: string; purpose: string; eur_line_id: string }>;

  return [...transactionRows, ...invoiceRows].map((r) => ({
    counterparty: r.counterparty,
    purpose: invoiceRows.includes(r) ? `Rechnung ${r.purpose}` : r.purpose,
    eurLineId: r.eur_line_id,
  }));
};
