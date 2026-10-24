import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { localIsoDate, liteCashEntryInputSchema, liteCashEntrySchema, liteReceiptInputSchema, liteReceiptSchema, liteReceiptFileSchema, liteReceiptUploadSchema } from '@billme/server-core';
import { closeLitePeriod, listLiteClosedPeriods, listLiteCashEntries, listLiteReceipts, saveLiteCashEntry, saveLiteReceipt, matchLiteCashEntry, deleteLiteCashEntry, listLiteReceiptFiles, uploadLiteReceiptFile, getLiteReceiptFile } from '@billme/server-data';
import { ApiError, typedRoute } from './http.js';
import { createMutationContext, requireDatabase, requireMutationSessionFor, requireSession } from './runtimeContext.js';

const idParams = z.object({ id: z.string().min(1) });
const reason = z.string().trim().min(1);
const guard = async <T>(work: () => Promise<T>): Promise<T> => {
  try { return await work(); } catch (error) {
    if (error instanceof Error && error.message.startsWith('LITE_')) {
      const code = error.message;
      throw new ApiError(code.endsWith('NOT_FOUND') ? 404 : /STALE|MATCHED|MATCH_INVALID|PERIOD_CLOSED/.test(code) ? 409 : 400,
        code === 'LITE_PERIOD_CLOSED' ? `Der Monat ${(error as Error & { period?: string }).period ?? ''} ist festgeschrieben; Korrekturen bitte in einem offenen Monat buchen.` : code === 'LITE_PERIOD_INVALID' ? 'Festgeschrieben werden kann nur ein abgelaufener Monat (JJJJ-MM).' : code === 'LITE_CASH_STALE' ? 'Eintrag wurde inzwischen geändert. Bitte neu laden.' : code === 'LITE_CASH_MATCHED' ? 'Bitte zuerst den Bankabgleich rückgängig machen.' : code === 'LITE_CASH_MATCH_INVALID' ? 'Bankzahlung ist bereits zugeordnet oder Betrag, Datum beziehungsweise Währung passen nicht.' : code === 'LITE_RECEIPT_TAX_INCOMPLETE' ? 'Für einen geprüften Beleg fehlen Datum oder eine vollständige Steueraufteilung.' : code === 'LITE_RECEIPT_FILE_INVALID' ? 'Belegdatei ist ungültig. Erlaubt sind PDF, Bilder und UTF-8-XML ohne DTD oder externe Entitäten bis 10 MB.' : code);
    }
    throw error;
  }
};

export const registerLiteCashRoutes = (app: FastifyInstance) => {
  const prefix = '/api/v1/lite/cash';
  typedRoute(app, { method: 'GET', url: `${prefix}/entries`, response: z.array(liteCashEntrySchema), async handler({ request }) {
    const session = await requireSession(app, 'lite', request.headers.authorization); return listLiteCashEntries(requireDatabase(app), session.scope);
  } });
  typedRoute(app, { method: 'GET', url: `${prefix}/receipts`, response: z.array(liteReceiptSchema), async handler({ request }) {
    const session = await requireSession(app, 'lite', request.headers.authorization); return listLiteReceipts(requireDatabase(app), session.scope);
  } });
  typedRoute(app, { method: 'POST', url: `${prefix}/entries`, body: z.object({ entry: liteCashEntryInputSchema, expectedUpdatedAt: z.string().optional(), reason }), response: liteCashEntrySchema, async handler({ request, body }) {
    const session = await requireMutationSessionFor(app, 'lite', request.headers.authorization); return guard(() => saveLiteCashEntry(requireDatabase(app), session.scope, body.entry, body.expectedUpdatedAt, createMutationContext(session, body.reason)));
  } });
  typedRoute(app, { method: 'POST', url: `${prefix}/receipts`, body: z.object({ receipt: liteReceiptInputSchema, expectedUpdatedAt: z.string().optional(), reason }), response: liteReceiptSchema, async handler({ request, body }) {
    const session = await requireMutationSessionFor(app, 'lite', request.headers.authorization); return guard(() => saveLiteReceipt(requireDatabase(app), session.scope, body.receipt, body.expectedUpdatedAt, createMutationContext(session, body.reason)));
  } });
  typedRoute(app, { method: 'DELETE', url: `${prefix}/entries/:id`, params: idParams, body: z.object({ expectedUpdatedAt: z.string(), reason }), response: z.object({ ok: z.literal(true) }), async handler({ request, params, body }) {
    const session = await requireMutationSessionFor(app, 'lite', request.headers.authorization); return guard(() => deleteLiteCashEntry(requireDatabase(app), session.scope, params.id, body.expectedUpdatedAt, createMutationContext(session, body.reason)));
  } });
  for (const operation of ['match', 'unmatch'] as const) {
    typedRoute(app, { method: 'POST', url: `${prefix}/entries/:id/${operation}`, params: idParams, body: z.object({ transactionId: z.string().optional(), expectedCashDate: z.string().optional(), transit: z.boolean().optional(), reason }), response: liteCashEntrySchema, async handler({ request, params, body }) {
      if (operation === 'match' && (!body.transactionId || !body.expectedCashDate)) throw new ApiError(400, 'Bankzahlung und bisheriges Zahlungsdatum fehlen.');
      const session = await requireMutationSessionFor(app, 'lite', request.headers.authorization); return guard(() => matchLiteCashEntry(requireDatabase(app), session.scope, params.id, operation === 'match' ? body.transactionId : undefined, body.expectedCashDate, createMutationContext(session, body.reason), body.transit === true));
    } });
  }
  typedRoute(app, { method: 'GET', url: `${prefix}/periods`, response: z.array(z.object({ period: z.string(), closedAt: z.string() })), async handler({ request }) {
    const session = await requireSession(app, 'lite', request.headers.authorization); return listLiteClosedPeriods(requireDatabase(app), session.scope);
  } });
  typedRoute(app, { method: 'POST', url: `${prefix}/periods/close`, body: z.object({ period: z.string(), reason }), response: z.object({ period: z.string(), closed: z.literal(true) }), async handler({ request, body }) {
    const session = await requireMutationSessionFor(app, 'lite', request.headers.authorization);
    return guard(() => closeLitePeriod(requireDatabase(app), session.scope, body.period, localIsoDate(new Date()), createMutationContext(session, body.reason)));
  } });
  typedRoute(app, { method: 'GET', url: `${prefix}/receipts/:id/files`, params: idParams, response: z.array(liteReceiptFileSchema), async handler({ request, params }) {
    const session = await requireSession(app, 'lite', request.headers.authorization); return listLiteReceiptFiles(requireDatabase(app), session.scope, params.id);
  } });
  typedRoute(app, { method: 'POST', url: `${prefix}/receipts/:id/files`, params: idParams, body: liteReceiptUploadSchema, bodyLimit: 14_500_000, response: liteReceiptFileSchema, async handler({ request, params, body }) {
    const session = await requireMutationSessionFor(app, 'lite', request.headers.authorization); return guard(() => uploadLiteReceiptFile(requireDatabase(app), session.scope, params.id, body, createMutationContext(session, body.reason)));
  } });
  typedRoute(app, { method: 'GET', url: `${prefix}/files/:id`, params: idParams, response: liteReceiptFileSchema.extend({ contentBase64: z.string() }), async handler({ request, params }) {
    const session = await requireSession(app, 'lite', request.headers.authorization); return guard(() => getLiteReceiptFile(requireDatabase(app), session.scope, params.id));
  } });
};
