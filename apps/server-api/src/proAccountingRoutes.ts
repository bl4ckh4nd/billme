import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { createProAccountingAssetService, createProAccountingService } from '@billme/accounting-engine';
import { buildDatevBuchungsstapelCsv } from '@billme/accounting-engine/datev-export';
import type {
  AccountingMutationContext,
  ProDraftActionRequest,
  TenantScope,
} from '@billme/server-core';
import type {
  AccountingBackfillConfirmation,
  AccountingAccountMapping,
  IncomingInvoiceEntity,
} from '@billme/accounting-shared';
import { createPostgresProAccountingRepository } from '@billme/server-data';
import {
  accountingAccountMappingSchema,
  accountingBackfillPreviewSchema,
  accountingBackfillResultSchema,
  accountingPolicySchema,
  accountingPostingPreviewSchema,
  assetDepreciationScheduleEntrySchema,
  assetSchema,
  assetUpsertSchema,
  bookingDraftEntitySchema,
  incomingInvoiceSchema,
  journalEntryEntitySchema,
  ledgerBalanceRowSchema,
  openItemSchema,
  transactionSchema,
  vendorSchema,
} from '@billme/desktop-contracts-pro/schemas';
import { z } from 'zod';
import { ApiError, typedRoute } from './http.js';
import { requirePool, requireSession } from './app.js';

const repositoryFor = (app: FastifyInstance): ReturnType<typeof createPostgresProAccountingRepository> => {
  const pool = requirePool(app);
  return createPostgresProAccountingRepository(pool);
};

const serviceFor = (app: FastifyInstance) => {
  const repository = repositoryFor(app);
  // The shared service still exposes the legacy report DTO for Lite callers.
  // Keep that compatibility projection at this boundary; Pro report routes use
  // the canonical repository result directly and never calculate reports twice.
  const legacyRepository = {
    ...repository,
    getGuvReport: async (scope: TenantScope, args?: { from?: string; to?: string }) => {
      const report = await repository.getGuvReport(scope, { ...args, profile: 'guv' });
      return {
        from: report.snapshot.from,
        to: report.snapshot.to,
        rows: report.rows.map((row) => ({ positionKey: row.position, positionLabel: row.label, amount: row.amount, accountRefs: row.accountRefs ?? row.accountNumbers })),
        netResult: 'netResult' in report && typeof report.netResult === 'number' ? report.netResult : 0,
        unmappedAccounts: report.mappingHealth.unmappedAccounts.map((accountNumber) => ({ accountNumber, amount: 0 })),
        blocking: report.mappingHealth.blocking,
      };
    },
    getBilanzReport: async (scope: TenantScope, args?: { asOfDate?: string }) => {
      const report = await repository.getBilanzReport(scope, args);
      return {
        asOfDate: report.snapshot.asOfDate ?? args?.asOfDate ?? new Date().toISOString().slice(0, 10),
        assets: report.assets.flatMap((row) => row.accountNumbers.map((accountNumber) => ({ accountNumber, amount: row.amount }))),
        liabilities: report.liabilities.flatMap((row) => row.accountNumbers.map((accountNumber) => ({ accountNumber, amount: row.amount }))),
        totals: report.totals,
        unmappedAccounts: report.mappingHealth.unmappedAccounts.map((accountNumber) => ({ accountNumber, amount: 0 })),
        blocking: report.mappingHealth.blocking,
      };
    },
  };
  return { ...createProAccountingService(legacyRepository), ...createProAccountingAssetService(repository), repository };
};

const reasonSchema = z.string().trim().min(1, 'reason is required');
const idParams = z.object({ id: z.string().min(1) });
const transactionParams = z.object({ transactionId: z.string().min(1) });
const draftParams = z.object({ draftId: z.string().min(1) });
const reportRange = z.object({ from: z.string().optional(), to: z.string().optional(), chart: z.enum(['SKR03', 'SKR04']).optional(), profile: z.string().trim().min(1).optional() });
export const reportSnapshotQuerySchema = z.object({ reportType: z.enum(['susa', 'eur', 'guv', 'management-guv', 'hgb-guv', 'bilanz', 'hgb-bilanz', 'bwa01']).optional() });
export const reportSnapshotBodySchema = z.object({
  reportType: z.enum(['susa', 'eur', 'guv', 'management-guv', 'hgb-guv', 'bilanz', 'hgb-bilanz', 'bwa01']),
  from: z.string().optional(),
  to: z.string().optional(),
  asOfDate: z.string().optional(),
  chart: z.enum(['SKR03', 'SKR04']).optional(),
  profile: z.string().trim().min(1).optional(),
  reason: reasonSchema,
}).superRefine((body, ctx) => {
  if (body.reportType !== 'eur') return;
  if (body.from !== undefined && body.from !== '2025-01-01') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: 'EÜR snapshots require 2025-01-01.' });
  if (body.to !== undefined && body.to !== '2025-12-31') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'EÜR snapshots require 2025-12-31.' });
  if (body.asOfDate !== undefined && body.asOfDate !== '2025-12-31') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['asOfDate'], message: 'EÜR snapshots require 2025-12-31.' });
});
export const reportMappingTypeSchema = z.enum(['bwa01', 'management-guv', 'hgb-guv', 'hgb-bilanz']);
export const mappingHealthQuerySchema = z.object({ chart: z.enum(['SKR03', 'SKR04']).optional(), reportType: reportMappingTypeSchema.optional() });
export const mappingPositionsQuerySchema = z.object({ reportType: reportMappingTypeSchema });
export const mappingOverrideBodySchema = z.object({
  reason: reasonSchema,
  chart: z.enum(['SKR03', 'SKR04']),
  accountNumber: z.string().trim().min(1),
  statementType: reportMappingTypeSchema,
  positionKey: z.string().trim().min(1),
  positionLabel: z.string().trim().min(1),
  balanceSide: z.enum(['asset', 'liability']).optional(),
});
const reportSnapshotQuery = reportSnapshotQuerySchema;
const reportSnapshotBody = reportSnapshotBodySchema;
const mappingHealthQuery = mappingHealthQuerySchema;
const mappingPositionsQuery = mappingPositionsQuerySchema;
const mappingOverrideBody = mappingOverrideBodySchema;
export const susaReportQuerySchema = reportRange.extend({ asOfDate: z.string().optional() });
export const eurReportQuerySchema = z.object({ from: z.literal('2025-01-01').default('2025-01-01'), to: z.literal('2025-12-31').default('2025-12-31') });
export const datevExportQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: reasonSchema.default('DATEV-Buchungsstapel exportiert'),
  consultantNumber: z.string().regex(/^(?:\d{4,6}|\d{7})$/),
  clientNumber: z.string().regex(/^\d{1,5}$/),
  fiscalYearStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  accountLength: z.coerce.number().int().min(4).max(8),
  encoding: z.enum(['cp1252', 'utf8-bom']).default('cp1252'),
});
const datevExportQuery = datevExportQuerySchema;
const asOfDate = z.object({ asOfDate: z.string().optional(), chart: z.enum(['SKR03', 'SKR04']).optional(), profile: z.string().trim().min(1).optional() });
export const csvEscape = (value: unknown): string => {
  const text = String(value ?? '');
  return /[;",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const journalQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  accountNumbers: z.union([z.string(), z.array(z.string())]).optional(),
  limit: z.coerce.number().int().positive().max(5000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
const draftActionBody = z.object({
  reason: reasonSchema,
  action: z.enum([
    'save_draft',
    'submit_for_review',
    'approve',
    'reject',
    'post',
    'reverse',
    'create_correction',
    'request_receipt',
  ]),
  rejectReason: z.string().optional(),
});
const postDraftBody = z.object({
  reason: reasonSchema,
  postingDate: z.string().optional(),
  idempotencyKey: z.string().min(1).optional(),
  softLockOverride: z.boolean().optional(),
  overrideReason: z.string().optional(),
});
const reverseBody = z.object({
  reason: reasonSchema,
  postingDate: z.string().optional(),
  softLockOverride: z.boolean().optional(),
  overrideReason: z.string().optional(),
});
const policyBody = z.object({ reason: reasonSchema, activeChart: z.enum(['SKR03', 'SKR04']), vatMethod: z.enum(['soll', 'ist']) });
const mappingBody = z.object({
  reason: reasonSchema,
  id: z.string().optional(),
  chart: z.enum(['SKR03', 'SKR04']),
  role: z.enum(['accounts_receivable', 'accounts_payable', 'bank', 'revenue', 'expense', 'asset', 'output_vat', 'output_vat_deferred', 'input_vat']),
  accountNumber: z.string().trim().min(1),
});
const vendorInput = vendorSchema.omit({ tenantId: true, createdAt: true, updatedAt: true });
const vendorBody = z.object({ reason: reasonSchema, vendor: vendorInput });
const incomingInvoiceInput = incomingInvoiceSchema.omit({ tenantId: true, createdAt: true, updatedAt: true, accountingStatus: true, accountingSnapshot: true });
const incomingInvoiceBody = z.object({
  reason: reasonSchema,
  invoice: incomingInvoiceInput,
});
const outgoingInvoiceBody = z.object({
  reason: reasonSchema,
  invoiceId: z.string().min(1),
  reservationId: z.string().min(1).optional(),
  softLockOverride: z.boolean().optional(),
  overrideReason: z.string().optional(),
});
const outgoingInvoicePostBody = outgoingInvoiceBody.extend({ reservationId: z.string().min(1) });
const incomingInvoiceActionBody = z.object({
  reason: reasonSchema,
  invoiceId: z.string().min(1),
  softLockOverride: z.boolean().optional(),
  overrideReason: z.string().optional(),
});
const paymentBody = z.object({
  reason: reasonSchema,
  payment: z.object({
    paymentId: z.string().optional(),
    sourceType: z.enum(['bank_transaction', 'invoice_payment', 'manual']),
    sourceId: z.string().min(1),
    partyType: z.enum(['debtor', 'creditor']),
    partyId: z.string().optional(),
    paymentDate: z.string(),
    amount: z.number().positive(),
    bankAccountNumber: z.string().min(1),
    method: z.string().optional(),
    allocations: z.array(z.object({ openItemId: z.string().min(1), amount: z.number().positive() })),
    allocationEventId: z.string().min(1),
  }),
});
const remainingPaymentBody = z.object({
  reason: reasonSchema,
  paymentId: z.string().min(1),
  allocations: z.array(z.object({ openItemId: z.string().min(1), amount: z.number().positive() })),
  allocationEventId: z.string().min(1),
});
const reverseDocumentBody = z.object({
  reason: reasonSchema,
  documentType: z.enum(['outgoing_invoice', 'incoming_invoice']),
  documentId: z.string().min(1),
  postingDate: z.string().optional(),
  softLockOverride: z.boolean().optional(),
  overrideReason: z.string().optional(),
});
const backfillBody = z.object({
  reason: reasonSchema,
  runId: z.string().min(1),
  confirmationHash: z.string().min(1),
});
const assetBody = z.object({ asset: assetUpsertSchema, reason: reasonSchema });
const depreciationBody = z.object({
  reason: reasonSchema,
  postingDate: z.string(),
  year: z.number().int(),
  softLockOverride: z.boolean().optional(),
  overrideReason: z.string().min(1).optional(),
}).refine((value) => !value.softLockOverride || Boolean(value.overrideReason?.trim()), { path: ['overrideReason'], message: 'overrideReason required for soft-lock override' });
const disposalBody = z.object({
  reason: reasonSchema,
  disposalDate: z.string(),
  proceeds: z.number().nonnegative(),
  taxRate: z.union([z.literal(0), z.literal(7), z.literal(19)]).optional(),
  proceedsAccountNumber: z.string().min(1).optional(),
  softLockOverride: z.boolean().optional(),
  overrideReason: z.string().min(1).optional(),
}).refine((value) => !value.softLockOverride || Boolean(value.overrideReason?.trim()), { path: ['overrideReason'], message: 'overrideReason required for soft-lock override' });

const requireProSession = async (app: FastifyInstance, authHeader: string | undefined) =>
  requireSession(app, 'pro', authHeader);

const mutationFor = (session: Awaited<ReturnType<typeof requireProSession>>, reason: string): AccountingMutationContext => ({
  reason,
  actor: { type: 'user', id: session.user.id, displayName: session.user.fullName },
});

const requireMutationSession = async (app: FastifyInstance, authHeader: string | undefined) => {
  const session = await requireProSession(app, authHeader);
  if (!['owner', 'admin', 'accountant'].includes(session.role)) {
    throw new ApiError(403, 'Accounting mutation requires owner, admin, or accountant role');
  }
  return session;
};

const tenantDraft = (scope: TenantScope, draft: z.infer<typeof bookingDraftEntitySchema>) => ({
  ...draft,
  tenantId: scope.tenantId,
  // Workflow transitions are exclusively owned by the action/post routes. A
  // draft save can never approve or post an entity supplied by the browser.
  workflowStatus: 'incomplete' as const,
});

const CLIENT_CONTROLLED_WORKFLOW_STATUSES = new Set([
  'approved',
  'posted',
  'reversed',
  'corrected',
  'period_locked',
]);

export const registerProAccountingRoutes = (app: FastifyInstance) => {
  const prefix = '/api/v1/pro/accounting';

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/transactions`,
    response: z.array(transactionSchema),
    async handler({ request }) {
      const session = await requireProSession(app, request.headers.authorization);
      return serviceFor(app).listBankTransactions(session.scope);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/drafts/:transactionId`,
    params: transactionParams,
    response: bookingDraftEntitySchema.nullable(),
    async handler({ request, params }) {
      const session = await requireProSession(app, request.headers.authorization);
      return serviceFor(app).getDraftByTransactionId(session.scope, params.transactionId);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/drafts`,
    body: z.object({ reason: reasonSchema, draft: bookingDraftEntitySchema }),
    response: bookingDraftEntitySchema,
    async handler({ request, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      if (CLIENT_CONTROLLED_WORKFLOW_STATUSES.has(body.draft.workflowStatus)) {
        throw new ApiError(400, 'workflowStatus is server controlled; use the draft action or post route');
      }
      const saved = await serviceFor(app).saveDraft(session.scope, {
        ...tenantDraft(session.scope, body.draft),
        mutation: mutationFor(session, body.reason),
      });
      return saved;
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/drafts/:transactionId/action`,
    params: transactionParams,
    body: draftActionBody,
    response: bookingDraftEntitySchema,
    async handler({ request, params, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      const action: ProDraftActionRequest = {
        transactionId: params.transactionId,
        action: body.action,
        rejectReason: body.rejectReason,
        mutation: mutationFor(session, body.reason),
      };
      const saved = await serviceFor(app).dispatchDraftAction(session.scope, action);
      return saved;
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/drafts/:draftId/post`,
    params: draftParams,
    body: postDraftBody,
    async handler({ request, params, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      const posted = await serviceFor(app).postDraft(session.scope, params.draftId, {
        postingDate: body.postingDate,
        idempotencyKey: body.idempotencyKey,
        softLockOverride: body.softLockOverride,
        overrideReason: body.overrideReason,
        mutation: mutationFor(session, body.reason),
      });
      return posted;
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/journal`,
    query: journalQuery,
    async handler({ request, query }) {
      const session = await requireProSession(app, request.headers.authorization);
      const accountNumbers = query.accountNumbers
        ? Array.isArray(query.accountNumbers) ? query.accountNumbers : [query.accountNumbers]
        : undefined;
      return serviceFor(app).listJournalEntries(session.scope, { ...query, accountNumbers });
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/journal/:id/reverse`,
    params: idParams,
    body: reverseBody,
    async handler({ request, params, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      const reversed = await serviceFor(app).reverseJournalEntry(session.scope, params.id, body.reason, {
        postingDate: body.postingDate,
        softLockOverride: body.softLockOverride,
        overrideReason: body.overrideReason,
        mutation: mutationFor(session, body.reason),
      });
      return reversed;
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/balances`,
    query: asOfDate,
    response: z.array(ledgerBalanceRowSchema),
    async handler({ request, query }) {
      const session = await requireProSession(app, request.headers.authorization);
      return serviceFor(app).getLedgerBalances(session.scope, query);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/ledger/balances`,
    query: asOfDate,
    response: z.array(ledgerBalanceRowSchema),
    async handler({ request, query }) {
      const session = await requireProSession(app, request.headers.authorization);
      return serviceFor(app).getLedgerBalances(session.scope, query);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/reports/susa`,
    query: susaReportQuerySchema,
    async handler({ request, query }) {
      const session = await requireProSession(app, request.headers.authorization);
      return serviceFor(app).getSusaReport(session.scope, {
        ...query,
        fromDate: query.from,
        asOfDate: query.to ?? query.asOfDate,
      });
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/reports/eur`,
    query: eurReportQuerySchema,
    async handler({ request, query }) {
      const session = await requireProSession(app, request.headers.authorization);
      try {
        return await repositoryFor(app).getEurReport(session.scope, query);
      } catch (error) {
        if (error instanceof Error && error.message === 'EUR_SERVER_REPORT_UNAVAILABLE') {
          throw new ApiError(503, 'EÜR ist im Server-Modus erst verfügbar, wenn der 2025-Katalog und die Kontenklassifikation importiert sind.');
        }
        if (error instanceof Error && error.message === 'EUR_PROFILE_REQUIRED') {
          throw new ApiError(503, 'EÜR ist nur für ein Einzelunternehmen mit Gewinnermittlung EÜR und Kalenderjahr 2025 verfügbar.');
        }
        if (error instanceof Error && error.message === 'EUR_RANGE_2025_REQUIRED') {
          throw new ApiError(400, 'EÜR unterstützt ausschließlich den Kalenderzeitraum 01.01.2025 bis 31.12.2025.');
        }
        throw error;
      }
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/reports/guv`,
    query: reportRange,
    async handler({ request, query }) {
      const session = await requireProSession(app, request.headers.authorization);
      return repositoryFor(app).getGuvReport(session.scope, { ...query, profile: 'management-guv' });
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/reports/bwa01`,
    query: reportRange,
    async handler({ request, query }) {
      const session = await requireProSession(app, request.headers.authorization);
      return serviceFor(app).repository.getBwa01Report(session.scope, query);
    },
  });

  for (const reportPath of ['management-guv', 'hgb-guv'] as const) {
    typedRoute(app, {
      method: 'GET',
      url: `${prefix}/reports/${reportPath}`,
      query: reportRange,
      async handler({ request, query }) {
        const session = await requireProSession(app, request.headers.authorization);
        return serviceFor(app).repository.getGuvReport(session.scope, { ...query, profile: reportPath });
      },
    });
  }

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/reports/hgb-bilanz`,
    query: asOfDate,
    async handler({ request, query }) {
      const session = await requireProSession(app, request.headers.authorization);
      return repositoryFor(app).getBilanzReport(session.scope, query);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/reports/bilanz`,
    query: asOfDate,
    async handler({ request, query }) {
      const session = await requireProSession(app, request.headers.authorization);
      return repositoryFor(app).getBilanzReport(session.scope, query);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/reports/snapshots`,
    query: reportSnapshotQuery,
    async handler({ request, query }) {
      const session = await requireProSession(app, request.headers.authorization);
      return repositoryFor(app).listReportSnapshots(session.scope, query.reportType);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/reports/snapshots/:id`,
    params: idParams,
    async handler({ request, params }) {
      const session = await requireProSession(app, request.headers.authorization);
      return repositoryFor(app).getReportSnapshot(session.scope, params.id);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/reports/snapshots`,
    body: reportSnapshotBody,
    async handler({ request, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      const args = body.reportType === 'eur'
        ? { from: body.from, to: body.to, asOfDate: body.asOfDate }
        : { from: body.from, to: body.to, asOfDate: body.asOfDate, chart: body.chart, profile: body.profile };
      const service = serviceFor(app);
      const repository = service.repository;
      const payload = body.reportType === 'eur'
        ? await repository.getEurReport(session.scope, { from: body.from, to: body.to, asOfDate: body.asOfDate })
        : body.reportType === 'susa'
          ? await service.getSusaReport(session.scope, { ...args, fromDate: body.from, asOfDate: body.to ?? body.asOfDate })
        : body.reportType === 'bilanz' || body.reportType === 'hgb-bilanz'
          ? await repository.getBilanzReport(session.scope, { asOfDate: body.asOfDate, chart: body.chart })
          : body.reportType === 'bwa01'
            ? await repository.getBwa01Report(session.scope, { from: body.from, to: body.to, chart: body.chart, profile: body.profile })
            : await repository.getGuvReport(session.scope, { from: body.from, to: body.to, chart: body.chart, profile: body.reportType === 'management-guv' || body.reportType === 'hgb-guv' ? body.reportType : 'management-guv' });
      if (body.reportType === 'eur' && ((payload as Awaited<ReturnType<typeof repository.getEurReport>>).warnings.length > 0 || (payload as Awaited<ReturnType<typeof repository.getEurReport>>).unclassifiedCount > 0)) {
        throw new ApiError(422, 'EÜR-Snapshot ist wegen Warnungen oder nicht klassifizierter Zahlungsquellen gesperrt.');
      }
      return repository.saveReportSnapshot(session.scope, {
        reportType: body.reportType,
        args,
        payload,
        mutation: mutationFor(session, body.reason),
      });
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/health`,
    async handler({ request }) {
      const session = await requireProSession(app, request.headers.authorization);
      return serviceFor(app).getAccountingHealth(session.scope);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/vat/summary`,
    query: reportRange,
    async handler({ request, query }) {
      const session = await requireProSession(app, request.headers.authorization);
      return serviceFor(app).getVatSummary(session.scope, query);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/datev/rows`,
    query: reportRange,
    async handler({ request, query }) {
      const session = await requireProSession(app, request.headers.authorization);
      return serviceFor(app).buildDatevRows(session.scope, query);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/datev/exports`,
    async handler({ request }) {
      const session = await requireProSession(app, request.headers.authorization);
      return serviceFor(app).listDatevExports(session.scope);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/datev/export.csv`,
    query: datevExportQuery,
    async handler({ request, reply, query }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      const service = serviceFor(app);
      const policy = await service.getAccountingPolicy(session.scope);
      const rows = await service.buildDatevRows(session.scope, { from: query.from, to: query.to });
      const content = buildDatevBuchungsstapelCsv(rows, {
        consultantNumber: query.consultantNumber,
        clientNumber: query.clientNumber,
        fiscalYearStart: query.fiscalYearStart,
        accountLength: query.accountLength,
        chart: policy.activeChart,
        from: query.from,
        to: query.to,
        encoding: query.encoding,
        createdAt: new Date(),
        stackName: `Buchungsstapel ${query.from.slice(0, 7)}`,
      });
      const contentSha256 = createHash('sha256').update(content).digest('hex');
      const filePath = `datev-export/${contentSha256}`;
      const existing = (await service.listDatevExports(session.scope)).find((entry) => entry.filePath === filePath);
      const receipt = existing ?? await service.insertDatevExport(session.scope, {
        filePath,
        recordCount: rows.length,
        fromDate: query.from,
        toDate: query.to,
        content,
        mutation: mutationFor(session, query.reason),
        contentSha256,
        encoding: query.encoding,
        headerVersion: 700,
        formatVersion: 13,
        chart: policy.activeChart,
        sourceSnapshot: {
          from: query.from,
          to: query.to,
          recordCount: rows.length,
          consultantNumber: query.consultantNumber,
          clientNumber: query.clientNumber,
          fiscalYearStart: query.fiscalYearStart,
          accountLength: query.accountLength,
          encoding: query.encoding,
          chart: policy.activeChart,
        },
      });
      reply.header('x-billme-datev-export-id', receipt.id);
      reply.header('x-billme-datev-content-sha256', contentSha256);
      reply.header('x-billme-datev-record-count', String(rows.length));
      reply.header('content-type', query.encoding === 'utf8-bom' ? 'text/csv; charset=utf-8' : 'text/csv; charset=windows-1252');
      reply.header('content-disposition', 'attachment; filename="datev-buchungsstapel.csv"');
      reply.send(Buffer.from(content));
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/datev/exports/:id`,
    params: idParams,
    async handler({ request, reply, params }) {
      const session = await requireProSession(app, request.headers.authorization);
      const exportSnapshot = await serviceFor(app).getDatevExportContent(session.scope, params.id);
      reply.header('x-billme-datev-export-id', exportSnapshot.id);
      reply.header('x-billme-datev-content-sha256', exportSnapshot.contentSha256);
      reply.header('x-billme-datev-record-count', String(exportSnapshot.recordCount));
      const encoding = exportSnapshot.encoding ?? 'cp1252';
      reply.header('content-type', encoding === 'utf8-bom' ? 'text/csv; charset=utf-8' : 'text/csv; charset=windows-1252');
      reply.header('content-disposition', 'attachment; filename="datev-buchungsstapel.csv"');
      reply.send(Buffer.from(exportSnapshot.content));
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/validate`,
    body: z.object({ reason: reasonSchema, draftId: z.string().min(1).optional(), transactionId: z.string().min(1).optional() }).refine((value) => value.draftId || value.transactionId, 'draftId or transactionId is required'),
    async handler({ request, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      return serviceFor(app).validateTaxCompliance(session.scope, {
        draftId: body.draftId,
        transactionId: body.transactionId,
        mutation: mutationFor(session, body.reason),
      });
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/drafts/:draftId/validate`,
    params: draftParams,
    body: z.object({ reason: reasonSchema, transactionId: z.string().min(1).optional() }),
    async handler({ request, params, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      return serviceFor(app).validateTaxCompliance(session.scope, {
        draftId: params.draftId,
        transactionId: body.transactionId,
        mutation: mutationFor(session, body.reason),
      });
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/policy`,
    response: accountingPolicySchema,
    async handler({ request }) {
      const session = await requireProSession(app, request.headers.authorization);
      return serviceFor(app).getAccountingPolicy(session.scope);
    },
  });

  typedRoute(app, {
    method: 'PUT',
    url: `${prefix}/policy`,
    body: policyBody,
    response: accountingPolicySchema,
    async handler({ request, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      const policy = await serviceFor(app).setAccountingPolicy(session.scope, {
        activeChart: body.activeChart,
        vatMethod: body.vatMethod,
        mutation: mutationFor(session, body.reason),
      });
      return policy;
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/mappings`,
    query: z.object({ chart: z.enum(['SKR03', 'SKR04']).optional() }),
    response: z.array(accountingAccountMappingSchema),
    async handler({ request, query }) {
      const session = await requireProSession(app, request.headers.authorization);
      return serviceFor(app).listAccountingAccountMappings(session.scope, query.chart);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/mappings/health`,
    query: mappingHealthQuery,
    async handler({ request, query }) {
      const session = await requireProSession(app, request.headers.authorization);
      return repositoryFor(app).getAccountMappingHealth(session.scope, query.chart, query.reportType);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/mappings/positions`,
    query: mappingPositionsQuery,
    response: z.array(z.object({ key: z.string(), label: z.string(), kind: z.enum(['heading', 'line', 'subtotal', 'result']), side: z.enum(['asset', 'liability']).optional() })),
    async handler({ request, query }) {
      const session = await requireProSession(app, request.headers.authorization);
      return repositoryFor(app).listReportMappingPositions(session.scope, query.reportType);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/mappings`,
    body: mappingBody,
    response: accountingAccountMappingSchema,
    async handler({ request, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      const input = {
        id: body.id,
        chart: body.chart,
        role: body.role,
        accountNumber: body.accountNumber,
        mutation: mutationFor(session, body.reason),
      };
      const mapping = await serviceFor(app).upsertAccountingAccountMapping(session.scope, input);
      return mapping;
    },
  });

  typedRoute(app, {
    method: 'PUT',
    url: `${prefix}/mappings/overrides`,
    body: mappingOverrideBody,
    async handler({ request, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      return repositoryFor(app).upsertAccountMappingOverride(session.scope, {
        chart: body.chart,
        accountNumber: body.accountNumber,
        statementType: body.statementType,
        positionKey: body.positionKey,
        positionLabel: body.positionLabel,
        balanceSide: body.balanceSide,
        mutation: mutationFor(session, body.reason),
      });
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/vendors`,
    response: z.array(vendorSchema),
    async handler({ request }) {
      const session = await requireProSession(app, request.headers.authorization);
      return serviceFor(app).listVendors(session.scope);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/vendors`,
    body: vendorBody,
    response: vendorSchema,
    async handler({ request, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      const vendor = await serviceFor(app).upsertVendor(session.scope, {
        ...body.vendor,
        mutation: mutationFor(session, body.reason),
      });
      return vendor;
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/incoming-invoices`,
    response: z.array(incomingInvoiceSchema),
    async handler({ request }) {
      const session = await requireProSession(app, request.headers.authorization);
      return serviceFor(app).listIncomingInvoices(session.scope);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/incoming-invoices`,
    body: incomingInvoiceBody,
    response: incomingInvoiceSchema,
    async handler({ request, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      const now = new Date().toISOString();
      const invoice: IncomingInvoiceEntity & { mutation?: AccountingMutationContext } = {
        ...body.invoice,
        tenantId: session.scope.tenantId,
        accountingStatus: 'unposted',
        createdAt: now,
        updatedAt: now,
        mutation: mutationFor(session, body.reason),
      };
      const saved = await serviceFor(app).upsertIncomingInvoice(session.scope, invoice);
      return saved;
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/outgoing-invoices/preview`,
    body: outgoingInvoiceBody,
    response: accountingPostingPreviewSchema,
    async handler({ request, body }) {
      const session = await requireProSession(app, request.headers.authorization);
      return serviceFor(app).previewOutgoingInvoice(session.scope, body.invoiceId);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/outgoing-invoices/post`,
    body: outgoingInvoicePostBody,
    response: accountingPostingPreviewSchema,
    async handler({ request, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      const posted = await serviceFor(app).postOutgoingInvoice(session.scope, body.invoiceId, {
        softLockOverride: body.softLockOverride,
        overrideReason: body.overrideReason,
        reservationId: body.reservationId,
        mutation: mutationFor(session, body.reason),
      });
      return posted;
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/incoming-invoices/preview`,
    body: incomingInvoiceActionBody,
    response: accountingPostingPreviewSchema,
    async handler({ request, body }) {
      const session = await requireProSession(app, request.headers.authorization);
      return serviceFor(app).previewIncomingInvoice(session.scope, body.invoiceId);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/incoming-invoices/post`,
    body: incomingInvoiceActionBody,
    response: accountingPostingPreviewSchema,
    async handler({ request, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      const posted = await serviceFor(app).postIncomingInvoice(session.scope, body.invoiceId, {
        softLockOverride: body.softLockOverride,
        overrideReason: body.overrideReason,
        mutation: mutationFor(session, body.reason),
      });
      return posted;
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/open-items`,
    response: z.array(openItemSchema),
    async handler({ request }) {
      const session = await requireProSession(app, request.headers.authorization);
      return serviceFor(app).listOpenItems(session.scope);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/open-items/payments`,
    body: paymentBody,
    async handler({ request, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      const payment = await serviceFor(app).allocateOpenItemPayment(session.scope, {
        ...body.payment,
        reason: body.reason,
        mutation: mutationFor(session, body.reason),
      });
      return payment;
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/open-items/payments/:paymentId/remaining`,
    params: z.object({ paymentId: z.string().min(1) }),
    body: remainingPaymentBody,
    async handler({ request, params, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      const payment = await serviceFor(app).allocateRemainingOpenItemPayment(
        session.scope,
        params.paymentId,
        body.allocations,
        body.allocationEventId,
        mutationFor(session, body.reason),
      );
      return payment;
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/documents/reverse`,
    body: reverseDocumentBody,
    async handler({ request, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      const reversed = await serviceFor(app).reverseDocumentAccounting(session.scope, {
        ...body,
        mutation: mutationFor(session, body.reason),
      });
      return reversed;
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/backfill/preview`,
    response: accountingBackfillPreviewSchema,
    async handler({ request }) {
      const session = await requireProSession(app, request.headers.authorization);
      return serviceFor(app).previewAccountingBackfill(session.scope);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/backfill/confirm`,
    body: backfillBody,
    response: accountingBackfillResultSchema,
    async handler({ request, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      const input: AccountingBackfillConfirmation = {
        ...body,
        mutation: mutationFor(session, body.reason),
      };
      const result = await serviceFor(app).confirmAccountingBackfill(session.scope, input);
      return result;
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/assets`,
    response: z.array(assetSchema),
    async handler({ request }) {
      const session = await requireProSession(app, request.headers.authorization);
      return serviceFor(app).listAssets(session.scope);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/assets`,
    body: assetBody,
    response: assetSchema,
    async handler({ request, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      return serviceFor(app).upsertAsset(session.scope, body.asset, body.reason, { mutation: mutationFor(session, body.reason), softLockOverride: body.asset.softLockOverride, overrideReason: body.asset.overrideReason });
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/assets/:id/schedule`,
    params: idParams,
    response: z.array(assetDepreciationScheduleEntrySchema),
    async handler({ request, params }) {
      const session = await requireProSession(app, request.headers.authorization);
      return serviceFor(app).getDepreciationSchedule(session.scope, params.id);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/assets/:id/depreciation`,
    params: idParams,
    body: depreciationBody,
    async handler({ request, params, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      return serviceFor(app).runDepreciation(session.scope, { assetId: params.id, ...body, mutation: mutationFor(session, body.reason) });
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/assets/:id/dispose`,
    params: idParams,
    body: disposalBody,
    async handler({ request, params, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      return serviceFor(app).disposeAsset(session.scope, { assetId: params.id, ...body, mutation: mutationFor(session, body.reason) });
    },
  });
};
