import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
  periodClosedMessage,
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
  matchedManualEntryId: z.string().optional(), appliedAmountCents: z.number().int().optional(), unallocatedAmountCents: z.number().int().optional(),
  status: z.enum(['pending', 'booked']),
  dedupHash: z.string().optional(),
  importBatchId: z.string().optional(),
  suggestedAccountNumber: z.string().optional(),
  suggestionReason: z.string().optional(),
  suggestionLayer: z.enum(['rule', 'counterparty', 'bayes', 'keyword', 'fallback']).optional(),
  suggestionConfidence: z.number().optional(),
});

const transactionIdParams = z.object({ transactionId: z.string().min(1) });
const queryBoolean = z.union([z.boolean(), z.enum(['true', 'false'])]).transform((value) => value === true || value === 'true');
const listQuery = z.object({
  accountId: z.string().trim().min(1).optional(),
  type: z.enum(['income', 'expense']).optional(),
  linkedOnly: queryBoolean.optional(),
  unlinkedOnly: queryBoolean.optional(),
});
const mutationBody = z.object({ reason: z.string().trim().min(1) });
const linkBody = mutationBody.extend({ invoiceId: z.string().min(1), appliedAmountCents: z.number().int().positive().optional() });
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
  path: z.string().min(1).optional(),
  fileName: z.string().trim().min(1).max(255).optional(),
  contentBase64: z.string().min(1).max(28_000_000).optional(),
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
  raw: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
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
  if (error.message === 'PAYMENT_ALLOCATION_INVALID') throw new ApiError(400, error.message);
  if (error.message === 'LITE_PERIOD_CLOSED') throw new ApiError(409, periodClosedMessage((error as Error & { period?: string }).period ?? ''));
  throw error;
};

const mapImportError = (error: unknown): never => {
  if (!(error instanceof Error)) throw error;
  if (/^Fehler beim (Lesen|Dekodieren|Parsen) der CSV-Datei:/.test(error.message)) {
    throw new ApiError(400, 'CSV-Datei konnte nicht gelesen oder verarbeitet werden.');
  }
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
  const uploads = new Map<string, { path: string; directory: string; tenantId: string; userId: string; expiresAt: number; committed?: boolean }>();
  app.addHook('onClose', async () => {
    await Promise.all([...uploads.values()].map((upload) => rm(upload.directory, { recursive: true, force: true })));
    uploads.clear();
  });
  const cleanUploads = async () => {
    for (const [handle, upload] of uploads) {
      if (upload.expiresAt <= Date.now()) { uploads.delete(handle); await rm(upload.directory, { recursive: true, force: true }); }
    }
  };
  const resolveImportPath = async (path: string | undefined, tenantId: string, userId: string): Promise<string> => {
    await cleanUploads();
    const upload = path ? uploads.get(path) : undefined;
    if (upload && upload.tenantId === tenantId && upload.userId === userId) return upload.path;
    if (path?.startsWith('import-upload:')) throw new ApiError(404, 'Import ist abgelaufen oder gehört zu einer anderen Sitzung. Datei erneut auswählen.');
    if (app.runtimeProfile === 'embedded' && path) return path;
    throw new ApiError(400, 'Bitte die CSV-Datei hochladen. Server-Dateipfade werden nicht angenommen.');
  };

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
    bodyLimit: 29_000_000,
    response: importPreviewResponse,
    async handler({ request, body }) {
      const session = await requireMutation(app, product, request.headers.authorization);
      let handle = body.path;
      if (body.contentBase64 !== undefined) {
        if (!body.fileName || !/\.csv$/i.test(body.fileName) || basename(body.fileName) !== body.fileName || /[\\/\x00-\x1f]/.test(body.fileName)) throw new ApiError(400, 'Bitte eine CSV-Datei mit gültigem Dateinamen auswählen.');
        const bytes = Buffer.from(body.contentBase64, 'base64');
        if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024 || bytes.toString('base64') !== body.contentBase64) throw new ApiError(400, 'CSV-Datei ist ungültig oder größer als 20 MB.');
        await cleanUploads();
        const owned = [...uploads.entries()].filter(([, upload]) => upload.userId === session.user.id && upload.tenantId === session.scope.tenantId);
        if (owned.filter(([, upload]) => !upload.committed).length >= 5) throw new ApiError(429, 'Zu viele offene Importe. Bitte einen Import abschließen oder 30 Minuten warten.');
        for (const [oldHandle, upload] of owned.filter(([, upload]) => upload.committed).slice(0, -4)) { uploads.delete(oldHandle); await rm(upload.directory, { recursive: true, force: true }); }
        const directory = await mkdtemp(join(tmpdir(), 'billme-csv-'));
        const path = join(directory, body.fileName);
        await writeFile(path, bytes, { mode: 0o600 });
        handle = `import-upload:${randomUUID()}`;
        uploads.set(handle, { path, directory, tenantId: session.scope.tenantId, userId: session.user.id, expiresAt: Date.now() + 30 * 60 * 1000 });
      }
      const path = await resolveImportPath(handle, session.scope.tenantId, session.user.id);
      try {
        const preview = await previewServerTransactionImport({ ...body, path, mapping: body.mapping ? { ...body.mapping, currencyExpected: 'EUR' } : undefined });
        return { ...preview, path: handle! };
      } catch (error) {
        return mapImportError(error);
      }
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
        const path = await resolveImportPath(body.path, session.scope.tenantId, session.user.id);
        const result = await commitServerTransactionImport(requireDatabase(app), session.scope, { ...body, path, mapping: { ...body.mapping, currencyExpected: 'EUR' } }, toMutationActor(session));
        const upload = uploads.get(body.path);
        if (upload) upload.committed = true;
        return result;
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
        return await linkServerTransaction(requireDatabase(app), session.scope, params.transactionId, body.invoiceId, body.reason, createMutationContext(session, body.reason).actor, body.appliedAmountCents);
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
