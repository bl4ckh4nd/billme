import type { FastifyInstance } from 'fastify';
import { createPostgresProAccountingRepository } from '@billme/server-data';
import {
  transitOverviewSchema,
  ruleApplicationPreviewSchema,
  proApplyRulesArgsSchema,
} from '@billme/desktop-contracts-pro/schemas';
import { z } from 'zod';
import { ApiError, typedRoute } from './http.js';
import { createMutationContext, requireDatabase, requireMutationSession, requireSession } from './runtimeContext.js';

const reason = z.string().trim().min(1, 'reason is required');

const MESSAGES: Record<string, [number, string]> = {
  RULE_PREVIEW_STALE: [409, 'Seit dem Probelauf hat sich etwas geändert. Bitte den Probelauf neu starten.'],
  RULE_CONDITIONS_REQUIRED: [400, 'Eine Regel braucht mindestens eine Bedingung.'],
  RULE_CONDITION_VALUE_REQUIRED: [400, 'Jede Bedingung braucht einen Wert.'],
  RULE_AMOUNT_INVALID: [400, 'Der Betrag ist keine Zahl.'],
  RULE_ACTION_REQUIRED: [400, 'Eine Regel muss mindestens ein Feld des Buchungssatzes setzen.'],
  RULE_BASE_ACCOUNT_REQUIRED: [400, 'Eine Basisregel braucht ein Konto. Regeln, die nur ändern, sind Overrides.'],
  RULE_DEDUCTIBLE_INVALID: [400, 'Der abzugsfähige Anteil muss zwischen 0 und 100 % liegen.'],
};
/** Repository error codes to German API errors; also used by the rule routes in app.ts. */
export const mapped = <T>(work: Promise<T>): Promise<T> => work.catch((error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  const hit = MESSAGES[message];
  if (hit) throw new ApiError(hit[0], hit[1]);
  if (message.startsWith('RULE_REGEX_INVALID:')) throw new ApiError(400, `Regulärer Ausdruck ungültig: ${message.slice('RULE_REGEX_INVALID:'.length)}`);
  if (message.startsWith('UNKNOWN_TAX_CASE:')) throw new ApiError(400, `Unbekannter Steuerfall ${message.slice('UNKNOWN_TAX_CASE:'.length)}.`);
  throw error;
});

/** "Auf Bestand anwenden" for booking rules and the Geldtransit balance (Ausnahmen). */
export const registerProBookingRuleRoutes = (app: FastifyInstance) => {
  const prefix = '/api/v1/pro/accounting';
  const repository = () => createPostgresProAccountingRepository(requireDatabase(app));

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/rules/preview`,
    response: ruleApplicationPreviewSchema,
    async handler({ request }) {
      const session = await requireSession(app, 'pro', request.headers.authorization);
      return repository().previewRuleApplication(session.scope);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/rules/apply`,
    body: proApplyRulesArgsSchema.extend({ reason }),
    response: z.object({ updated: z.number().int() }),
    async handler({ request, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      return mapped(repository().applyRules(session.scope, { previewHash: body.previewHash, mutation: createMutationContext(session, body.reason) }));
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/transit`,
    response: transitOverviewSchema,
    async handler({ request }) {
      const session = await requireSession(app, 'pro', request.headers.authorization);
      return repository().getTransitOverview(session.scope);
    },
  });
};
