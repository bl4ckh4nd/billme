import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  authUserSchema,
  createSingleTenantScope,
  serverProductSchema,
  serverRoleSchema,
  teamInviteResultSchema,
  teamSchema,
  workspaceSummarySchema,
  type ServerProduct,
  type ServerRole,
} from '@billme/server-core';
import { createPostgresBillingDependencies, createWorkspaceAccess, type WorkspaceAccess, type WorkspacePrincipal } from '@billme/server-data';
import type { AuthSession } from './auth.js';
import { acceptsSetupToken } from './authStore.js';
import { ApiError, typedRoute } from './http.js';
import { renderPlatformMail, type PlatformMailer } from './platformMail.js';
import { createMutationContext, requireDatabase, requireSession } from './runtimeContext.js';

/**
 * Hosted server mode as a multi-workspace service: sign-up with the setup code,
 * more workspaces per person, switching between them, members and invitations,
 * and password reset. Only registered for the hosted runtime; the desktop has one
 * local person and workspace.
 */

const ROLE_LABELS: Record<ServerRole, string> = {
  owner: 'Inhaber', admin: 'Admin', accountant: 'Buchhaltung', sales: 'Vertrieb', viewer: 'Lesezugriff',
};

const productQuerySchema = z.object({ product: serverProductSchema.default('lite') });
const passwordSchema = z.string().min(12);
const workspaceNameSchema = z.string().trim().min(1).max(120);
const authResponseSchema = z.object({ token: z.string().min(1), user: authUserSchema, tenantId: z.string().min(1), product: serverProductSchema });
const okSchema = z.object({ ok: z.literal(true) });

/**
 * ponytail: counts live in this process; with several API instances the limit
 * is per instance. Move to Postgres or the proxy when the API scales out.
 */
const createRateLimiter = (limit: number, windowMs: number) => {
  const hits = new Map<string, { count: number; startedAt: number }>();
  return (key: string) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.startedAt > windowMs) {
      hits.set(key, { count: 1, startedAt: now });
      if (hits.size > 10_000) {
        for (const [candidate, value] of hits) if (now - value.startedAt > windowMs) hits.delete(candidate);
      }
      return;
    }
    entry.count += 1;
    if (entry.count > limit) throw new ApiError(429, 'Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.');
  };
};

export interface WorkspaceRouteOptions {
  readonly setupToken: string | undefined;
  readonly initialSettingsJson: string;
  readonly mailer: PlatformMailer;
  /** Where people open each product, for links in mails. */
  readonly webUrls: Partial<Record<ServerProduct, string>>;
}

export const registerWorkspaceRoutes = (app: FastifyInstance, options: WorkspaceRouteOptions): void => {
  const access = (): WorkspaceAccess => createWorkspaceAccess(requireDatabase(app), { initialSettingsJson: options.initialSettingsJson });
  const limit = createRateLimiter(20, 15 * 60 * 1000);
  const limitFor = (request: FastifyRequest, route: string) => limit(`${route}:${request.ip}`);

  const sign = (principal: WorkspacePrincipal) => ({
    token: app.tokenService.sign({
      user: principal.user,
      scope: createSingleTenantScope(principal.tenantId, principal.product),
      role: principal.role,
    }),
    user: principal.user,
    tenantId: principal.tenantId,
    product: principal.product,
  });

  /** Any valid session of either product identifies the person for the account-level routes. */
  const personOf = (request: FastifyRequest): AuthSession => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
    const session = token ? app.tokenService.verify(token) : null;
    if (!session) throw new ApiError(401, 'Authentication required');
    return session;
  };

  const requireSetupCode = (candidate: string | undefined) => {
    if (!acceptsSetupToken(candidate, options.setupToken)) throw new ApiError(403, 'Invalid setup token');
  };

  const linkFor = (product: ServerProduct, param: 'invite' | 'reset', token: string): string => {
    const base = (options.webUrls[product] ?? '').replace(/\/+$/, '');
    return `${base}/?${param}=${encodeURIComponent(token)}`;
  };

  // ---- sign-up and workspaces ----------------------------------------------------------

  /** Where each product's web app lives, so one app can send people to the other. */
  typedRoute(app, {
    method: 'GET',
    url: '/api/v1/auth/apps',
    response: z.object({ lite: z.string().optional(), pro: z.string().optional() }),
    async handler() {
      return {
        ...(options.webUrls.lite ? { lite: options.webUrls.lite } : {}),
        ...(options.webUrls.pro ? { pro: options.webUrls.pro } : {}),
      };
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: '/api/v1/auth/signup',
    query: productQuerySchema,
    body: z.object({
      email: z.string().email(),
      password: passwordSchema,
      fullName: z.string().trim().min(1),
      workspaceName: workspaceNameSchema,
      setupToken: z.string().optional(),
    }),
    response: authResponseSchema,
    async handler({ request, query, body }) {
      limitFor(request, 'signup');
      requireSetupCode(body.setupToken);
      return sign(await access().signUp({ ...body, product: query.product }));
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: '/api/v1/auth/workspaces',
    response: z.array(workspaceSummarySchema),
    async handler({ request }) {
      return access().listWorkspaces(personOf(request).user.id);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: '/api/v1/auth/workspaces',
    body: z.object({ name: workspaceNameSchema, product: serverProductSchema, setupToken: z.string().optional() }),
    response: authResponseSchema,
    async handler({ request, body }) {
      const person = personOf(request);
      limitFor(request, 'create-workspace');
      requireSetupCode(body.setupToken);
      return sign(await access().createWorkspace(person.user.id, { name: body.name, product: body.product }));
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: '/api/v1/auth/switch',
    query: productQuerySchema,
    body: z.object({ tenantId: z.string().min(1) }),
    response: authResponseSchema,
    async handler({ request, query, body }) {
      return sign(await access().enterWorkspace(personOf(request).user.id, body.tenantId, query.product));
    },
  });

  // ---- invitations (public side) -------------------------------------------------------

  typedRoute(app, {
    method: 'GET',
    url: '/api/v1/auth/invitations/:token',
    params: z.object({ token: z.string().min(16) }),
    response: z.object({ email: z.string(), role: serverRoleSchema, workspaceName: z.string(), product: serverProductSchema, userExists: z.boolean() }),
    async handler({ request, params }) {
      limitFor(request, 'invitation');
      return access().describeInvitation(params.token);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: '/api/v1/auth/invitations/:token/accept',
    params: z.object({ token: z.string().min(16) }),
    body: z.object({ password: z.string().min(1), fullName: z.string().optional() }),
    response: authResponseSchema,
    async handler({ request, params, body }) {
      limitFor(request, 'invitation');
      return sign(await access().acceptInvitation(params.token, body));
    },
  });

  // ---- password reset ------------------------------------------------------------------

  typedRoute(app, {
    method: 'POST',
    url: '/api/v1/auth/password-reset',
    query: productQuerySchema,
    body: z.object({ email: z.string().email() }),
    response: okSchema,
    async handler({ request, query, body, reply }) {
      limitFor(request, 'password-reset');
      const reset = await access().requestPasswordReset(body.email);
      // Known and unknown addresses get the same answer; only a known one gets mail.
      if (reset) {
        const url = linkFor(query.product, 'reset', reset.token);
        const mail = renderPlatformMail({
          greeting: `Hallo ${reset.user.fullName},`,
          body: 'jemand hat für dein Billme-Konto ein neues Passwort angefordert. Der Link gilt eine Stunde. Warst du das nicht, ignoriere diese Mail.',
          action: 'Neues Passwort festlegen',
          url,
          footer: 'Billme',
        });
        const result = await options.mailer({ to: reset.user.email, subject: 'Neues Passwort für Billme', ...mail, idempotencyKey: `reset-${reset.token.slice(0, 16)}` });
        if (!result.sent) app.log.warn({ error: result.error }, 'Password reset mail was not sent');
      }
      reply.code(202);
      return { ok: true as const };
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: '/api/v1/auth/password-reset/confirm',
    body: z.object({ token: z.string().min(16), password: passwordSchema }),
    response: okSchema,
    async handler({ request, body }) {
      limitFor(request, 'password-reset');
      await access().resetPassword(body.token, body.password);
      return { ok: true as const };
    },
  });

  // ---- members (per product, owners and admins) ------------------------------------------

  for (const product of ['lite', 'pro'] as const) {
    const prefix = `/api/v1/${product}`;
    const manager = async (request: FastifyRequest) => {
      const session = await requireSession(app, product, request.headers.authorization);
      if (session.role !== 'owner' && session.role !== 'admin') {
        throw new ApiError(403, 'Only owners and admins manage the team');
      }
      return session;
    };
    /** Owners grant and take away ownership; admins manage everyone else. */
    const assertMayAssign = (session: AuthSession, role: ServerRole) => {
      if (role === 'owner' && session.role !== 'owner') throw new ApiError(403, 'Only an owner can make someone an owner');
    };
    const audit = async (session: AuthSession, action: string, entityId: string, before: unknown, after: unknown) => {
      const mutation = createMutationContext(session, action);
      await createPostgresBillingDependencies(requireDatabase(app)).auditLog.append(session.scope, {
        occurredAt: new Date().toISOString(),
        action,
        reason: mutation.reason,
        actor: mutation.actor,
        subject: { entityType: 'membership', entityId, tenantId: session.scope.tenantId },
        change: { before, after },
      });
    };

    typedRoute(app, {
      method: 'GET',
      url: `${prefix}/team`,
      response: teamSchema,
      async handler({ request }) {
        const session = await manager(request);
        return access().listMembers(session.scope.tenantId);
      },
    });

    typedRoute(app, {
      method: 'POST',
      url: `${prefix}/team/invitations`,
      body: z.object({ email: z.string().email(), role: serverRoleSchema }),
      response: teamInviteResultSchema,
      async handler({ request, body }) {
        const session = await manager(request);
        assertMayAssign(session, body.role);
        const created = await access().invite(session.scope.tenantId, { email: body.email, role: body.role, invitedByUserId: session.user.id });
        const inviteUrl = linkFor(created.product, 'invite', created.token);
        const mail = renderPlatformMail({
          greeting: 'Hallo,',
          body: `${session.user.fullName} lädt dich in den Billme-Workspace „${created.workspaceName}“ ein (Rolle: ${ROLE_LABELS[body.role]}). Die Einladung gilt sieben Tage.`,
          action: 'Einladung annehmen',
          url: inviteUrl,
          footer: `Du kennst ${session.user.fullName} nicht? Dann ignoriere diese Mail.`,
        });
        const sent = await options.mailer({ to: created.invitation.email, subject: `Einladung zu ${created.workspaceName} in Billme`, ...mail, idempotencyKey: `invite-${created.invitation.id}` });
        if (!sent.sent) app.log.warn({ error: sent.error }, 'Invitation mail was not sent');
        await audit(session, 'team.invite', created.invitation.id, null, { email: created.invitation.email, role: body.role });
        return { invitation: created.invitation, inviteUrl, mailSent: sent.sent };
      },
    });

    typedRoute(app, {
      method: 'DELETE',
      url: `${prefix}/team/invitations/:id`,
      params: z.object({ id: z.string().min(1) }),
      response: okSchema,
      async handler({ request, params }) {
        const session = await manager(request);
        await access().revokeInvitation(session.scope.tenantId, params.id);
        await audit(session, 'team.invitation_revoked', params.id, null, null);
        return { ok: true as const };
      },
    });

    typedRoute(app, {
      method: 'PUT',
      url: `${prefix}/team/members/:userId`,
      params: z.object({ userId: z.string().min(1) }),
      body: z.object({ role: serverRoleSchema }),
      response: okSchema,
      async handler({ request, params, body }) {
        const session = await manager(request);
        const before = await access().roleOf(session.scope.tenantId, params.userId);
        if (!before) throw new ApiError(404, 'Member not found');
        assertMayAssign(session, body.role);
        if (before === 'owner') assertMayAssign(session, before);
        await access().changeRole(session.scope.tenantId, params.userId, body.role);
        await audit(session, 'team.role_changed', params.userId, { role: before }, { role: body.role });
        return { ok: true as const };
      },
    });

    typedRoute(app, {
      method: 'DELETE',
      url: `${prefix}/team/members/:userId`,
      params: z.object({ userId: z.string().min(1) }),
      response: okSchema,
      async handler({ request, params }) {
        const self = await requireSession(app, product, request.headers.authorization);
        // Anyone may leave; removing someone else needs an owner or admin, and only owners remove owners.
        const session = params.userId === self.user.id ? self : await manager(request);
        const before = await access().roleOf(session.scope.tenantId, params.userId);
        if (!before) throw new ApiError(404, 'Member not found');
        if (params.userId !== self.user.id && before === 'owner') assertMayAssign(session, before);
        await access().removeMember(session.scope.tenantId, params.userId);
        await audit(session, 'team.member_removed', params.userId, { role: before }, null);
        return { ok: true as const };
      },
    });
  }
};
