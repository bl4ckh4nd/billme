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
  offerSchema,
  reserveDocumentNumber,
  prepareInvoiceForIssue,
  InvoiceIssueError,
  type IssuerSettings,
  type SmallBusinessTurnover,
  type TenantScope,
  type Invoice,
  type Offer,
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

const documentContentSchema = invoiceSchema.omit({ status: true, payments: true, history: true, dunningLevel: true, createdAt: true, updatedAt: true });
const documentContent = (invoice: Invoice) => {
  const content = documentContentSchema.parse(invoice);
  const { snapshot: _snapshot, ...layout } = content.layout ?? {};
  return { ...content, layout: Object.keys(layout).length ? layout : undefined };
};
export const assertInvoiceContentEditable = (before: Invoice | null, next: Invoice): void => {
  if (!before || before.status === 'draft') return;
  if (next.status === 'draft' || stableStringify(documentContent(before)) !== stableStringify(documentContent(next))) {
    throw new ApiError(409, 'Gestellte Rechnungen bleiben unverändert. Bitte eine Revision oder Gutschrift/Stornorechnung erstellen.');
  }
};

const offerContentSchema = offerSchema.omit({ status: true, share: true, history: true, createdAt: true, updatedAt: true });
const offerContent = (offer: Offer) => {
  const content = offerContentSchema.parse(offer);
  const { snapshot: _snapshot, ...layout } = content.layout ?? {};
  return { ...content, layout: Object.keys(layout).length ? layout : undefined };
};
export const assertOfferContentEditable = (before: Offer | null, next: Offer): void => {
  if (!before || (before.status === 'draft' && !before.share?.publishedAt && !before.share?.decision)) return;
  if ((next.status === 'draft' && before.status !== 'draft') || stableStringify(offerContent(before)) !== stableStringify(offerContent(next))) {
    throw new ApiError(409, 'Gesendete oder angenommene Angebote bleiben unverändert. Bitte ein neues Angebot erstellen.');
  }
};

export const cancelUnpaidRevisionSource = async (transaction: ServerDatabaseSession, auth: AuthSession, revision: Invoice, reason: string): Promise<void> => {
  if (!revision.revisionOfId) return;
  await lockChainSource(transaction, auth.scope, { invoiceId: revision.revisionOfId });
  const repositories = createPostgresBillingDependencies(transaction);
  const source = await repositories.invoiceRepo.getById(auth.scope, revision.revisionOfId);
  if (!source || ['draft', 'cancelled'].includes(source.status) || source.payments.length) {
    throw new ApiError(409, 'Die ursprüngliche Rechnung muss gestellt, unbezahlt und noch gültig sein. Bei Zahlungen bitte Gutschrift/Storno und Rückzahlung verwenden.');
  }
  const corrections = await transaction.query('SELECT id FROM invoices WHERE tenant_id=$1 AND source_document_id=$2 AND document_kind IN (\'credit_note\',\'cancellation_invoice\') AND status<>\'draft\'', [auth.scope.tenantId, source.id]);
  if (corrections.rows.length) throw new ApiError(409, 'Die ursprüngliche Rechnung wurde bereits korrigiert. Bitte die bestehende Belegkette prüfen.');
  const mutation = createMutationContext(auth, reason);
  const numbering = createNumberingPortsForDb(transaction, auth.scope);
  const reserved = await reserveDocumentNumber(numbering, 'invoice', new Date());
  const created = await createCancellationInvoiceAsync(auth.scope, repositories, {
    id: `${revision.id}:replacement-cancellation`, invoiceId: source.id, number: reserved.number,
    date: revision.date, dueDate: revision.date, servicePeriod: source.servicePeriod, items: source.items,
    reason: `${reason} (Storno vor Ersatz ${revision.number})`, actor: mutation.actor,
  });
  await finalizeDocumentNumber(numbering, reserved.reservationId, created.id);
  const cancellation = await repositories.invoiceRepo.save(auth.scope, { ...created, taxSnapshot: source.taxSnapshot, status: 'open' });
  if (auth.scope.product === 'pro') await postOpenedBillingDocument(transaction, auth.scope, cancellation, reserved.reservationId, mutation);
  const cancelled = await repositories.invoiceRepo.save(auth.scope, { ...source, status: 'cancelled', updatedAt: new Date().toISOString() });
  await repositories.auditLog.append(auth.scope, buildAuditEntry(auth.scope, auth, 'invoice', source.id, 'invoice.cancelled_for_revision', reason, source, cancelled));
};

export { settledInvoiceStatus } from '@billme/server-data';
import { smallBusinessTurnover } from '@billme/server-data';

/**
 * An issued Stornorechnung cancels its source, and credit notes that cover what
 * is still owed settle it; otherwise dunning and bank matching keep chasing a
 * debt that no longer exists. Runs after the correction is open (and, in Pro,
 * posted), in the issuing transaction.
 */
export const settleCorrectedSource = async (transaction: ServerDatabaseSession, auth: AuthSession, correction: Invoice, reason: string): Promise<void> => {
  const kind = correction.documentKind ?? 'invoice';
  if (!correction.sourceDocumentId || (kind !== 'cancellation_invoice' && kind !== 'credit_note')) return;
  const repositories = createPostgresBillingDependencies(transaction);
  const source = await repositories.invoiceRepo.getById(auth.scope, correction.sourceDocumentId);
  // A Storno cancels the invoice even when it was paid; the payment stays recorded and is owed back as a refund.
  const settleable = kind === 'cancellation_invoice' ? ['open', 'overdue', 'paid'] : ['open', 'overdue'];
  if (!source || !settleable.includes(source.status)) return;
  let status: 'cancelled' | 'paid' | undefined = kind === 'cancellation_invoice' ? 'cancelled' : undefined;
  if (kind === 'credit_note') {
    const credits = await transaction.query<{ amount: string | number }>("SELECT amount FROM invoices WHERE tenant_id=$1 AND source_document_id=$2 AND document_kind='credit_note' AND status<>'draft'", [auth.scope.tenantId, source.id]);
    const cents = (value: number | string) => Math.round(Math.abs(Number(value)) * 100);
    const settledCents = credits.rows.reduce((sum, row) => sum + cents(row.amount), 0) + source.payments.reduce((sum, payment) => sum + cents(payment.amount), 0);
    if (settledCents >= cents(source.amount)) status = 'paid';
  }
  if (!status) return;
  const settled = await repositories.invoiceRepo.save(auth.scope, { ...source, status, updatedAt: new Date().toISOString() });
  await repositories.auditLog.append(auth.scope, buildAuditEntry(auth.scope, auth, 'invoice', source.id, status === 'cancelled' ? 'invoice.cancelled_by_correction' : 'invoice.settled_by_credit_note', reason, source, settled));
};

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
/** §14 check at issue time, reported as 422 with everything that is missing. */
export const issuable = <T extends Invoice>(invoice: T, settings: IssuerSettings, turnover?: SmallBusinessTurnover): T => {
  try {
    return prepareInvoiceForIssue(invoice, settings, turnover);
  } catch (error) {
    if (error instanceof InvoiceIssueError) throw new ApiError(422, error.message);
    throw error;
  }
};

/** Same check with the Kleinunternehmer turnover read from the books (payments received, refunds net). */
export const issuableIn = async <T extends Invoice>(session: ServerDatabaseSession, scope: TenantScope, invoice: T, settings: IssuerSettings): Promise<T> =>
  issuable(invoice, settings, settings.legal.smallBusinessRule ? await smallBusinessTurnover(session, scope, Number(invoice.date.slice(0, 4))) : undefined);

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
    const settings = await numbering.getSettings();

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
      const response = JSON.parse(recorded.response_json);
      if (input.operation === 'revision') {
        const current = await createPostgresBillingDependencies(session).invoiceRepo.getById(scope, response.id);
        if (current) return { ...current, history: await historyFromAudit(session, scope, 'invoice', current.id), numberReservationId: response.numberReservationId };
      }
      return response;
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
    // §14 UStG: only invoices consume the invoice range; order confirmations and delivery notes have their own.
    const numberKind = input.operation === 'order_confirmation' || input.operation === 'delivery_note' ? input.operation : 'invoice';
    const reservation = await reserveDocumentNumber(numbering, numberKind, now);
    // Billing documents are due after the payment term, like any invoice; a calendar date, not a timestamp.
    const dueAfterTerms = (date: string): string => {
      const due = new Date(`${date.slice(0, 10)}T00:00:00Z`);
      due.setUTCDate(due.getUTCDate() + (settings?.legal.paymentTermsDays ?? 14));
      return due.toISOString().slice(0, 10);
    };
    if ((input.operation === 'settlement_invoice' || input.operation === 'revision') && !input.dueDate) {
      input = { ...input, dueDate: dueAfterTerms(input.date) };
    }
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

    if (input.operation === 'revision') {
      await session.query("UPDATE number_reservations SET document_id=$3 WHERE tenant_id=$1 AND id=$2 AND status='reserved'", [scope.tenantId, reservation.reservationId, created.id]);
    } else await finalizeDocumentNumber(numbering, reservation.reservationId, created.id);
    // A final or partial invoice is the first invoice of an order; corrections copy an issued invoice and stay possible.
    if (input.operation === 'settlement_invoice') {
      if (!settings) throw new ApiError(409, 'Die Einstellungen müssen zuerst eingerichtet werden.');
      created = await issuableIn(session, scope, created, settings);
    }
    const open = input.operation === 'revision' ? created : await repositories.invoiceRepo.save(scope, { ...created, status: 'open' });
    await repositories.auditLog.append(
      scope,
      buildAuditEntry(scope, auth, 'invoice', open.id, 'invoice.update', `${input.reason} (finalisiert)`, created, open),
    );

    const billingKind = !['order_confirmation', 'delivery_note'].includes(open.documentKind ?? 'invoice');
    if (scope.product === 'pro' && billingKind && input.operation !== 'revision') {
      await postOpenedBillingDocument(session, scope, open, reservation.reservationId, mutation);
    }

    if (input.operation === 'correction') await settleCorrectedSource(session, auth, open, input.reason);

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
