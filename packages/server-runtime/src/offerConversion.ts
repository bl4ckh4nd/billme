import {
  buildInvoiceFromOffer, finalizeDocumentNumber, reserveDocumentNumber,
  type AuditActor, type TenantScope,
} from '@billme/server-core';
import { createPostgresBillingDependencies, type ServerDatabase } from '@billme/server-data';
import { ApiError } from './http.js';
import { createNumberingPortsForDb } from './numbering.js';

/** A converted offer has one invoice, including retries with a new request id. */
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
  }
  await session.query('SELECT id FROM offers WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [scope.tenantId, input.offerId]);
  const offer = await offerRepo.getById(scope, input.offerId);
  if (!offer) throw new ApiError(404, 'Offer not found');
  if (offer.status !== 'accepted' && offer.share?.decision !== 'accepted') throw new ApiError(409, 'Nur angenommene Angebote können in Rechnungen umgewandelt werden.');
  const converted = await session.query<{ id: string }>(
    "SELECT id FROM invoices WHERE tenant_id=$1 AND source_document_id=$2 AND COALESCE(document_kind,'invoice')='invoice' AND revision_of_id IS NULL ORDER BY id LIMIT 2",
    [scope.tenantId, input.offerId],
  );
  if (converted.rows.length > 1) throw new ApiError(409, 'Das Angebot hat mehrere alte Rechnungszuordnungen. Bitte zuerst prüfen.');
  const relation = (await session.query<{ invoice_id: string }>('SELECT invoice_id FROM offer_invoice_conversions WHERE tenant_id=$1 AND product=$2 AND offer_id=$3', [scope.tenantId, scope.product, input.offerId])).rows[0];
  const targetId = relation?.invoice_id ?? converted.rows[0]?.id;
  if (targetId) {
    if (!relation) await session.query('INSERT INTO offer_invoice_conversions (tenant_id,product,offer_id,invoice_id) VALUES ($1,$2,$3,$4)', [scope.tenantId, scope.product, input.offerId, targetId]);
    return (await invoiceRepo.getById(scope, targetId))!;
  }

  const now = new Date();
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
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
  await session.query('INSERT INTO offer_invoice_conversions (tenant_id,product,offer_id,invoice_id) VALUES ($1,$2,$3,$4)', [scope.tenantId, scope.product, input.offerId, saved.id]);
  await auditLog.append(scope, {
    occurredAt: now.toISOString(), action: 'invoice.create',
    reason: `Converted from offer ${offer.number}`, actor,
    subject: { entityType: 'invoice', entityId: saved.id, tenantId: scope.tenantId },
    change: { before: null, after: saved },
  });
  return saved;
});
