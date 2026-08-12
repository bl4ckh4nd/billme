import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TaxFilingError, createTaxFilingRecord, transitionTaxFiling } from '@billme/accounting-engine';
import {
  taxFilingCreateRequestSchema,
  taxFilingMutationRequestSchema,
  taxFilingSchema,
  createTaxFilingService,
  TaxFilingServiceError,
} from '@billme/server-core';
import {
  createPostgresAuditLogPort,
  createPostgresTaxFilingRepository,
  getReportSnapshot,
  withPostgresTransaction,
} from '@billme/server-data';
import { ApiError, typedRoute } from './http.js';
import { requireMutationSession, requirePool, requireSession } from './app.js';

const stateMachine = { create: createTaxFilingRecord, transition: transitionTaxFiling };

const idParams = z.object({ id: z.string().trim().min(1) });
const actionParams = idParams.extend({
  action: z.enum(['validate', 'freeze', 'request-second-approval', 'approve', 'queue', 'retry']),
});

const actionForPath = (action: z.infer<typeof actionParams>['action']) =>
  action === 'request-second-approval' ? 'request_second_approval' as const : action;

const toApiError = (error: unknown): never => {
  if (error instanceof TaxFilingError) {
    const status = error.code === 'INVALID_TRANSITION' || error.code === 'CONCURRENT_UPDATE' ? 409 : error.code === 'SELF_APPROVAL_FORBIDDEN' ? 403 : 422;
    throw new ApiError(status, error.message);
  }
  if (error instanceof TaxFilingServiceError) {
    throw new ApiError(error.code === 'INVALID_TRANSITION' || error.code === 'CONCURRENT_UPDATE' ? 409 : 422, error.message);
  }
  throw error;
};

const serviceFor = (app: FastifyInstance, db = requirePool(app)) => createTaxFilingService({
  repository: createPostgresTaxFilingRepository(db),
  stateMachine,
  auditLog: createPostgresAuditLogPort(db),
  reportSnapshot: { get: async (scope, id) => {
    const snapshot = await getReportSnapshot(db, scope, id);
    return snapshot ? { id: snapshot.id, tenantId: snapshot.tenantId, sourceHash: snapshot.sourceHash } : null;
  } },
});

export const registerTaxFilingRoutes = (app: FastifyInstance): void => {
  const prefix = '/api/v1/pro/tax-filings';

  typedRoute(app, {
    method: 'GET',
    url: prefix,
    response: z.array(taxFilingSchema),
    async handler({ request }) {
      const session = await requireSession(app, 'pro', request.headers.authorization);
      return serviceFor(app).list(session.scope);
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/:id`,
    params: idParams,
    response: taxFilingSchema.nullable(),
    async handler({ request, params }) {
      const session = await requireSession(app, 'pro', request.headers.authorization);
      return serviceFor(app).get(session.scope, params.id);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: prefix,
    body: taxFilingCreateRequestSchema,
    response: taxFilingSchema,
    async handler({ request, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      const expectedProvider = body.kind === 'euer'
        ? 'eric_euer'
        : body.kind === 'e_bilanz'
          ? 'eric_e_bilanz'
          : 'unternehmensregister';
      if (body.provider && body.provider !== expectedProvider) {
        throw new ApiError(422, `Provider ${body.provider} cannot transmit ${body.kind}`);
      }
      try {
        return await withPostgresTransaction(requirePool(app), async (client) => createTaxFilingService({
          repository: createPostgresTaxFilingRepository(client),
          stateMachine,
          auditLog: createPostgresAuditLogPort(client),
          reportSnapshot: { get: async (scope, id) => {
            const snapshot = await getReportSnapshot(client, scope, id);
            return snapshot ? { id: snapshot.id, tenantId: snapshot.tenantId, sourceHash: snapshot.sourceHash } : null;
          } },
        }).create(session.scope, {
          id: body.id,
          kind: body.kind,
          provider: body.provider,
          periodStart: body.periodStart,
          periodEnd: body.periodEnd,
          payload: body.payload,
          idempotencyKey: body.idempotencyKey,
          actorId: session.user.id,
          reason: body.reason,
        }));
      } catch (error) {
        return toApiError(error);
      }
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/:id/:action`,
    params: actionParams,
    body: taxFilingMutationRequestSchema,
    response: taxFilingSchema,
    async handler({ request, params, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      try {
        return await withPostgresTransaction(requirePool(app), async (client) => createTaxFilingService({
          repository: createPostgresTaxFilingRepository(client),
          stateMachine,
          auditLog: createPostgresAuditLogPort(client),
          reportSnapshot: { get: async (scope, id) => {
            const snapshot = await getReportSnapshot(client, scope, id);
            return snapshot ? { id: snapshot.id, tenantId: snapshot.tenantId, sourceHash: snapshot.sourceHash } : null;
          } },
        }).transition(session.scope, params.id, actionForPath(params.action), {
          actorId: session.user.id,
          reason: body.reason,
          idempotencyKey: body.idempotencyKey,
        }));
      } catch (error) {
        return toApiError(error);
      }
    },
  });
};
