import type { FastifyInstance } from 'fastify';
import { exportPostgresAuditCsv, verifyPostgresAuditChain } from '@billme/server-data';
import { requireDatabase, requireSession } from './runtimeContext.js';
import { typedRoute } from './http.js';
import { z } from 'zod';

const auditVerificationSchema = z.object({
  ok: z.boolean(),
  errors: z.array(z.object({ sequence: z.number(), message: z.string() })),
  count: z.number(),
  headHash: z.string().nullable(),
});

export const registerAuditRoutes = (app: FastifyInstance, product: 'lite' | 'pro'): void => {
  const prefix = `/api/v1/${product}/audit`;

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/verify`,
    response: auditVerificationSchema,
    async handler({ request }) {
      const session = await requireSession(app, product, request.headers.authorization);
      return verifyPostgresAuditChain(requireDatabase(app), session.scope.tenantId);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/export.csv`,
    async handler({ request, reply }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const csv = await exportPostgresAuditCsv(requireDatabase(app), session.scope.tenantId);
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', 'attachment; filename="audit.csv"');
      return reply.send(Buffer.from(csv, 'utf8'));
    },
  });
};
