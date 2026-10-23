import type { FastifyInstance } from 'fastify';
import { createPostgresProAccountingRepository } from '@billme/server-data';
import {
  bookingDraftEntitySchema,
  proBookingSettingsSchema,
  proSaveBookingSettingsArgsSchema,
  proTransferArgsSchema,
  transitOverviewSchema,
  ruleApplicationPreviewSchema,
  proApplyRulesArgsSchema,
} from '@billme/desktop-contracts-pro/schemas';
import { z } from 'zod';
import { ApiError, typedRoute } from './http.js';
import { createMutationContext, requireDatabase, requireMutationSession, requireSession } from './runtimeContext.js';

const reason = z.string().trim().min(1, 'reason is required');

const MESSAGES: Record<string, [number, string]> = {
  TRANSFER_SAME_ACCOUNT: [400, 'Beide Seiten liegen auf demselben Konto.'],
  TRANSFER_AMOUNT_MISMATCH: [400, 'Die Beträge der beiden Seiten gleichen sich nicht aus.'],
  TRANSFER_PARTNER_TAKEN: [409, 'Dieser Umsatz ist schon die Gegenseite einer anderen Umbuchung.'],
  TRANSFER_SIDE_POSTED_ELSEWHERE: [409, 'Eine Seite ist schon anders gebucht. Erst stornieren, dann als Umbuchung buchen.'],
  TRANSFER_SIDE_POSTED_REVERSE_FIRST: [409, 'Diese Seite ist schon auf Geldtransit gebucht. Erst stornieren, dann neu buchen.'],
  TRANSFER_WINDOW_INVALID: [400, 'Das Zeitfenster muss zwischen 0 und 31 Tagen liegen.'],
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

/** Transfers between own accounts, the per-tenant booking switches and "Auf Bestand anwenden" (Einstellungen › Buchhaltung). */
export const registerProTransferRoutes = (app: FastifyInstance) => {
  const prefix = '/api/v1/pro/accounting';
  const repository = () => createPostgresProAccountingRepository(requireDatabase(app));

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/booking-settings`,
    response: proBookingSettingsSchema,
    async handler({ request }) {
      const session = await requireSession(app, 'pro', request.headers.authorization);
      return repository().getBookingSettings(session.scope);
    },
  });

  typedRoute(app, {
    method: 'PUT',
    url: `${prefix}/booking-settings`,
    body: proSaveBookingSettingsArgsSchema.extend({ reason }),
    response: proBookingSettingsSchema,
    async handler({ request, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      const { reason: text, ...settings } = body;
      return mapped(repository().saveBookingSettings(session.scope, { ...settings, mutation: createMutationContext(session, text) }));
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/transfers/confirm`,
    body: proTransferArgsSchema.extend({ reason }),
    response: z.array(bookingDraftEntitySchema),
    async handler({ request, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      const mutation = createMutationContext(session, body.reason);
      const drafts = await mapped(repository().confirmTransfer(session.scope, { transactionId: body.transactionId, partnerTransactionId: body.partnerTransactionId, mutation }));
      if (!body.post) return drafts;
      // Each side posts on its own; a side that fails validation stays approved in Buchen.
      const posted = [];
      for (const draft of drafts) {
        const result = await repository().postDraft(session.scope, draft.id, { postingDate: draft.postingDate, mutation });
        posted.push(result.issues.length ? { ...draft, validationIssues: result.issues } : (await repository().getDraftByTransactionId(session.scope, draft.transactionId)) ?? draft);
      }
      return posted;
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/transfers/reject`,
    body: z.object({ transactionId: z.string().min(1), reason }),
    response: z.object({ ok: z.literal(true) }),
    async handler({ request, body }) {
      const session = await requireMutationSession(app, request.headers.authorization);
      await mapped(repository().rejectTransfer(session.scope, { transactionId: body.transactionId, mutation: createMutationContext(session, body.reason) }));
      return { ok: true as const };
    },
  });

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
    url: `${prefix}/transfers/transit`,
    response: transitOverviewSchema,
    async handler({ request }) {
      const session = await requireSession(app, 'pro', request.headers.authorization);
      return repository().getTransitOverview(session.scope);
    },
  });
};
