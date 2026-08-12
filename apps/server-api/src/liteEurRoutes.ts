import type { FastifyInstance } from 'fastify';
import { createPostgresProAccountingRepository, getServerEurReport, listServerEurCashItems } from '@billme/server-data';
import { z } from 'zod';
import { ApiError, typedRoute } from './http.js';
import { requirePool, requireSession } from './app.js';

export const liteEurReportQuerySchema = z.object({
  from: z.literal('2025-01-01').default('2025-01-01'),
  to: z.literal('2025-12-31').default('2025-12-31'),
});

export const liteEurClassificationBodySchema = z.object({
  sourceType: z.enum(['transaction', 'invoice']),
  sourceId: z.string().trim().min(1),
  taxYear: z.literal(2025),
  eurLineId: z.string().trim().min(1).optional(),
  excluded: z.boolean().default(false),
  vatMode: z.enum(['none', 'default']).default('none'),
  vatRate: z.number().min(0).max(100).optional(),
  note: z.string().max(1000).optional(),
  reason: z.string().trim().min(1),
});

const isMutationRole = (role: string): boolean => ['owner', 'admin', 'accountant'].includes(role);

const mapEurError = (error: unknown): never => {
  if (!(error instanceof Error)) throw error;
  if (error.message === 'EUR_PROFILE_REQUIRED') throw new ApiError(503, 'EÜR ist nur für ein Einzelunternehmen mit Gewinnermittlung EÜR verfügbar.');
  if (error.message === 'EUR_RANGE_2025_REQUIRED') throw new ApiError(400, 'EÜR verwendet ausschließlich den Kalenderzeitraum 2025.');
  if (error.message === 'EUR_SERVER_REPORT_UNAVAILABLE') throw new ApiError(503, 'Native EÜR-Daten sind derzeit nicht verfügbar.');
  if (error.message === 'EUR_SOURCE_NOT_FOUND') throw new ApiError(400, 'Die EÜR-Cash-Quelle ist im Kalenderzeitraum 2025 nicht vorhanden.');
  if (error.message === 'EUR_LINE_NOT_FOUND') throw new ApiError(400, 'Die EÜR-Kennziffer ist für den Katalog 2025 nicht vorhanden.');
  if (error.message === 'EUR_COMPUTED_LINE_NOT_CLASSIFIABLE') throw new ApiError(400, 'Berechnete EÜR-Zeilen können nicht direkt klassifiziert werden.');
  if (error.message === 'EUR_LINE_FLOW_MISMATCH') throw new ApiError(400, 'Die Zielzeile passt nicht zum Einnahmen-/Ausgabenfluss der Quelle.');
  throw error;
};

export const registerLiteEurRoutes = (app: FastifyInstance): void => {
  const prefix = '/api/v1/lite/reports/eur';

  typedRoute(app, {
    method: 'GET',
    url: prefix,
    query: liteEurReportQuerySchema,
    async handler({ request, query }) {
      const session = await requireSession(app, 'lite', request.headers.authorization);
      try {
        return await getServerEurReport(requirePool(app), session.scope, { ...query, product: 'lite' });
      } catch (error) {
        return mapEurError(error);
      }
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/items`,
    query: liteEurReportQuerySchema,
    async handler({ request, query }) {
      const session = await requireSession(app, 'lite', request.headers.authorization);
      try {
        return await listServerEurCashItems(requirePool(app), session.scope, { ...query, product: 'lite' });
      } catch (error) {
        return mapEurError(error);
      }
    },
  });

  typedRoute(app, {
    method: 'PUT',
    url: `${prefix}/classifications`,
    body: liteEurClassificationBodySchema,
    async handler({ request, body }) {
      const session = await requireSession(app, 'lite', request.headers.authorization);
      if (!isMutationRole(session.role)) throw new ApiError(403, 'EÜR-Klassifikation benötigt die Rolle owner, admin oder accountant.');
      try {
        return await createPostgresProAccountingRepository(requirePool(app)).upsertEurClassification(session.scope, {
          sourceType: body.sourceType,
          sourceId: body.sourceId,
          taxYear: body.taxYear,
          eurLineId: body.eurLineId,
          excluded: body.excluded,
          vatMode: body.vatMode,
          vatRate: body.vatRate,
          note: body.note,
          product: 'lite',
          mutation: {
            reason: body.reason,
            actor: { type: 'user', id: session.user.id, displayName: session.user.fullName },
          },
        });
      } catch (error) {
        return mapEurError(error);
      }
    },
  });
};
