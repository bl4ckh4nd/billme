import type Database from 'better-sqlite3';
import type { EurLine } from '../db/eurCatalogRepo';
import { listEurRules, type EurRule } from '../db/eurRulesRepo';
import { suggestEurLine } from './eurSuggestion';

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

const normalizeText = (value: string): string =>
  value.toLowerCase().replace(/\s+/g, ' ').trim();

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
  const rows = db
    .prepare(
      `SELECT t.counterparty, ec.eur_line_id, MAX(ec.updated_at) AS latest
       FROM eur_classifications ec
       INNER JOIN transactions t ON t.id = ec.source_id AND ec.source_type = 'transaction'
       WHERE ec.tax_year = ?
         AND ec.excluded = 0
         AND ec.eur_line_id IS NOT NULL
       GROUP BY LOWER(TRIM(REPLACE(t.counterparty, '  ', ' ')))
       ORDER BY latest DESC`,
    )
    .all(taxYear) as Array<{ counterparty: string; eur_line_id: string }>;

  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(normalizeText(row.counterparty), row.eur_line_id);
  }
  return map;
};

// ---------------------------------------------------------------------------
// Layer 3: Naive Bayes classifier
// ---------------------------------------------------------------------------

export interface NaiveBayesModel {
  classCounts: Map<string, number>;
  wordCounts: Map<string, Map<string, number>>;
  totalDocs: number;
  vocabularySize: number;
}

const MIN_TRAINING_EXAMPLES = 20;
const MIN_CONFIDENCE = 0.6;

export const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-zäöüß0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 1);

export const trainNaiveBayes = (
  trainingData: Array<{ counterparty: string; purpose: string; eurLineId: string }>,
): NaiveBayesModel | null => {
  if (trainingData.length < MIN_TRAINING_EXAMPLES) return null;

  const classCounts = new Map<string, number>();
  const wordCounts = new Map<string, Map<string, number>>();
  const vocabulary = new Set<string>();

  for (const item of trainingData) {
    const cls = item.eurLineId;
    classCounts.set(cls, (classCounts.get(cls) ?? 0) + 1);
    if (!wordCounts.has(cls)) wordCounts.set(cls, new Map());
    const words = tokenize(`${item.counterparty} ${item.purpose}`);
    for (const word of words) {
      vocabulary.add(word);
      const classWords = wordCounts.get(cls)!;
      classWords.set(word, (classWords.get(word) ?? 0) + 1);
    }
  }

  return { classCounts, wordCounts, totalDocs: trainingData.length, vocabularySize: vocabulary.size };
};

export const predictNaiveBayes = (
  model: NaiveBayesModel,
  text: string,
): { lineId: string; confidence: number } | null => {
  const words = tokenize(text);
  if (words.length === 0) return null;

  let bestClass = '';
  let bestLogProb = -Infinity;
  let secondBestLogProb = -Infinity;

  for (const [cls, count] of model.classCounts) {
    let logProb = Math.log(count / model.totalDocs);
    const classWords = model.wordCounts.get(cls)!;
    const totalWordsInClass = [...classWords.values()].reduce((a, b) => a + b, 0);

    for (const word of words) {
      const wordCount = classWords.get(word) ?? 0;
      logProb += Math.log((wordCount + 1) / (totalWordsInClass + model.vocabularySize));
    }

    if (logProb > bestLogProb) {
      secondBestLogProb = bestLogProb;
      bestLogProb = logProb;
      bestClass = cls;
    } else if (logProb > secondBestLogProb) {
      secondBestLogProb = logProb;
    }
  }

  if (!bestClass) return null;

  // Sigmoid mapping of log-prob difference → [0, 1] confidence
  const logDiff = bestLogProb - secondBestLogProb;
  const confidence = secondBestLogProb === -Infinity ? 1.0 : 1 / (1 + Math.exp(-logDiff));

  if (confidence < MIN_CONFIDENCE) return null;
  return { lineId: bestClass, confidence };
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
  const rows = db
    .prepare(
      `SELECT t.counterparty, t.purpose, ec.eur_line_id
       FROM eur_classifications ec
       INNER JOIN transactions t ON t.id = ec.source_id AND ec.source_type = 'transaction'
       WHERE ec.tax_year = ?
         AND ec.excluded = 0
         AND ec.eur_line_id IS NOT NULL
       UNION ALL
       SELECT i.client AS counterparty, 'Rechnung ' || i.number AS purpose, ec.eur_line_id
       FROM eur_classifications ec
       INNER JOIN invoices i ON i.id = ec.source_id AND ec.source_type = 'invoice'
       WHERE ec.tax_year = ?
         AND ec.excluded = 0
         AND ec.eur_line_id IS NOT NULL`,
    )
    .all(taxYear, taxYear) as Array<{ counterparty: string; purpose: string; eur_line_id: string }>;

  return rows.map((r) => ({
    counterparty: r.counterparty,
    purpose: r.purpose,
    eurLineId: r.eur_line_id,
  }));
};
