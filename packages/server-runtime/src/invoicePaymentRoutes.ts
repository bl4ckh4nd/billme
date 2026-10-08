import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invoiceSchema, paymentSchema, type Payment } from '@billme/server-core';
import { assertLitePeriodsOpen, createPostgresBillingDependencies, periodClosedMessage } from '@billme/server-data';
import { buildAuditEntry, withInvoiceHistory } from './auditHistory.js';
import { settledInvoiceStatus } from './documentIssuance.js';
import { isReceivableDocumentKind } from '@billme/server-core';
import { ApiError, typedRoute } from './http.js';
import { requireDatabase, requireMutationSessionFor } from './runtimeContext.js';

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
          const current = before.payments.find((payment) => payment.id === paymentId);
          if (operation === 'save' && current && body.payment && samePayment(current, body.payment)) return before;
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
          const next = { ...before, status: before.status === 'paid' ? 'open' as const : before.status, payments, updatedAt: new Date().toISOString() };
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
