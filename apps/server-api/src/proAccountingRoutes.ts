import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { createProAccountingService } from '@billme/accounting-engine';
import type {
  ProDraftActionRequest,
  TenantScope,
} from '@billme/server-core';
import type {
  AccountingBackfillConfirmation,
  AccountingAccountMapping,
  IncomingInvoiceEntity,
  OpenItemPaymentInput,
} from '@billme/accounting-shared';
import { createPostgresProAccountingRepository } from '@billme/server-data';
import {
  accountingAccountMappingSchema,
  accountingBackfillPreviewSchema,
  accountingBackfillResultSchema,
  accountingPolicySchema,
  accountingPostingPreviewSchema,
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

const serviceFor = (app: FastifyInstance) => {
  const pool = requirePool(app);
  return createProAccountingService(createPostgresProAccountingRepository(pool));
};

const reasonSchema = z.string().trim().min(1, 'reason is required');
const idParams = z.object({ id: z.string().min(1) });
const transactionParams = z.object({ transactionId: z.string().min(1) });
const draftParams = z.object({ draftId: z.string().min(1) });
const reportRange = z.object({ from: z.string().optional(), to: z.string().optional() });
const datevExportQuery = reportRange.extend({
  reason: reasonSchema.default('DATEV-Buchungsstapel exportiert'),
});
const asOfDate = z.object({ asOfDate: z.string().optional() });
const csvEscape = (value: unknown): string => {
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
const incomingInvoiceBody = z.object({
  reason: reasonSchema,
  invoice: incomingInvoiceSchema.omit({ tenantId: true, createdAt: true, updatedAt: true }),
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
  }),
});
const remainingPaymentBody = z.object({
  reason: reasonSchema,
  paymentId: z.string().min(1),
  allocations: z.array(z.object({ openItemId: z.string().min(1), amount: z.number().positive() })),
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

const requireProSession = async (app: FastifyInstance, authHeader: string | undefined) =>
  requireSession(app, 'pro', authHeader);

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
      const saved = await serviceFor(app).saveDraft(session.scope, tenantDraft(session.scope, body.draft), { reason: body.reason });
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
        reason: body.reason,
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
      const posted = await serviceFor(app).postDraft(session.scope, params.draftId, body);
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
      const reversed = await serviceFor(app).reverseJournalEntry(session.scope, params.id, body.reason, body);
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
    query: asOfDate,
    async handler({ request, query }) {
      const session = await requireProSession(app, request.headers.authorization);
      return serviceFor(app).getSusaReport(session.scope, query);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/reports/guv`,
    query: reportRange,
    async handler({ request, query }) {
      const session = await requireProSession(app, request.headers.authorization);
      return serviceFor(app).getGuvReport(session.scope, query);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/reports/bilanz`,
    query: asOfDate,
    async handler({ request, query }) {
      const session = await requireProSession(app, request.headers.authorization);
      return serviceFor(app).getBilanzReport(session.scope, query);
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
      const rows = await service.buildDatevRows(session.scope, query);
      const columns = ['date', 'belegfeld1', 'buchungstext', 'konto', 'gegenkonto', 'sollHabenKennzeichen', 'buSchluessel', 'umsatz'];
      const csv = [columns.join(';'), ...rows.map((row) => columns.map((column) => csvEscape(row[column as keyof typeof row])).join(';'))].join('\n') + '\n';
      const contentSha256 = createHash('sha256').update(csv, 'utf8').digest('hex');
      const filePath = `server://datev/${contentSha256}.csv`;
      const existing = (await service.listDatevExports(session.scope)).find((entry) => entry.filePath === filePath);
      const receipt = existing ?? await service.insertDatevExport(session.scope, {
        filePath,
        recordCount: rows.length,
        fromDate: query.from,
        toDate: query.to,
        reason: query.reason,
        contentSha256,
        sourceSnapshot: { from: query.from, to: query.to, recordCount: rows.length },
      });
      reply.header('x-billme-datev-export-id', receipt.id);
      reply.header('x-billme-datev-content-sha256', contentSha256);
      reply.header('x-billme-datev-record-count', String(rows.length));
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', 'attachment; filename="datev-buchungsstapel.csv"');
      return csv;
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/validate`,
    body: z.object({ reason: reasonSchema, draftId: z.string().min(1).optional(), transactionId: z.string().min(1).optional() }).refine((value) => value.draftId || value.transactionId, 'draftId or transactionId is required'),
    async handler({ request, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      return serviceFor(app).validateTaxCompliance(session.scope, body, { reason: body.reason });
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
      }, { reason: body.reason });
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
      const policy = await serviceFor(app).setAccountingPolicy(session.scope, body);
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
        reason: body.reason,
      };
      const mapping = await serviceFor(app).upsertAccountingAccountMapping(session.scope, input);
      return mapping;
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
        reason: body.reason,
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
      const invoice: IncomingInvoiceEntity = {
        ...body.invoice,
        tenantId: session.scope.tenantId,
        createdAt: now,
        updatedAt: now,
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
        ...body,
        requireFinalizedReservation: true,
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
      const posted = await serviceFor(app).postIncomingInvoice(session.scope, body.invoiceId, body);
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
      const payment = await serviceFor(app).allocateOpenItemPayment(session.scope, { ...body.payment, reason: body.reason } as OpenItemPaymentInput & { reason: string });
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
      const payment = await serviceFor(app).allocateRemainingOpenItemPayment(session.scope, params.paymentId, body.allocations, { reason: body.reason });
      return payment;
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/documents/reverse`,
    body: reverseDocumentBody,
    async handler({ request, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      const reversed = await serviceFor(app).reverseDocumentAccounting(session.scope, body);
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
      const input: AccountingBackfillConfirmation = body;
      const result = await serviceFor(app).confirmAccountingBackfill(session.scope, input);
      return result;
    },
  });
};
