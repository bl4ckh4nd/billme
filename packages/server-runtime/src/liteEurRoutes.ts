import type { FastifyInstance } from 'fastify';
import { createPostgresProAccountingRepository, getServerEurReport, listServerEurAnnexFacts, listServerEurCashFacts, listServerEurCashItems, saveServerEurAnnexFact, saveServerEurCashFact, saveServerEurClassificationFact } from '@billme/server-data';
import { z } from 'zod';
import { ApiError, typedRoute } from './http.js';
import { createMutationContext, requireDatabase, requireMutationSessionFor, requireSession } from './runtimeContext.js';

export const liteEurReportQuerySchema = z.object({
  taxYear: z.coerce.number().int().refine((year) => year === 2025 || year === 2026, 'Unsupported EÜR year').optional(), from: z.string().optional(), to: z.string().optional(),
}).superRefine((value, ctx) => {
  const year = value.taxYear ?? 2025;
  if (value.taxYear === undefined && (value.from?.startsWith('2026-') || value.to?.startsWith('2026-'))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['taxYear'], message: 'taxYear is required for 2026' });
  if (value.from !== undefined && value.from !== `${year}-01-01`) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: `EÜR requires ${year}-01-01.` });
  if (value.to !== undefined && value.to !== `${year}-12-31`) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: `EÜR requires ${year}-12-31.` });
}).transform((value) => ({ ...(value.taxYear === undefined ? {} : { taxYear: value.taxYear }), from: value.from ?? `${value.taxYear ?? 2025}-01-01`, to: value.to ?? `${value.taxYear ?? 2025}-12-31` }));

export const liteEurClassificationBodySchema = z.object({
  sourceType: z.enum(['transaction', 'invoice']),
  sourceId: z.string().trim().min(1),
  taxYear: z.union([z.literal(2025), z.literal(2026)]),
  eurLineId: z.string().trim().min(1).optional(),
  excluded: z.boolean().default(false),
  vatMode: z.enum(['none', 'default']).default('none'),
  vatRate: z.number().min(0).max(100).optional(),
  note: z.string().max(1000).optional(),
  reason: z.string().trim().min(1),
});
export const liteEurCashFactBodySchema = z.object({
  sourceType: z.enum(['transaction', 'invoice']), sourceId: z.string().trim().min(1), taxYear: z.union([z.literal(2025), z.literal(2026)]), kind: z.enum(['income', 'expense', 'private-withdrawal', 'private-contribution', 'pass-through']), amountNet: z.number().finite().nonnegative(), flowType: z.enum(['income', 'expense']).optional(), eurLineId: z.string().trim().min(1).optional(), splits: z.array(z.object({ amountNet: z.number().finite().nonnegative(), deductibility: z.enum(['deductible', 'non-deductible']).optional(), classification: z.enum(['deductible', 'non-deductible']).optional(), deductible: z.boolean().optional(), lineId: z.string().trim().min(1).optional(), reason: z.string().trim().min(1), auditId: z.string().trim().min(1).optional() })).optional(), idempotencyKey: z.string().trim().min(1).optional(), reason: z.string().trim().min(1),
});
export const liteEurAnnexFactBodySchema = z.object({ taxYear: z.union([z.literal(2025), z.literal(2026)]), annex: z.string().trim().min(1), lineId: z.string().trim().min(1), amount: z.number().finite(), sourceId: z.string().trim().min(1).optional(), date: z.string().optional(), idempotencyKey: z.string().trim().min(1).optional(), reason: z.string().trim().min(1) });

const mapEurError = (error: unknown): never => {
  if (!(error instanceof Error)) throw error;
  if (error.message === 'EUR_PROFILE_REQUIRED') throw new ApiError(503, 'EÜR ist nur für ein Einzelunternehmen mit Gewinnermittlung EÜR verfügbar.');
  if (error.message === 'EUR_RANGE_2025_REQUIRED' || error.message === 'EUR_RANGE_2026_REQUIRED') throw new ApiError(400, 'EÜR verwendet ausschließlich vollständige Kalenderjahre.');
  if (error.message === 'EUR_SERVER_REPORT_UNAVAILABLE') throw new ApiError(503, 'Native EÜR-Daten sind derzeit nicht verfügbar.');
  if (error.message === 'EUR_SOURCE_NOT_FOUND') throw new ApiError(400, 'Die EÜR-Cash-Quelle ist im gewählten Kalenderzeitraum nicht vorhanden.');
  if (error.message === 'EUR_FACT_IDEMPOTENCY_CONFLICT') throw new ApiError(409, error.message);
  if (/^EUR_(FACT|SPLIT|ANNEX|NEUTRAL)|^EUR_LINE_|^EUR_COMPUTED/.test(error.message)) throw new ApiError(400, error.message);
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
        return await getServerEurReport(requireDatabase(app), session.scope, { ...query, product: 'lite' });
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
        return await listServerEurCashItems(requireDatabase(app), session.scope, { ...query, product: 'lite' });
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
      const session = await requireMutationSessionFor(app, 'lite', request.headers.authorization, 'EÜR-Klassifikation benötigt die Rolle owner, admin oder accountant.');
      try {
        const input = {
          sourceType: body.sourceType,
          sourceId: body.sourceId,
          taxYear: body.taxYear,
          eurLineId: body.eurLineId,
          excluded: body.excluded,
          vatMode: body.vatMode,
          vatRate: body.vatRate,
          note: body.note,
          product: 'lite' as const,
          mutation: createMutationContext(session, body.reason),
        };
        return body.taxYear === 2026
          ? await saveServerEurClassificationFact(requireDatabase(app), session.scope, input)
          : await createPostgresProAccountingRepository(requireDatabase(app)).upsertEurClassification(session.scope, input);
      } catch (error) {
        return mapEurError(error);
      }
    },
  });

  typedRoute(app, { method: 'POST', url: `${prefix}/facts/cash`, body: liteEurCashFactBodySchema, async handler({ request, body }) {
    const session = await requireMutationSessionFor(app, 'lite', request.headers.authorization, 'EÜR-Fakten benötigen die Rolle owner, admin oder accountant.');
    try {
      return await saveServerEurCashFact(requireDatabase(app), session.scope, { ...body, product: 'lite', mutation: createMutationContext(session, body.reason) });
    } catch (error) {
      return mapEurError(error);
    }
  }});
  typedRoute(app, { method: 'POST', url: `${prefix}/facts/annex`, body: liteEurAnnexFactBodySchema, async handler({ request, body }) {
    const session = await requireMutationSessionFor(app, 'lite', request.headers.authorization, 'EÜR-Fakten benötigen die Rolle owner, admin oder accountant.');
    try {
      return await saveServerEurAnnexFact(requireDatabase(app), session.scope, { ...body, mutation: createMutationContext(session, body.reason) });
    } catch (error) {
      return mapEurError(error);
    }
  }});
  typedRoute(app, { method: 'GET', url: `${prefix}/facts/cash`, query: z.object({ taxYear: z.coerce.number().int().refine((year) => year === 2025 || year === 2026) }), async handler({ request, query }) {
    const session = await requireSession(app, 'lite', request.headers.authorization);
    return listServerEurCashFacts(requireDatabase(app), session.scope, query.taxYear);
  }});
  typedRoute(app, { method: 'GET', url: `${prefix}/facts/annex`, query: z.object({ taxYear: z.coerce.number().int().refine((year) => year === 2025 || year === 2026), annex: z.string().trim().min(1).optional() }), async handler({ request, query }) {
    const session = await requireSession(app, 'lite', request.headers.authorization);
    return listServerEurAnnexFacts(requireDatabase(app), session.scope, query.taxYear, query.annex);
  }});
};
