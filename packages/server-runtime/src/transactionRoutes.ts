import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invoiceSchema } from '@billme/server-core';
import {
  findServerTransactionMatches,
  linkServerTransaction,
  listServerTransactions,
  commitServerTransactionImport,
  getServerImportBatchDetails,
  listServerImportBatches,
  previewServerTransactionImport,
  rollbackServerImportBatch,
  unlinkServerTransaction,
} from '@billme/server-data';
import { ApiError, typedRoute } from './http.js';
import { createMutationContext, requireDatabase, requireMutationSessionFor, requireSession, toMutationActor } from './runtimeContext.js';

const transactionSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  date: z.string(),
  amount: z.number(),
  type: z.enum(['income', 'expense']),
  counterparty: z.string(),
  purpose: z.string(),
  linkedInvoiceId: z.string().optional(),
  status: z.enum(['pending', 'booked']),
  dedupHash: z.string().optional(),
  importBatchId: z.string().optional(),
  suggestedAccountNumber: z.string().optional(),
  suggestionReason: z.string().optional(),
  suggestionLayer: z.enum(['rule', 'counterparty', 'bayes', 'keyword', 'fallback']).optional(),
  suggestionConfidence: z.number().optional(),
});

const transactionIdParams = z.object({ transactionId: z.string().min(1) });
const listQuery = z.object({
  accountId: z.string().trim().min(1).optional(),
  type: z.enum(['income', 'expense']).optional(),
  linkedOnly: z.coerce.boolean().optional(),
  unlinkedOnly: z.coerce.boolean().optional(),
});
const mutationBody = z.object({ reason: z.string().trim().min(1) });
const linkBody = mutationBody.extend({ invoiceId: z.string().min(1) });
const csvMappingSchema = z.object({
  dateColumn: z.string().min(1),
  amountColumn: z.string().min(1),
  counterpartyColumn: z.string().optional(),
  purposeColumn: z.string().optional(),
  statusColumn: z.string().optional(),
  externalIdColumn: z.string().optional(),
  currencyColumn: z.string().optional(),
  currencyExpected: z.string().optional(),
});
const csvProfileSchema = z.enum(['auto', 'fints', 'paypal', 'stripe', 'generic']);
const importPreviewBody = z.object({
  path: z.string().min(1),
  profile: csvProfileSchema.optional(),
  mapping: csvMappingSchema.optional(),
  encoding: z.enum(['utf8', 'win1252']).optional(),
  delimiter: z.string().optional(),
  maxRows: z.number().int().min(1).max(200).optional(),
  accountIdForDedupHash: z.string().optional(),
});
const importCommitBody = z.object({
  path: z.string().min(1),
  accountId: z.string().min(1),
  profile: csvProfileSchema.optional(),
  mapping: csvMappingSchema,
  encoding: z.enum(['utf8', 'win1252']).optional(),
  delimiter: z.string().optional(),
});
const importPreviewRowSchema = z.object({
  rowIndex: z.number().int(),
  raw: z.record(z.string(), z.string()),
  parsed: z.object({
    date: z.string().optional(),
    amount: z.number().optional(),
    type: z.enum(['income', 'expense']).optional(),
    counterparty: z.string().optional(),
    purpose: z.string().optional(),
    status: z.enum(['pending', 'booked']).optional(),
    externalId: z.string().optional(),
    currency: z.string().optional(),
  }),
  errors: z.array(z.string()),
  dedupHash: z.string().optional(),
});
const importPreviewResponse = z.object({
  path: z.string(),
  fileName: z.string(),
  fileSha256: z.string(),
  delimiter: z.string(),
  headers: z.array(z.string()),
  profile: z.enum(['fints', 'paypal', 'stripe', 'generic']),
  suggestedMapping: csvMappingSchema,
  rows: z.array(importPreviewRowSchema),
  stats: z.object({
    totalRows: z.number().int(),
    previewRows: z.number().int(),
    validRows: z.number().int(),
    errorRows: z.number().int(),
  }),
});
const importCommitResponse = z.object({
  batchId: z.string(),
  imported: z.number().int(),
  skipped: z.number().int(),
  errors: z.array(z.object({ rowIndex: z.number().int(), message: z.string() })),
  fileSha256: z.string(),
});
const importBatchSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  profile: z.string(),
  fileName: z.string(),
  fileSha256: z.string(),
  mappingJson: z.unknown(),
  importedCount: z.number().int(),
  skippedCount: z.number().int(),
  errorCount: z.number().int(),
  createdAt: z.string(),
  rolledBackAt: z.string().optional(),
  rollbackReason: z.string().optional(),
});
const importBatchDetailsResponse = z.object({
  batch: importBatchSchema,
  transactions: z.array(z.object({
    id: z.string(),
    date: z.string(),
    amount: z.number(),
    type: z.enum(['income', 'expense']),
    counterparty: z.string(),
    purpose: z.string(),
    linkedInvoiceId: z.string().optional(),
    status: z.enum(['pending', 'booked']),
  })),
  canRollback: z.boolean(),
  linkedInvoiceCount: z.number().int(),
});
const importBatchListQuery = z.object({
  accountId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().optional(),
});
const importBatchIdParams = z.object({ batchId: z.string().min(1) });
const rollbackImportBody = z.object({ reason: z.string().trim().min(1) });

const requireMutation = (
  app: FastifyInstance,
  product: 'lite' | 'pro',
  authorization: string | undefined,
) => requireMutationSessionFor(app, product, authorization, 'Transaction mutation requires owner, admin, or accountant role');

const mapMutationError = (error: unknown): never => {
  if (!(error instanceof Error)) throw error;
  if (error.message === 'TRANSACTION_NOT_FOUND' || error.message === 'INVOICE_NOT_FOUND') {
    throw new ApiError(404, error.message);
  }
  if (error.message === 'TRANSACTION_ALREADY_LINKED' || error.message === 'TRANSACTION_NOT_LINKED') {
    throw new ApiError(409, error.message);
  }
  throw error;
};

const mapImportError = (error: unknown): never => {
  if (!(error instanceof Error)) throw error;
  if (error.message === 'ACCOUNT_NOT_FOUND' || error.message === 'IMPORT_BATCH_NOT_FOUND') {
    throw new ApiError(404, error.message);
  }
  if (
    error.message === 'IMPORT_BATCH_ALREADY_ROLLED_BACK' ||
    error.message === 'IMPORT_BATCH_LINKED' ||
    error.message === 'ROLLBACK_REASON_REQUIRED'
  ) {
    throw new ApiError(409, error.message);
  }
  throw error;
};

export const registerTransactionRoutes = (app: FastifyInstance, product: 'lite' | 'pro'): void => {
  const prefix = `/api/v1/${product}`;

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/transactions`,
    query: listQuery,
    response: z.array(transactionSchema),
    async handler({ request, query }) {
      const session = await requireSession(app, product, request.headers.authorization);
      return listServerTransactions(requireDatabase(app), session.scope, query);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/finance/import/preview`,
    body: importPreviewBody,
    response: importPreviewResponse,
    async handler({ request, body }) {
      await requireSession(app, product, request.headers.authorization);
      return previewServerTransactionImport(body);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/finance/import/commit`,
    body: importCommitBody,
    response: importCommitResponse,
    async handler({ request, body }) {
      const session = await requireMutation(app, product, request.headers.authorization);
      try {
        return await commitServerTransactionImport(requireDatabase(app), session.scope, body, toMutationActor(session));
      } catch (error) {
        return mapImportError(error);
      }
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/finance/import-batches`,
    query: importBatchListQuery,
    response: z.array(importBatchSchema),
    async handler({ request, query }) {
      const session = await requireSession(app, product, request.headers.authorization);
      return listServerImportBatches(requireDatabase(app), session.scope, query.accountId, query.limit);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/finance/import-batches/:batchId`,
    params: importBatchIdParams,
    response: importBatchDetailsResponse,
    async handler({ request, params }) {
      const session = await requireSession(app, product, request.headers.authorization);
      try {
        return await getServerImportBatchDetails(requireDatabase(app), session.scope, params.batchId);
      } catch (error) {
        return mapImportError(error);
      }
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/finance/import-batches/:batchId/rollback`,
    params: importBatchIdParams,
    body: rollbackImportBody,
    response: z.object({ success: z.literal(true), deletedCount: z.number().int() }),
    async handler({ request, params, body }) {
      const session = await requireMutation(app, product, request.headers.authorization);
      try {
        return await rollbackServerImportBatch(requireDatabase(app), session.scope, params.batchId, body.reason, createMutationContext(session, body.reason).actor);
      } catch (error) {
        return mapImportError(error);
      }
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/transactions/:transactionId/matches`,
    params: transactionIdParams,
    response: z.object({ transaction: transactionSchema, suggestions: z.array(z.object({ invoice: invoiceSchema, confidence: z.enum(['high', 'medium', 'low']), matchReasons: z.array(z.string()), amountDiff: z.number() })) }),
    async handler({ request, params }) {
      const session = await requireSession(app, product, request.headers.authorization);
      try {
        return await findServerTransactionMatches(requireDatabase(app), session.scope, params.transactionId);
      } catch (error) {
        return mapMutationError(error);
      }
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/transactions/:transactionId/link`,
    params: transactionIdParams,
    body: linkBody,
    response: z.object({ success: z.literal(true), invoice: invoiceSchema }),
    async handler({ request, params, body }) {
      const session = await requireMutation(app, product, request.headers.authorization);
      try {
        return await linkServerTransaction(requireDatabase(app), session.scope, params.transactionId, body.invoiceId, body.reason, createMutationContext(session, body.reason).actor);
      } catch (error) {
        return mapMutationError(error);
      }
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/transactions/:transactionId/unlink`,
    params: transactionIdParams,
    body: mutationBody,
    response: z.object({ success: z.literal(true) }),
    async handler({ request, params, body }) {
      const session = await requireMutation(app, product, request.headers.authorization);
      try {
        return await unlinkServerTransaction(requireDatabase(app), session.scope, params.transactionId, body.reason, createMutationContext(session, body.reason).actor);
      } catch (error) {
        return mapMutationError(error);
      }
    },
  });
};
