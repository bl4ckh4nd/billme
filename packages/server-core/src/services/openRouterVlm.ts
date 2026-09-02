import { z } from 'zod';

/** Documents accepted by the Pro document-evidence analyser. */
export const openRouterVlmMimeSchema = z.enum(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
export type OpenRouterVlmMimeType = z.infer<typeof openRouterVlmMimeSchema>;

export const OPENROUTER_VLM_MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const OPENROUTER_VLM_DEFAULT_MODEL = 'google/gemini-3.7-flash';
export const OPENROUTER_VLM_DEFAULT_TIMEOUT_MS = 45_000;

export const openRouterVlmDocumentSchema = z.object({
  mimeType: openRouterVlmMimeSchema,
  /** Raw base64 or a data URL containing base64. */
  data: z.string().trim().min(1).max(14_000_000),
  fileName: z.string().trim().min(1).max(255).optional(),
});

export const openRouterVlmTransactionSchema = z.object({
  id: z.string().trim().min(1),
  date: z.string().trim().min(1),
  amount: z.number().finite(),
  currency: z.string().trim().min(3).max(3).default('EUR'),
  type: z.enum(['income', 'expense']),
  counterparty: z.string().max(500),
  purpose: z.string().max(2000),
  linkedInvoiceId: z.string().trim().min(1).optional(),
  suggestedAccountNumber: z.string().trim().min(1).optional(),
  suggestionReason: z.string().max(1000).optional(),
});

export const openRouterVlmAnalyzeInputSchema = z.object({
  transaction: openRouterVlmTransactionSchema,
  document: openRouterVlmDocumentSchema,
  model: z.string().trim().min(1).max(200).optional(),
});

const evidenceBoxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});

export const openRouterVlmEvidenceSchema = z.object({
  field: z.string().trim().min(1).max(100),
  value: z.string().max(1000),
  page: z.number().int().positive().optional(),
  boundingBox: evidenceBoxSchema.optional(),
  quote: z.string().max(1000).optional(),
  confidence: z.number().min(0).max(1),
});

const nullableNumberSchema = z.number().finite().nullable();
const nullableStringSchema = z.string().max(1000).nullable();

/** The only model-controlled data accepted by the application. */
export const openRouterVlmExtractionSchema = z.object({
  documentType: z.enum(['invoice', 'credit_note', 'receipt', 'bank_statement', 'other', 'unknown']),
  issuer: nullableStringSchema,
  recipient: nullableStringSchema,
  invoiceNumber: nullableStringSchema,
  invoiceDate: nullableStringSchema,
  servicePeriod: nullableStringSchema,
  dueDate: nullableStringSchema,
  currency: z.string().length(3).nullable(),
  netAmount: nullableNumberSchema,
  taxAmount: nullableNumberSchema,
  grossAmount: nullableNumberSchema,
  vatBreakdown: z.array(z.object({ rate: z.number().min(0).max(100), netAmount: z.number().finite(), taxAmount: z.number().finite() })).max(20),
  iban: nullableStringSchema,
  paymentReference: nullableStringSchema,
  suggestedAccountNumber: nullableStringSchema,
  suggestedTaxCase: nullableStringSchema,
  matchAssessment: z.object({
    amountMatches: z.boolean().nullable(),
    dateMatches: z.boolean().nullable(),
    partyMatches: z.boolean().nullable(),
    referenceMatches: z.boolean().nullable(),
    notes: z.array(z.string().max(500)).max(20),
  }),
  warnings: z.array(z.string().max(500)).max(30),
  evidence: z.array(openRouterVlmEvidenceSchema).max(100),
});

export type OpenRouterVlmExtraction = z.infer<typeof openRouterVlmExtractionSchema>;

export const openRouterVlmAnalyzeResultSchema = z.object({
  extraction: openRouterVlmExtractionSchema,
  deterministicChecks: z.object({
    amountMatches: z.boolean(),
    currencyMatches: z.boolean(),
    expectedAmount: z.number().finite(),
    extractedAmount: z.number().finite().nullable(),
    expectedCurrency: z.string().length(3),
    extractedCurrency: z.string().length(3).nullable(),
  }),
  metadata: z.object({
    model: z.string().min(1),
    provider: z.string().nullable(),
    requestId: z.string().nullable(),
    request: z.object({ method: z.literal('POST'), endpoint: z.string().url() }),
    timing: z.object({ startedAt: z.string().datetime(), completedAt: z.string().datetime(), durationMs: z.number().int().nonnegative() }),
    documentSha256: z.string().length(64),
  }),
});
export type OpenRouterVlmAnalyzeResult = z.infer<typeof openRouterVlmAnalyzeResultSchema>;

export const openRouterVlmPublicConfigSchema = z.object({
  configured: z.boolean(),
  model: z.string().min(1),
  models: z.array(z.string().min(1)),
  maxDocumentBytes: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
});
export type OpenRouterVlmPublicConfig = z.infer<typeof openRouterVlmPublicConfigSchema>;

type RuntimeConfig = OpenRouterVlmPublicConfig & { apiKey?: string };
export type OpenRouterVlmFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const sha256Base64 = async (value: string): Promise<string> => {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const parseOpenRouterVlmConfig = (
  env: Record<string, string | undefined> = process.env,
): RuntimeConfig => {
  const configuredModel = env.OPENROUTER_VLM_MODEL?.trim() || OPENROUTER_VLM_DEFAULT_MODEL;
  const configuredModels = (env.OPENROUTER_VLM_MODELS ?? configuredModel)
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  const models = Array.from(new Set([configuredModel, ...configuredModels]));
  const timeoutRaw = Number(env.OPENROUTER_VLM_TIMEOUT_MS ?? OPENROUTER_VLM_DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutRaw) ? Math.min(120_000, Math.max(1_000, Math.trunc(timeoutRaw))) : OPENROUTER_VLM_DEFAULT_TIMEOUT_MS;
  return {
    configured: Boolean(env.OPENROUTER_API_KEY?.trim()),
    apiKey: env.OPENROUTER_API_KEY?.trim() || undefined,
    model: configuredModel,
    models,
    maxDocumentBytes: OPENROUTER_VLM_MAX_DOCUMENT_BYTES,
    timeoutMs,
  };
};

export const publicOpenRouterVlmConfig = (config: RuntimeConfig): OpenRouterVlmPublicConfig => {
  const { apiKey: _apiKey, ...publicConfig } = config;
  return publicConfig;
};

export class OpenRouterVlmError extends Error {
  constructor(public readonly code: 'OPENROUTER_NOT_CONFIGURED' | 'OPENROUTER_MODEL_NOT_ALLOWED' | 'OPENROUTER_DOCUMENT_INVALID' | 'OPENROUTER_REQUEST_FAILED' | 'OPENROUTER_RESPONSE_INVALID' | 'OPENROUTER_TIMEOUT', message: string) {
    super(`${code}:${message}`);
    this.name = 'OpenRouterVlmError';
  }
}

const dataUrlPattern = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/;
const normalizeBase64 = (document: z.infer<typeof openRouterVlmDocumentSchema>): { mimeType: OpenRouterVlmMimeType; base64: string; byteLength: number } => {
  let mimeType = document.mimeType;
  let base64 = document.data;
  const dataUrl = dataUrlPattern.exec(base64);
  if (dataUrl) {
    if (dataUrl[1] !== mimeType) throw new OpenRouterVlmError('OPENROUTER_DOCUMENT_INVALID', 'Data-URL-MIME-Typ stimmt nicht mit mimeType überein.');
    base64 = dataUrl[2];
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) {
    throw new OpenRouterVlmError('OPENROUTER_DOCUMENT_INVALID', 'Dokument muss gültiges Base64 enthalten.');
  }
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const byteLength = Math.floor((base64.length * 3) / 4) - padding;
  if (byteLength <= 0 || byteLength > OPENROUTER_VLM_MAX_DOCUMENT_BYTES) {
    throw new OpenRouterVlmError('OPENROUTER_DOCUMENT_INVALID', `Dokument darf höchstens ${OPENROUTER_VLM_MAX_DOCUMENT_BYTES} Bytes groß sein.`);
  }
  return { mimeType, base64, byteLength };
};

const jsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['documentType', 'issuer', 'recipient', 'invoiceNumber', 'invoiceDate', 'servicePeriod', 'dueDate', 'currency', 'netAmount', 'taxAmount', 'grossAmount', 'vatBreakdown', 'iban', 'paymentReference', 'suggestedAccountNumber', 'suggestedTaxCase', 'matchAssessment', 'warnings', 'evidence'],
  properties: {
    documentType: { type: 'string', enum: ['invoice', 'credit_note', 'receipt', 'bank_statement', 'other', 'unknown'] },
    issuer: { type: ['string', 'null'] }, recipient: { type: ['string', 'null'] }, invoiceNumber: { type: ['string', 'null'] }, invoiceDate: { type: ['string', 'null'] }, servicePeriod: { type: ['string', 'null'] }, dueDate: { type: ['string', 'null'] }, currency: { type: ['string', 'null'] },
    netAmount: { type: ['number', 'null'] }, taxAmount: { type: ['number', 'null'] }, grossAmount: { type: ['number', 'null'] },
    vatBreakdown: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['rate', 'netAmount', 'taxAmount'], properties: { rate: { type: 'number' }, netAmount: { type: 'number' }, taxAmount: { type: 'number' } } } },
    iban: { type: ['string', 'null'] }, paymentReference: { type: ['string', 'null'] }, suggestedAccountNumber: { type: ['string', 'null'] }, suggestedTaxCase: { type: ['string', 'null'] },
    matchAssessment: { type: 'object', additionalProperties: false, required: ['amountMatches', 'dateMatches', 'partyMatches', 'referenceMatches', 'notes'], properties: { amountMatches: { type: ['boolean', 'null'] }, dateMatches: { type: ['boolean', 'null'] }, partyMatches: { type: ['boolean', 'null'] }, referenceMatches: { type: ['boolean', 'null'] }, notes: { type: 'array', maxItems: 20, items: { type: 'string' } } } },
    warnings: { type: 'array', maxItems: 30, items: { type: 'string' } },
    evidence: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['field', 'value', 'confidence'], properties: { field: { type: 'string' }, value: { type: 'string' }, page: { type: 'integer' }, boundingBox: { type: 'object', additionalProperties: false, required: ['x', 'y', 'width', 'height'], properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } } }, quote: { type: 'string' }, confidence: { type: 'number' } } } },
  },
} as const;

const extractContent = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') throw new OpenRouterVlmError('OPENROUTER_RESPONSE_INVALID', 'Antwort ist kein Objekt.');
  const choice = (payload as { choices?: unknown[] }).choices?.[0];
  if (!choice || typeof choice !== 'object') throw new OpenRouterVlmError('OPENROUTER_RESPONSE_INVALID', 'Antwort enthält keine Auswahl.');
  const content = (choice as { message?: { content?: unknown } }).message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content.filter((part): part is { type?: unknown; text?: unknown } => typeof part === 'object' && part !== null).map((part) => typeof part.text === 'string' ? part.text : '').join('');
    if (text) return text;
  }
  throw new OpenRouterVlmError('OPENROUTER_RESPONSE_INVALID', 'Antwort enthält keinen JSON-Inhalt.');
};

export interface OpenRouterVlmService {
  getConfig(): OpenRouterVlmPublicConfig;
  analyze(input: z.input<typeof openRouterVlmAnalyzeInputSchema>): Promise<OpenRouterVlmAnalyzeResult>;
}

export const createOpenRouterVlmService = (options: {
  config?: RuntimeConfig;
  env?: Record<string, string | undefined>;
  fetch?: OpenRouterVlmFetch;
  now?: () => Date;
  requestId?: () => string;
} = {}): OpenRouterVlmService => {
  const config = options.config ?? parseOpenRouterVlmConfig(options.env);
  const requestFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => new Date());
  const requestId = options.requestId ?? (() => globalThis.crypto?.randomUUID?.() ?? `vlm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return {
    getConfig: () => publicOpenRouterVlmConfig(config),
    async analyze(rawInput) {
      if (!config.apiKey) throw new OpenRouterVlmError('OPENROUTER_NOT_CONFIGURED', 'OPENROUTER_API_KEY ist nicht gesetzt.');
      const input = openRouterVlmAnalyzeInputSchema.parse(rawInput);
      const model = input.model ?? config.model;
      if (!config.models.includes(model)) throw new OpenRouterVlmError('OPENROUTER_MODEL_NOT_ALLOWED', 'Das gewählte VLM ist nicht freigeschaltet.');
      const document = normalizeBase64(input.document);
      const started = now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
      const documentUrl = `data:${document.mimeType};base64,${document.base64}`;
      const userContent = document.mimeType === 'application/pdf'
        ? [{ type: 'text', text: 'Analysiere das Dokument gemäß dem Schema. Dokumentdaten folgen.' }, { type: 'file', file: { filename: input.document.fileName ?? 'document.pdf', file_data: documentUrl } }]
        : [{ type: 'text', text: 'Analysiere das Dokument gemäß dem Schema. Dokumentdaten folgen.' }, { type: 'image_url', image_url: { url: documentUrl } }];
      const response = await requestFetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json', 'http-referer': 'https://billme.app', 'X-OpenRouter-Title': 'Billme Pro' },
        body: JSON.stringify({
          model,
          provider: { zdr: true, data_collection: 'deny', require_parameters: true },
          temperature: 0,
          messages: [{ role: 'system', content: 'Du extrahierst ausschließlich überprüfbare Belege. Erfinde keine Werte. Gib nur das verlangte JSON zurück. VLM-Ergebnis ist ein Vorschlag und darf niemals automatisch buchen oder posten.' }, { role: 'user', content: [{ type: 'text', text: JSON.stringify({ transaction: input.transaction, instructions: 'Vergleiche Betrag, Datum, Gegenpartei und Verwendungszweck mit dem Dokument. Liefere je Feld Evidence mit Seite und Confidence.' }) }, ...userContent] }],
          response_format: { type: 'json_schema', json_schema: { name: 'billme_transaction_document_analysis', strict: true, schema: jsonSchema } },
        }),
      }).catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') throw new OpenRouterVlmError('OPENROUTER_TIMEOUT', 'VLM-Anfrage hat das Zeitlimit überschritten.');
        if (error instanceof OpenRouterVlmError) throw error;
        throw new OpenRouterVlmError('OPENROUTER_REQUEST_FAILED', error instanceof Error ? error.message : 'VLM-Anfrage fehlgeschlagen.');
      }).finally(() => clearTimeout(timeout));
      if (!response.ok) throw new OpenRouterVlmError('OPENROUTER_REQUEST_FAILED', `OpenRouter antwortete mit HTTP ${response.status}.`);
      let payload: unknown;
      try { payload = await response.json(); } catch { throw new OpenRouterVlmError('OPENROUTER_RESPONSE_INVALID', 'OpenRouter-Antwort ist kein JSON.'); }
      let extraction: OpenRouterVlmExtraction;
      try { extraction = openRouterVlmExtractionSchema.parse(JSON.parse(extractContent(payload))); } catch (error) {
        if (error instanceof OpenRouterVlmError) throw error;
        throw new OpenRouterVlmError('OPENROUTER_RESPONSE_INVALID', 'VLM-Ergebnis entspricht nicht dem Vertrag.');
      }
      const completed = now();
      const body = payload as { id?: unknown; provider?: unknown; model?: unknown };
      const expectedAmount = Math.abs(input.transaction.amount);
      const extractedAmount = extraction.grossAmount === null ? null : Math.abs(extraction.grossAmount);
      const expectedCurrency = input.transaction.currency.toUpperCase();
      const extractedCurrency = extraction.currency?.toUpperCase() ?? null;
      return openRouterVlmAnalyzeResultSchema.parse({ extraction, deterministicChecks: { amountMatches: extractedAmount !== null && Math.round(extractedAmount * 100) === Math.round(expectedAmount * 100), currencyMatches: extractedCurrency !== null && extractedCurrency === expectedCurrency, expectedAmount, extractedAmount, expectedCurrency, extractedCurrency }, metadata: { model, provider: typeof body.provider === 'string' ? body.provider : null, requestId: response.headers.get('x-request-id') ?? (typeof body.id === 'string' ? body.id : requestId()), request: { method: 'POST', endpoint: 'https://openrouter.ai/api/v1/chat/completions' }, timing: { startedAt: started.toISOString(), completedAt: completed.toISOString(), durationMs: Math.max(0, completed.getTime() - started.getTime()) }, documentSha256: await sha256Base64(document.base64) } });
    },
  };
};
