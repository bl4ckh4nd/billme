import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invoiceSchema, paymentSchema, type Payment } from '@billme/server-core';
import { assertLitePeriodsOpen, bookInvoicePaymentInTransaction, findActiveOpenItemPayment, reverseOpenItemPaymentInTransaction, createPostgresBillingDependencies, creditedAmount, isSkontoPayment, periodClosedMessage, withSkontoSettlement } from '@billme/server-data';
import { buildAuditEntry, withInvoiceHistory } from './auditHistory.js';
import { settledInvoiceStatus } from './documentIssuance.js';
import { isReceivableDocumentKind } from '@billme/server-core';
import { ApiError, typedRoute } from './http.js';
import { createMutationContext, requireDatabase, requireMutationSessionFor } from './runtimeContext.js';

const paymentCommandSchema = paymentSchema.refine(
  (payment) => payment.amount !== 0 && Number.isSafeInteger(Math.round(payment.amount * 100))
    && Math.abs(payment.amount * 100 - Math.round(payment.amount * 100)) < 0.000001
    && /^\d{4}-\d{2}-\d{2}$/.test(payment.date)
    && Number.isFinite(Date.parse(`${payment.date}T00:00:00Z`))
    && new Date(`${payment.date}T00:00:00Z`).toISOString().slice(0, 10) === payment.date,
  'Zahlung benötigt ein gültiges Datum und einen Betrag mit höchstens zwei Nachkommastellen ungleich null.',
);
const samePayment = (a: Payment, b: Payment) =>
  a.id === b.id && a.date === b.date && a.amount === b.amount && a.method === b.method;

export const registerInvoicePaymentRoutes = (app: FastifyInstance, product: 'lite' | 'pro', prefix: string) => {
  for (const operation of ['save', 'reverse'] as const) {
    typedRoute(app, {
      method: 'POST',
      url: operation === 'save' ? `${prefix}/invoices/:invoiceId/payments` : `${prefix}/invoices/:invoiceId/payments/:paymentId/reverse`,
      params: z.object({ invoiceId: z.string().min(1), paymentId: z.string().min(1).optional() }),
      body: z.object({ reason: z.string().trim().min(1), payment: paymentCommandSchema.optional(), expectedPayment: paymentSchema.optional() }),
      response: invoiceSchema,
      async handler({ request, params, body }) {
        const session = await requireMutationSessionFor(app, product, request.headers.authorization);
        const database = requireDatabase(app);
        const saved = await database.transaction({}, async (transaction) => {
          await transaction.query('SELECT id FROM invoices WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [session.scope.tenantId, params.invoiceId]);
          const repositories = createPostgresBillingDependencies(transaction);
          const before = await repositories.invoiceRepo.getById(session.scope, params.invoiceId);
          if (!before) throw new ApiError(404, 'Rechnung nicht gefunden.');
          // Only billing documents are paid; an order confirmation, delivery note or correction is not a receivable.
          if (operation === 'save' && !isReceivableDocumentKind(before.documentKind)) {
            throw new ApiError(409, 'Zahlungen gehören zu Rechnungen; Auftragsbestätigungen, Lieferscheine, Gutschriften und Stornos nehmen keine Zahlung an.');
          }
          if (operation === 'save' && (before.status === 'draft' || (before.status === 'cancelled' && (body.payment?.amount ?? 0) > 0))) throw new ApiError(409, 'Zahlungen benötigen eine gestellte, gültige Rechnung. Rückzahlungen bleiben separat möglich.');
          const paymentId = operation === 'save' ? body.payment?.id : params.paymentId;
          if (!paymentId || (operation === 'reverse' && !body.expectedPayment)) throw new ApiError(400, 'Zahlung und Vergleichsstand fehlen.');
          if (paymentId.startsWith('transaction-payment:') || paymentId.startsWith('tx:')) {
            throw new ApiError(409, 'Bankzahlungen bitte im Bankabgleich ändern.');
          }
          if (paymentId.startsWith('open-item-payment:')) throw new ApiError(409, 'Diese Zahlung wurde in den offenen Posten gebucht und wird dort storniert.');
          if (isSkontoPayment({ id: paymentId })) throw new ApiError(409, 'Skonto ergibt sich aus den Zahlungen und wird nicht von Hand erfasst.');
          const current = before.payments.find((payment) => payment.id === paymentId);
          // Pro books every payment: a repeat is only a no-op once the payment is in the books.
          if (operation === 'save' && current && body.payment && samePayment(current, body.payment)
            && (product !== 'pro' || await findActiveOpenItemPayment(transaction, session.scope, 'invoice_payment', current.id))) return before;
          if (operation === 'reverse' && !current) return before;
          if (current && (!body.expectedPayment || !samePayment(current, body.expectedPayment))) {
            throw new ApiError(409, 'Zahlung wurde inzwischen geändert. Bitte Rechnung neu laden.');
          }
          if (!current && body.expectedPayment) throw new ApiError(409, 'Zahlung wurde inzwischen entfernt. Bitte Rechnung neu laden.');
          // A festgeschriebener month takes no new, changed or removed payments.
          await assertLitePeriodsOpen(transaction, session.scope, [current?.date, operation === 'save' ? body.payment?.date : undefined])
            .catch((error: Error & { period?: string }) => { throw error.message === 'LITE_PERIOD_CLOSED' ? new ApiError(409, periodClosedMessage(error.period ?? '')) : error; });
          const payments = before.payments.filter((payment) => payment.id !== paymentId);
          if (operation === 'save') payments.push(body.payment!);
          // A payment may settle at most what is open (amount less credit notes and other payments). More is a
          // credit the customer is owed: record what is open and refund or offset the rest separately.
          const cents = (value: number) => Math.round(Number(value) * 100);
          // A refund (negative payment) gives back at most what the customer paid on this invoice.
          if (operation === 'save' && body.payment!.amount < 0) {
            const paidCents = payments.filter((payment) => payment.id !== paymentId && !isSkontoPayment(payment)).reduce((sum, payment) => sum + cents(payment.amount), 0);
            if (-cents(body.payment!.amount) > paidCents) {
              throw new ApiError(409, `Die Erstattung übersteigt den bezahlten Betrag von ${(Math.max(0, paidCents) / 100).toFixed(2).replace('.', ',')} €. Erstattet werden kann höchstens, was bezahlt wurde.`);
            }
          }
          // Nor may a payment be removed or lowered below what was already refunded from it.
          if (payments.filter((payment) => !isSkontoPayment(payment)).reduce((sum, payment) => sum + cents(payment.amount), 0) < 0) {
            throw new ApiError(409, 'Von dieser Zahlung wurde bereits erstattet. Bitte zuerst die Erstattung stornieren.');
          }
          if (operation === 'save' && body.payment!.amount > 0) {
            const openCents = cents(before.amount) - cents(await creditedAmount(transaction, session.scope, before.id))
              - payments.filter((payment) => payment.id !== paymentId && !isSkontoPayment(payment)).reduce((sum, payment) => sum + cents(payment.amount), 0);
            if (cents(body.payment!.amount) > openCents) {
              throw new ApiError(409, `Die Zahlung übersteigt den offenen Betrag von ${(Math.max(0, openCents) / 100).toFixed(2).replace('.', ',')} €. Bitte nur den offenen Betrag erfassen; der Rest ist ein Guthaben des Kunden und wird separat erstattet oder verrechnet.`);
            }
          }
          if (product === 'pro') {
            // Pro: a payment is a booking. The invoice lists it, then the booked payment that is changed or
            // removed gets its Zahlungsstorno and the new one is booked (Bank or Kasse an Forderungen) and
            // allocated to the open item, all in this transaction. Status follows the open item.
            const mutation = createMutationContext(session, body.reason);
            const booked = current ? await findActiveOpenItemPayment(transaction, session.scope, 'invoice_payment', current.id) : undefined;
            if (booked) await reverseOpenItemPaymentInTransaction(transaction, session.scope, { paymentId: booked.id, reason: body.reason, mutation });
            const reopened = (await repositories.invoiceRepo.getById(session.scope, before.id))!;
            // The Skonto line is derived by the booking (Pro: allocatePayment), never carried over from the old list.
            const listed = [...payments.filter((payment) => !isSkontoPayment(payment)), ...reopened.payments.filter(isSkontoPayment)];
            await repositories.invoiceRepo.save(session.scope, { ...reopened, status: reopened.status === 'paid' && !booked ? 'open' as const : reopened.status, payments: listed, updatedAt: new Date().toISOString() }, { replacePayments: true });
            if (operation === 'save') await bookInvoicePaymentInTransaction(transaction, session.scope, { invoiceId: before.id, payment: body.payment!, mutation });
            const after = (await repositories.invoiceRepo.getById(session.scope, before.id))!;
            await repositories.auditLog.append(session.scope, buildAuditEntry(session.scope, session, 'invoice', before.id,
              operation === 'reverse' ? 'invoice.payment.reverse' : current ? 'invoice.payment.update' : 'invoice.payment.create', body.reason, before, after));
            return after;
          }
          const next = await withSkontoSettlement(transaction, session.scope, { ...before, status: before.status === 'paid' ? 'open' as const : before.status, payments, updatedAt: new Date().toISOString() });
          const after = await repositories.invoiceRepo.save(session.scope, { ...next, status: await settledInvoiceStatus(transaction, session.scope, next) }, { replacePayments: true });
          await repositories.auditLog.append(session.scope, buildAuditEntry(session.scope, session, 'invoice', before.id,
            operation === 'reverse' ? 'invoice.payment.reverse' : current ? 'invoice.payment.update' : 'invoice.payment.create', body.reason, before, after));
          return after;
        });
        return withInvoiceHistory(database, session.scope, saved);
      },
    });
  }
};
