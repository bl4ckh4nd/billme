import type { FastifyInstance } from 'fastify';
import { createPostgresBillingDependencies, deleteServerEurRule, listServerEurRules, upsertServerEurRule } from '@billme/server-data';
import { eurRuleSchema, eurUpsertRuleArgsSchema } from '@billme/desktop-contracts-pro/schemas';
import { z } from 'zod';
import { requirePool, requireSession } from './app.js';
import { ApiError, typedRoute } from './http.js';

const ruleQuerySchema = z.object({ taxYear: z.coerce.number().int().min(2025) });
const ruleUpsertBodySchema = eurUpsertRuleArgsSchema.extend({ reason: z.string().trim().min(1) });
const ruleDeleteBodySchema = z.object({ reason: z.string().trim().min(1) });
const okSchema = z.object({ ok: z.literal(true) });

const isMutationRole = (role: string): boolean => ['owner', 'admin', 'accountant'].includes(role);

const actorFor = (session: Awaited<ReturnType<typeof requireSession>>) => ({
  type: 'user' as const,
  id: session.user.id,
  displayName: session.user.fullName,
});

const publicRule = (rule: Awaited<ReturnType<typeof upsertServerEurRule>>) => eurRuleSchema.parse({
  id: rule.id,
  taxYear: rule.taxYear,
  priority: rule.priority,
  field: rule.field,
  operator: rule.operator,
  value: rule.value,
  targetEurLineId: rule.targetEurLineId,
  active: rule.active,
  createdAt: rule.createdAt,
  updatedAt: rule.updatedAt,
});

export const registerEurRuleRoutes = (app: FastifyInstance, product: 'lite' | 'pro'): void => {
  const prefix = product === 'pro' ? '/api/v1/pro/accounting/reports/eur/rules' : '/api/v1/lite/reports/eur/rules';

  typedRoute(app, {
    method: 'GET',
    url: prefix,
    query: ruleQuerySchema,
    response: z.array(eurRuleSchema),
    async handler({ request, query }) {
      const session = await requireSession(app, product, request.headers.authorization);
      const rules = await listServerEurRules(requirePool(app), session.scope, query.taxYear);
      return rules.map(publicRule);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: prefix,
    body: ruleUpsertBodySchema,
    response: eurRuleSchema,
    async handler({ request, body }) {
      const session = await requireSession(app, product, request.headers.authorization);
      if (!isMutationRole(session.role)) throw new ApiError(403, 'EÜR-Regeln benötigen die Rolle owner, admin oder accountant.');
      const { reason, ...ruleInput } = body;
      const saved = await upsertServerEurRule(requirePool(app), session.scope, ruleInput);
      await createPostgresBillingDependencies(requirePool(app)).auditLog.append(session.scope, {
        occurredAt: new Date().toISOString(),
        action: 'eur_rule.upsert',
        reason,
        actor: actorFor(session),
        subject: { entityType: 'eur_rule', entityId: saved.id, tenantId: session.scope.tenantId },
        change: { after: saved },
      });
      return publicRule(saved);
    },
  });

  typedRoute(app, {
    method: 'DELETE',
    url: `${prefix}/:id`,
    params: z.object({ id: z.string().min(1) }),
    body: ruleDeleteBodySchema,
    response: okSchema,
    async handler({ request, params, body }) {
      const session = await requireSession(app, product, request.headers.authorization);
      if (!isMutationRole(session.role)) throw new ApiError(403, 'EÜR-Regeln benötigen die Rolle owner, admin oder accountant.');
      const deleted = await deleteServerEurRule(requirePool(app), session.scope, params.id);
      if (!deleted) throw new ApiError(404, 'EUR_RULE_NOT_FOUND');
      await createPostgresBillingDependencies(requirePool(app)).auditLog.append(session.scope, {
        occurredAt: new Date().toISOString(),
        action: 'eur_rule.delete',
        reason: body.reason,
        actor: actorFor(session),
        subject: { entityType: 'eur_rule', entityId: deleted.id, tenantId: session.scope.tenantId },
        change: { before: deleted },
      });
      return { ok: true as const };
    },
  });
};
