import {
  buildInvoiceFromOffer, finalizeDocumentNumber, reserveDocumentNumber,
  type AuditActor, type TenantScope,
} from '@billme/server-core';
import { createPostgresBillingDependencies, type ServerDatabase } from '@billme/server-data';
import { ApiError } from './http.js';
import { createNumberingPortsForDb } from './numbering.js';

/** One invoice id identifies one conversion; another id permits another invoice. */
export const convertServerOfferToInvoice = (
  database: ServerDatabase,
  scope: TenantScope,
  input: { offerId: string; invoiceId: string },
  actor: AuditActor,
) => database.transaction({}, async (session) => {
  const numbering = createNumberingPortsForDb(session, scope);
  // Serializes number allocation and repeat requests within this tenant.
  const settings = await numbering.getSettings();
  if (!settings) throw new ApiError(409, 'Server settings are not initialized');
  const { offerRepo, invoiceRepo, auditLog } = createPostgresBillingDependencies(session);
  const foreignId = await session.query('SELECT id FROM invoices WHERE id = $1 AND tenant_id <> $2', [input.invoiceId, scope.tenantId]);
  if (foreignId.rows.length) throw new ApiError(409, 'Conversion id already belongs to another document');
  const existing = await invoiceRepo.getById(scope, input.invoiceId);
  if (existing) {
    if (existing.sourceDocumentId !== input.offerId || existing.documentKind !== 'invoice') {
      throw new ApiError(409, 'Conversion id already belongs to another document');
    }
    return existing;
  }
  await session.query('SELECT id FROM offers WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [scope.tenantId, input.offerId]);
  const offer = await offerRepo.getById(scope, input.offerId);
  if (!offer) throw new ApiError(404, 'Offer not found');
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const due = new Date(`${date}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + settings.legal.paymentTermsDays);
  const reservation = await reserveDocumentNumber(numbering, 'invoice', now);
  const saved = await invoiceRepo.save(scope, buildInvoiceFromOffer(scope, offer, {
    ...input,
    invoiceNumber: reservation.number,
    invoiceDate: date,
    dueDate: due.toISOString().slice(0, 10),
    servicePeriod: offer.validUntil,
  }));
  await finalizeDocumentNumber(numbering, reservation.reservationId, saved.id);
  await auditLog.append(scope, {
    occurredAt: now.toISOString(), action: 'invoice.create',
    reason: `Converted from offer ${offer.number}`, actor,
    subject: { entityType: 'invoice', entityId: saved.id, tenantId: scope.tenantId },
    change: { before: null, after: saved },
  });
  return saved;
});
