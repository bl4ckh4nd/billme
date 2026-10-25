import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { ApiError } from './http.js';
import { SessionTokenService, type AuthSession } from './auth.js';
import type { AuthStore } from './authStore.js';
import type { ServerDatabase } from '@billme/server-data';
import type { ServerRole } from '@billme/server-core';

export type RuntimeProfile = 'server' | 'embedded';
export type Product = 'lite' | 'pro';

export type MutationActor = {
  readonly type: 'user';
  readonly id: string;
  readonly displayName: string;
};

export type MutationContext = {
  readonly reason: string;
  readonly actor: MutationActor;
};

export class AuthorizationError extends Error {
  constructor(
    readonly code: 'missing_token' | 'invalid_token' | 'product_scope' | 'role_forbidden' | 'database_unavailable',
    message: string,
    readonly statusCode: 401 | 403 | 503,
  ) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export interface AuthorizationInput {
  readonly runtime: RuntimeProfile;
  readonly database?: ServerDatabase;
  readonly product: Product;
  readonly authHeader?: string;
  readonly tokenService: SessionTokenService;
  readonly localAccessTokenSecret?: string;
  readonly localSession?: AuthSession;
}

export const safeSecretEqual = (provided: string, expected: string): boolean => {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
};

/** Writes made through a CLI token stay attributable to it; the label comes from the token row, not the client. */
export const toMutationActor = (session: AuthSession): MutationActor => ({
  type: 'user',
  id: session.user.id,
  displayName: session.via ? `${session.user.fullName} (CLI: ${session.via.label})` : session.user.fullName,
});

/** Canonical audit actor and reason policy for every mutating adapter. */
export const createMutationContext = (session: AuthSession, reason: string): MutationContext => {
  const normalizedReason = reason.trim();
  if (!normalizedReason) {
    throw new ApiError(400, 'Mutation reason is required');
  }
  return {
    reason: normalizedReason,
    actor: toMutationActor(session),
  };
};

/** Shared hosted/embedded session, product and stable feedback policy. */
export function authorizeRequest(input: AuthorizationInput & { runtime: 'embedded' }): AuthSession;
export function authorizeRequest(input: AuthorizationInput): AuthSession | Promise<AuthSession>;
export function authorizeRequest(input: AuthorizationInput): AuthSession | Promise<AuthSession> {
  const token = input.tokenService.readBearerToken(input.authHeader);
  if (input.runtime === 'embedded') {
    if (!token) {
      throw new AuthorizationError('missing_token', 'Missing or invalid local access token', 401);
    }
    if (!input.localAccessTokenSecret || !safeSecretEqual(token, input.localAccessTokenSecret)) {
      // The only other credential the embedded runtime knows is a CLI token, which the request
      // hook has already exchanged for a session signed with this process's secret.
      let cliSession: AuthSession | null;
      try {
        cliSession = input.tokenService.verify(token);
      } catch {
        cliSession = null;
      }
      if (!cliSession?.via) {
        throw new AuthorizationError('invalid_token', 'Missing or invalid local access token', 401);
      }
      if (cliSession.scope.product !== input.product) {
        throw new AuthorizationError('product_scope', `Token is not authorized for ${input.product}`, 403);
      }
      return cliSession;
    }
    if (!input.localSession) {
      throw new AuthorizationError('invalid_token', 'Embedded local session is not configured', 503);
    }
    if (input.localSession.scope.product !== input.product) {
      throw new AuthorizationError('product_scope', `Token is not authorized for ${input.product}`, 403);
    }
    return input.localSession;
  }

  if (!token) {
    throw new AuthorizationError('missing_token', 'Missing bearer token', 401);
  }
  let session: AuthSession | null;
  try {
    session = input.tokenService.verify(token);
  } catch {
    session = null;
  }
  if (!session) {
    throw new AuthorizationError('invalid_token', 'Invalid or expired bearer token', 401);
  }
  if (session.scope.product !== input.product) {
    throw new AuthorizationError('product_scope', `Token is not authorized for ${input.product}`, 403);
  }
  if (!input.database) return session;
  const verified = session;
  return input.database.query<{ role: ServerRole; email: string; full_name: string }>(
    "SELECT m.role, u.email, u.full_name FROM tenant_memberships m JOIN user_accounts u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND t.product=$3 AND u.status='active' AND t.status='active'",
    [session.scope.tenantId, session.user.id, input.product],
  ).then(({ rows }) => {
    const member = rows[0];
    if (!member) throw new AuthorizationError('invalid_token', 'Die Mitgliedschaft ist nicht mehr aktiv.', 401);
    // A read-only CLI credential must never gain the membership's write role.
    const role = verified.via && verified.role === 'viewer' ? 'viewer' : member.role;
    return { ...verified, role, user: { ...verified.user, role, email: member.email, fullName: member.full_name } };
  });
}

/** Guard API-wide embedded requests before a route-specific handler runs. */
export const authorizeEmbeddedRequest = (
  app: FastifyInstance,
  product: Product,
  localToken: string | undefined,
): AuthSession => {
  try {
    return authorizeRequest({
      runtime: 'embedded',
      product,
      authHeader: typeof localToken === 'string' ? `Bearer ${localToken}` : undefined,
      tokenService: app.tokenService,
      localAccessTokenSecret: app.localAccessTokenSecret,
      localSession: app.localSession,
    });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      throw new ApiError(error.statusCode, error.message);
    }
    throw error;
  }
};

/**
 * Apply the shared mutation capability policy after authentication and
 * product-scope checks. Keeping this separate makes non-HTTP adapters (such
 * as oRPC and the worker) use the exact same role matrix and feedback.
 */
/** Shown as it is in the browser and the CLI, so it is German and says what the role may do. */
const ROLE_REFUSAL_MESSAGE = 'Dafür fehlt dir die Berechtigung: Mit Lesezugriff kannst du alles ansehen, aber nichts ändern. Änderungen machen Inhaber, Admins oder die Buchhaltung des Workspace.';

export const requireMutationCapability = (session: AuthSession, message = ROLE_REFUSAL_MESSAGE): AuthSession => {
  const allowed: ServerRole[] = ['owner', 'admin', 'accountant'];
  if (!allowed.includes(session.role)) {
    throw new AuthorizationError('role_forbidden', message, 403);
  }
  return session;
};

declare module 'fastify' {
  interface FastifyInstance {
    authStore: AuthStore;
    tokenService: SessionTokenService;
    serverPool?: Pool;
    serverDatabase?: ServerDatabase;
    runtimeProfile: RuntimeProfile;
    runtimeProduct?: Product;
    localAccessTokenSecret?: string;
    localSession?: AuthSession;
  }
}

export const requireSession = async (
  app: FastifyInstance,
  product: Product,
  authHeader: string | undefined,
): Promise<AuthSession> => {
  try {
    return await authorizeRequest({
      runtime: app.runtimeProfile,
      database: app.serverDatabase,
      product,
      authHeader,
      tokenService: app.tokenService,
      localAccessTokenSecret: app.localAccessTokenSecret,
      localSession: app.localSession,
    });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      throw new ApiError(error.statusCode, error.message);
    }
    throw error;
  }
};

export const requireMutationSession = async (
  app: FastifyInstance,
  authHeader: string | undefined,
): Promise<AuthSession> => requireMutationCapability(await requireSession(app, 'pro', authHeader));

export const requireMutationSessionFor = async (
  app: FastifyInstance,
  product: Product,
  authHeader: string | undefined,
  message = ROLE_REFUSAL_MESSAGE,
): Promise<AuthSession> => {
  try {
    return requireMutationCapability(await requireSession(app, product, authHeader), message);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      throw new ApiError(error.statusCode, error.message);
    }
    throw error;
  }
};

/** Tax audit exports additionally recognize the legacy auditor role. */
export const requireAuditExportSession = async (
  app: FastifyInstance,
  product: Product,
  authHeader: string | undefined,
): Promise<AuthSession> => {
  const session = await requireSession(app, product, authHeader);
  const allowed = new Set<ServerRole | 'auditor'>(['owner', 'admin', 'accountant', 'auditor']);
  if (!allowed.has(session.role)) {
    throw new ApiError(403, 'Tax audit export requires an authorized accounting role');
  }
  return session;
};

export const requireAutomationMutationSession = async (
  sessionFor: (authorization: string | undefined) => Promise<AuthSession>,
  authorization: string | undefined,
): Promise<AuthSession> => {
  try {
    return requireMutationCapability(
      await sessionFor(authorization),
      'Diese Aktion benötigt die Rolle owner, admin oder accountant.',
    );
  } catch (error) {
    if (error instanceof AuthorizationError) {
      throw new ApiError(error.statusCode, error.message);
    }
    throw error;
  }
};

/** Every route receives the persistence seam, never a raw Pool or PGlite client. */
export const requireDatabase = (app: FastifyInstance): ServerDatabase => {
  if (app.serverDatabase) return app.serverDatabase;
  throw new ApiError(503, 'DATABASE_URL is required for server routes');
};

/** Compatibility export for old composition roots; route modules use requireDatabase. */
export const requirePool = requireDatabase;
