import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  createCancellationInvoiceAsync,
  createCreditNoteAsync,
  createDeliveryNoteFromOrderAsync,
  createInvoiceRevisionAsync,
  createOrderConfirmationFromOfferAsync,
  createSettlementInvoiceAsync,
  finalizeDocumentNumber,
  invoiceSchema,
  reserveDocumentNumber,
  type TenantScope,
} from '@billme/server-core';
import {
  createPostgresBillingDependencies,
  createPostgresProAccountingRepository,
  sha256Hex,
  stableStringify,
  type ServerDatabase,
  type ServerDatabaseSession,
} from '@billme/server-data';
import { buildAuditEntry, historyFromAudit } from './auditHistory.js';
import type { AuthSession } from './auth.js';
import { ApiError } from './http.js';
import { createNumberingPortsForDb } from './numbering.js';
import { createMutationContext, type MutationContext } from './runtimeContext.js';

const chainIssueCommonSchema = z.object({
  id: z.string().trim().min(1),
  date: z.string().trim().min(1),
  dueDate: z.string().trim().min(1).optional(),
  servicePeriod: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(1),
});

/** The discriminated chain-operation input minus the client-chosen number. */
export const chainIssueBodySchema = z.discriminatedUnion('operation', [
  chainIssueCommonSchema.extend({ operation: z.literal('order_confirmation'), offerId: z.string().trim().min(1) }),
  chainIssueCommonSchema.extend({ operation: z.literal('delivery_note'), orderId: z.string().trim().min(1), items: invoiceSchema.shape.items.optional() }),
  chainIssueCommonSchema.extend({ operation: z.literal('settlement_invoice'), orderId: z.string().trim().min(1), kind: z.enum(['advance_invoice', 'partial_invoice', 'final_invoice']), amount: z.number().finite().positive(), items: invoiceSchema.shape.items.optional() }),
  chainIssueCommonSchema.extend({ operation: z.literal('correction'), invoiceId: z.string().trim().min(1), kind: z.enum(['credit_note', 'cancellation_invoice']), amount: z.number().finite().positive().optional(), items: invoiceSchema.shape.items.optional() }),
  chainIssueCommonSchema.extend({ operation: z.literal('revision'), invoiceId: z.string().trim().min(1) }),
]);

export type ChainIssueInput = z.infer<typeof chainIssueBodySchema>;

export const ISSUANCE_INTENT_VERSION = 1;

/**
 * Serialize against concurrent issuers and chain calculations for one source
 * root: offers lock directly, invoices lock the root plus every child in a
 * deterministic id order. A missing source row gets no lock; the chain helper
 * reports its own not-found error.
 */
export const lockChainSource = async (
  session: ServerDatabaseSession,
  scope: TenantScope,
  source: { offerId?: string; orderId?: string; invoiceId?: string },
): Promise<void> => {
  if (source.offerId) {
    await session.query('SELECT id FROM offers WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [scope.tenantId, source.offerId]);
    return;
  }
  const sourceId = source.orderId ?? source.invoiceId;
  if (!sourceId) return;
  const root = await session.query<{ root: string }>(
    'SELECT COALESCE(root_document_id, id) AS root FROM invoices WHERE tenant_id = $1 AND id = $2',
    [scope.tenantId, sourceId],
  );
  const rootId = root.rows[0]?.root;
  if (!rootId) return;
  await session.query(
    'SELECT id FROM invoices WHERE tenant_id = $1 AND (id = $2 OR root_document_id = $2) ORDER BY id FOR UPDATE',
    [scope.tenantId, rootId],
  );
};

/**
 * The opening posting step of POST /invoices: post a finalized, open billing
 * document inside the surrounding transaction and fail the transaction when
 * the posting is not ready.
 */
export const postOpenedBillingDocument = async (
  transaction: ServerDatabaseSession,
  scope: TenantScope,
  invoice: { id: string },
  reservationId: string,
  mutation: MutationContext,
): Promise<void> => {
  const posted = await createPostgresProAccountingRepository(transaction).postOutgoingInvoice(
    scope,
    invoice.id,
    { reservationId, mutation },
  );
  if (posted.status !== 'ready' || !posted.snapshot) {
    throw new Error(posted.reason ?? posted.issues[0]?.code ?? 'ACCOUNTING_POSTING_UNRESOLVED');
  }
};

/**
 * Reserve, create, finalize, open, post, audit, and record one chain document
 * in a single transaction. The stable operation id keys an idempotency
 * receipt: a replay returns the recorded response byte-for-byte, a changed
 * intent for the same id is a 409, and any failure rolls back every effect.
 */
export const issueDocumentChain = async (
  database: ServerDatabase,
  auth: AuthSession,
  input: ChainIssueInput,
) => {
  const scope = auth.scope;
  const mutation = createMutationContext(auth, input.reason);
  return database.transaction({}, async (session) => {
    const numbering = createNumberingPortsForDb(session, scope);
    // Locks server_settings FOR UPDATE first: this serializes issuance per tenant.
    await numbering.getSettings();

    const { id: operationId, ...intent } = input;
    const intentHash = sha256Hex(stableStringify(intent));
    const receipt = await session.query<{ intent_version: number; intent_hash: string; response_json: string }>(
      'SELECT intent_version, intent_hash, response_json FROM document_issuance_receipts WHERE tenant_id = $1 AND product = $2 AND operation_id = $3',
      [scope.tenantId, scope.product, operationId],
    );
    const recorded = receipt.rows[0];
    if (recorded) {
      if (recorded.intent_version !== ISSUANCE_INTENT_VERSION || recorded.intent_hash !== intentHash) {
        throw new ApiError(409, 'Issuance intent differs from the recorded operation');
      }
      return JSON.parse(recorded.response_json);
    }

    await lockChainSource(session, scope, {
      offerId: input.operation === 'order_confirmation' ? input.offerId : undefined,
      orderId: input.operation === 'delivery_note' || input.operation === 'settlement_invoice' ? input.orderId : undefined,
      invoiceId: input.operation === 'correction' || input.operation === 'revision' ? input.invoiceId : undefined,
    });

    const repositories = createPostgresBillingDependencies(session);
    const foreignId = await session.query('SELECT tenant_id FROM invoices WHERE id = $1 AND tenant_id <> $2', [operationId, scope.tenantId]);
    if (foreignId.rows.length) throw new ApiError(409, 'Document id already belongs to another document');
    const existing = await repositories.invoiceRepo.getById(scope, operationId);
    if (existing) throw new ApiError(409, 'Document id already belongs to another document');

    const now = new Date();
    const reservation = await reserveDocumentNumber(numbering, 'invoice', now);
    let created;
    switch (input.operation) {
      case 'order_confirmation':
        created = await createOrderConfirmationFromOfferAsync(scope, repositories, { ...input, number: reservation.number, actor: mutation.actor });
        break;
      case 'delivery_note':
        created = await createDeliveryNoteFromOrderAsync(scope, repositories, { ...input, number: reservation.number, actor: mutation.actor });
        break;
      case 'settlement_invoice':
        created = await createSettlementInvoiceAsync(scope, repositories, { ...input, number: reservation.number, actor: mutation.actor });
        break;
      case 'correction':
        created = input.kind === 'credit_note'
          ? await createCreditNoteAsync(scope, repositories, { ...input, number: reservation.number, actor: mutation.actor })
          : await createCancellationInvoiceAsync(scope, repositories, { ...input, number: reservation.number, actor: mutation.actor });
        break;
      case 'revision':
        created = await createInvoiceRevisionAsync(scope, repositories, { ...input, number: reservation.number, actor: mutation.actor });
        break;
    }

    await finalizeDocumentNumber(numbering, reservation.reservationId, created.id);
    const open = await repositories.invoiceRepo.save(scope, { ...created, status: 'open' });
    await repositories.auditLog.append(
      scope,
      buildAuditEntry(scope, auth, 'invoice', open.id, 'invoice.update', `${input.reason} (finalisiert)`, created, open),
    );

    const billingKind = !['order_confirmation', 'delivery_note'].includes(open.documentKind ?? 'invoice');
    if (scope.product === 'pro' && billingKind) {
      await postOpenedBillingDocument(session, scope, open, reservation.reservationId, mutation);
    }

    const final = (await repositories.invoiceRepo.getById(scope, open.id)) ?? open;
    const response = {
      ...final,
      history: await historyFromAudit(session, scope, 'invoice', final.id),
      numberReservationId: reservation.reservationId,
    };
    await session.query(
      'INSERT INTO document_issuance_receipts (id,tenant_id,product,operation_id,intent_version,intent_hash,document_id,reservation_id,response_json,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [randomUUID(), scope.tenantId, scope.product, operationId, ISSUANCE_INTENT_VERSION, intentHash, created.id, reservation.reservationId, JSON.stringify(response), new Date().toISOString()],
    );
    return response;
  });
};
