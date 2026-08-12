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
    handler: (args: {
      request: FastifyRequest;
      reply: FastifyReply;
      params: InferSchema<TParams>;
      query: InferSchema<TQuery>;
      body: InferSchema<TBody>;
    }) => Promise<InferSchema<TResponse> | string> | InferSchema<TResponse> | string;
  },
) => {
  app.route({
    method: options.method,
    url: options.url,
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
        message: error.issues[0]?.message ?? 'Invalid request payload',
        issues: error.issues,
      });
    }

    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({
        message: error.message,
      });
    }

    if (error instanceof Error) {
      const code = error.message.split(':', 1)[0] ?? error.message;
      const status =
        /NOT_FOUND$/.test(code) ? 404 :
        /^(POSTING_DATE_IN_CLOSED_PERIOD|BACKFILL_STALE_PREVIEW|BACKFILL_CONFIRMATION_HASH_MISMATCH|DRAFT_NOT_APPROVED|DOCUMENT_HAS_ALLOCATIONS|DOCUMENT_NOT_POSTED|VENDOR_HAS_POSTED_DOCUMENTS|PAYMENT_SOURCE_ALREADY_BOOKED|PERIOD_LOCKED|SOFT_LOCK_|FINALIZED_|ALREADY_|.*_POSTED$|.*_CLOSED$)/.test(code) ? 409 :
        /^(UNBALANCED_|TAX_|VALIDATION_|INVALID_JOURNAL_|INVALID_LINE_|INVALID_TAX_|AMBIGUOUS_TAX_|UNKNOWN_ACCOUNT)/.test(code) ? 422 :
        /^(PAYMENT_SOURCE_MISMATCH|PAYMENT_SOURCE_DIRECTION_MISMATCH|PAYMENT_PARTY_MISMATCH)/.test(code) ? 422 :
        /^(ACCOUNTING_AUDIT_REASON_REQUIRED|INVALID_|MISSING_|UNKNOWN_|EMPTY_|PAYMENT_|OPEN_ITEM_|DRAFT_|BANK_TRANSACTION_|BACKFILL_)/.test(code) ? 400 :
        /^(Invalid workflow transition|Draft not found|Journal entry not found|Journal entry cannot|Journal entry has no lines|Invalid reversal posting date|Reversal reason is required)/i.test(code) ? 409 : undefined;
      if (status) {
        return reply.code(status).send({ message: error.message });
      }
    }

    request.log.error(error);
    return reply.code(500).send({
      message: error instanceof Error ? error.message : 'Internal server error',
    });
  });
};
