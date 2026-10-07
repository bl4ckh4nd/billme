import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { liteVatExportSchema, liteVatPeriodSchema, liteVatReportSchema } from '@billme/server-core';
import { getServerLiteVatReport } from '@billme/server-data';
import { exportLiteVatCsv, exportLiteVatPdf } from '@billme/desktop-services/vatExport';
import { typedRoute } from './http.js';
import { requireDatabase, requireSession } from './runtimeContext.js';

export const registerLiteVatRoutes = (app: FastifyInstance): void => {
  const prefix = '/api/v1/lite/reports/vat';
  typedRoute(app, { method: 'GET', url: prefix, query: liteVatPeriodSchema, response: liteVatReportSchema, async handler({ request, query }) {
    const session = await requireSession(app, 'lite', request.headers.authorization);
    return getServerLiteVatReport(requireDatabase(app), session.scope, query);
  } });
  typedRoute(app, { method: 'GET', url: `${prefix}/export/:format`, params: z.object({ format: z.enum(['csv', 'pdf']) }), query: liteVatPeriodSchema, response: liteVatExportSchema, async handler({ request, params, query }) {
    const session = await requireSession(app, 'lite', request.headers.authorization);
    const report = await getServerLiteVatReport(requireDatabase(app), session.scope, query);
    const bytes = params.format === 'pdf' ? await exportLiteVatPdf(report) : Buffer.from(exportLiteVatCsv(report), 'utf8');
    return { fileName: `umsatzsteuer-vorbereitung-${query.from}-${query.to}.${params.format}`, mimeType: params.format === 'pdf' ? 'application/pdf' as const : 'text/csv' as const, contentBase64: Buffer.from(bytes).toString('base64') };
  } });
};
