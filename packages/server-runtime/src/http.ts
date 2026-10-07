import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify';
import { ZodError, z } from 'zod';

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

type MaybeSchema = z.ZodTypeAny | undefined;
type InferSchema<TSchema extends MaybeSchema> = TSchema extends z.ZodTypeAny ? z.infer<TSchema> : undefined;

export const typedRoute = <
  TParams extends MaybeSchema,
  TQuery extends MaybeSchema,
  TBody extends MaybeSchema,
  TResponse extends MaybeSchema,
>(
  app: FastifyInstance,
  options: {
    method: HTTPMethods;
    url: string;
    params?: TParams;
    query?: TQuery;
    body?: TBody;
    response?: TResponse;
    bodyLimit?: number;
      handler: (args: {
      request: FastifyRequest;
      reply: FastifyReply;
      params: InferSchema<TParams>;
      query: InferSchema<TQuery>;
      body: InferSchema<TBody>;
      }) => Promise<InferSchema<TResponse> | string | Uint8Array> | InferSchema<TResponse> | string | Uint8Array;
  },
) => {
  app.route({
    method: options.method,
    url: options.url,
    bodyLimit: options.bodyLimit,
    async handler(request, reply) {
      const params = options.params ? options.params.parse(request.params) : undefined;
      const query = options.query ? options.query.parse(request.query) : undefined;
      const body = options.body ? options.body.parse(request.body) : undefined;
      const result = await options.handler({
        request,
        reply,
        params: params as InferSchema<TParams>,
        query: query as InferSchema<TQuery>,
        body: body as InferSchema<TBody>,
      });
      if (reply.sent || result === undefined) {
        return;
      }
      return options.response ? options.response.parse(result) : result;
    },
  });
};

export const registerErrorHandler = (app: FastifyInstance) => {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        message: error.issues[0]?.message ?? 'Ungültige Anfrage.',
        issues: error.issues,
      });
    }

    let cause: unknown = error;
    const seen = new Set<object>();
    while (typeof cause === 'object' && cause !== null && !seen.has(cause)) {
      seen.add(cause);
      const databaseCode = 'code' in cause ? cause.code : undefined;
      if (databaseCode === '23505' || databaseCode === '23503') {
        return reply.code(409).send({
          message: databaseCode === '23505'
            ? 'Der Eintrag oder die Nummer ist bereits vorhanden.'
            : 'Der Eintrag verweist auf einen fehlenden oder noch verwendeten Datensatz.',
        });
      }
      cause = 'cause' in cause ? cause.cause : undefined;
    }

    const statusCode = error instanceof Error
      ? (error as Error & { statusCode?: unknown }).statusCode
      : undefined;
    if (error instanceof Error && typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600 && statusCode !== 500) {
      return reply.code(statusCode).send({ message: error.message });
    }

    if (error instanceof Error) {
      const typedCode = (error as Error & { code?: unknown }).code;
      const code = typeof typedCode === 'string' ? typedCode : error.message.split(':', 1)[0] ?? error.message;
      if (/id already belongs to another tenant/i.test(error.message)) {
        return reply.code(404).send({ message: 'Datensatz nicht gefunden.' });
      }
      const status =
        /^(?:Project|Client|Invoice|Offer|Order confirmation|Draft|Journal entry) not found$/i.test(code) ? 404 :
        /NOT_FOUND$/.test(code) ? 404 :
        code === 'DOCUMENT_CHAIN_CONFLICT' ? 409 :
        code === 'DOCUMENT_CHAIN_INVALID' ? 422 :
        /^(ACCOUNTING_CHART_LOCKED|REPORT_CHART_MISMATCH|ACCOUNTING_SOURCE_RUN_CONFLICT|POSTING_DATE_IN_CLOSED_PERIOD|BACKFILL_STALE_PREVIEW|BACKFILL_CONFIRMATION_HASH_MISMATCH|DATEV_EXPORT_CONTENT_UNAVAILABLE|DATEV_EXPORT_HASH_MISMATCH|INCOMING_INVOICE_DOCUMENT_DUPLICATE|INCOMING_INVOICE_DOCUMENT_HASH_MISMATCH|INCOMING_INVOICE_DOCUMENT_IMMUTABLE|DRAFT_NOT_APPROVED|DOCUMENT_HAS_ALLOCATIONS|DOCUMENT_NOT_POSTED|DOCUMENT_NOT_POSTABLE|DOCUMENT_REVERSAL_REQUIRED|PAYMENT_REVERSAL_REQUIRED|ASSET_REVERSAL_REQUIRED|ASSET_CORRECTION_REQUIRED|VENDOR_HAS_POSTED_DOCUMENTS|PAYMENT_SOURCE_ALREADY_BOOKED|PERIOD_LOCKED|SOFT_LOCK_|FINALIZED_|ALREADY_|.*_POSTED$|.*_CLOSED$)/.test(code) ? 409 :
        /^(UNBALANCED_|TAX_|VALIDATION_|INVALID_JOURNAL_|INVALID_LINE_|INVALID_TAX_|AMBIGUOUS_TAX_|UNKNOWN_ACCOUNT|REPORT_SNAPSHOT_BLOCKED_)/.test(code) ? 422 :
        /^(PUBLIC_REPORT_CATALOG_UNAVAILABLE|REPORT_|REPORTING_|ASSET_|ACCOUNTING_ASSET_|ACQUISITION_ACCOUNT_NOT_IN_CHART|INCOMING_INVOICE_ASSET_LINE_MISMATCH|Zeile \d+$)/.test(code) ? 422 :
        /^(EUR_RULE_TARGET_|EUR_CATALOG_UNAVAILABLE|VAT_RATE_REQUIRED)/.test(code) ? 400 :
        /^(PAYMENT_SOURCE_MISMATCH|PAYMENT_SOURCE_DIRECTION_MISMATCH|PAYMENT_PARTY_MISMATCH)/.test(code) ? 422 :
        /^(ACCOUNTING_AUDIT_REASON_REQUIRED|DATEV[- ]|DATEV_EXPORT_CONTENT_REQUIRED|DATEV_|INCOMING_INVOICE_DOCUMENT_|INVALID_|MISSING_|UNKNOWN_|EMPTY_|PAYMENT_|OPEN_ITEM_|DRAFT_|BANK_TRANSACTION_|BACKFILL_)/.test(code) ? 400 :
        /^(Invalid workflow transition|Draft not found|Journal entry not found|Journal entry cannot|Journal entry has no lines|Invalid reversal posting date|Reversal reason is required)/i.test(code) ? 409 : undefined;
      if (status) {
        return reply.code(status).send({ message: error.message });
      }
    }

    request.log.error(error);
    return reply.code(500).send({
      message: 'Interner Serverfehler.',
    });
  });
};
