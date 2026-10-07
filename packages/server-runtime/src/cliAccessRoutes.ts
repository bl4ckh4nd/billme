import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CLI_TOKEN_PREFIX,
  cliAccessRequestSchema,
  cliTokenSummarySchema,
  createSingleTenantScope,
  deviceLoginStartRequestSchema,
  deviceLoginStartResponseSchema,
  deviceLoginTokenResponseSchema,
  type CliTokenScope,
  type ServerProduct,
} from '@billme/server-core';
import {
  createServerCliToken,
  listServerCliTokens,
  resolveServerCliToken,
  revokeServerCliToken,
} from '@billme/server-data';
import type { AuthSession } from './auth.js';
import { ApiError, typedRoute } from './http.js';
import { requireDatabase, requireSession } from './runtimeContext.js';

const DEVICE_START_PATH = '/api/v1/auth/device/start';
const DEVICE_TOKEN_PATH = '/api/v1/auth/device/token';
const REVOKE_SELF_SUFFIX = '/cli-access/revoke-self';

const REQUEST_TTL_MS = 10 * 60_000;
const POLL_INTERVAL_SECONDS = 3;
const MIN_POLL_GAP_MS = 1_000;
const MAX_PENDING_REQUESTS = 50;
const STARTS_PER_MINUTE = 10;
/** A CLI token is exchanged for a session this short-lived on every request; see `authenticateCliToken`. */
const CLI_SESSION_TTL_SECONDS = 30;

// No 0/O, 1/I: the code is read off a terminal and typed into the app.
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

type PendingRequest = {
  userCode: string;
  product: ServerProduct;
  label: string;
  scope: CliTokenScope;
  createdAt: number;
  lastPollAt: number;
  decision?: { approved: false } | { approved: true; tenantId: string; userId: string };
};

const okSchema = z.object({ ok: z.literal(true) });

const hashDeviceCode = (deviceCode: string): string => createHash('sha256').update(deviceCode).digest('hex');

const normalizeUserCode = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9]/g, '');

const pathOf = (url: string): string => url.split('?')[0] ?? url;

/** The two endpoints a not-yet-authenticated CLI calls; every other `/api/` route needs a token. */
export const isDeviceLoginPath = (url: string): boolean => {
  const path = pathOf(url);
  return path === DEVICE_START_PATH || path === DEVICE_TOKEN_PATH;
};

/**
 * Turns a CLI token into the session its user holds right now. The bearer
 * header is replaced by a short-lived signed session, the same way the embedded
 * runtime swaps in its local token, so route handlers keep a single auth path.
 * Returns false when the request carries no CLI token.
 */
export const authenticateCliToken = async (app: FastifyInstance, request: FastifyRequest): Promise<boolean> => {
  const bearer = app.tokenService.readBearerToken(request.headers.authorization);
  if (!bearer?.startsWith(CLI_TOKEN_PREFIX)) return false;

  const resolved = app.serverDatabase ? await resolveServerCliToken(app.serverDatabase, bearer) : null;
  if (!resolved) {
    throw new ApiError(401, 'Invalid or revoked CLI token');
  }
  const isRead = ['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  if (resolved.scope === 'read' && !isRead && !pathOf(request.url).endsWith(REVOKE_SELF_SUFFIX)) {
    throw new ApiError(403, 'This CLI token is read-only');
  }

  const session: AuthSession = {
    user: resolved.user,
    scope: createSingleTenantScope(resolved.tenantId, resolved.product),
    role: resolved.user.role,
    via: { tokenId: resolved.id, label: resolved.label },
  };
  request.headers.authorization = `Bearer ${app.tokenService.sign(session, CLI_SESSION_TTL_SECONDS)}`;
  return true;
};

const verificationUri = (product: ServerProduct, userCode: string): string | undefined => {
  const webUrl = (product === 'pro' ? process.env.BILLME_PUBLIC_WEB_PRO_URL : process.env.BILLME_PUBLIC_WEB_URL)?.trim();
  return webUrl ? `${webUrl.replace(/\/+$/, '')}/#/settings?cliCode=${userCode}` : undefined;
};

export const registerCliAccessRoutes = (app: FastifyInstance, products: readonly ServerProduct[]) => {
  // ponytail: login requests live in this process only. Move them to a table once the API runs on more than one instance.
  const pending = new Map<string, PendingRequest>();
  const startsByAddress = new Map<string, { windowStart: number; count: number }>();

  const dropExpired = (now: number) => {
    for (const [key, entry] of pending) {
      if (now - entry.createdAt > REQUEST_TTL_MS) pending.delete(key);
    }
    for (const [address, window] of startsByAddress) {
      if (now - window.windowStart > 60_000) startsByAddress.delete(address);
    }
  };

  // These endpoints are for a CLI. Browsers send `Origin` on cross-site POSTs, and with CORS open
  // (`origin: true`) any web page could otherwise start login requests against a local app.
  const rejectBrowsers = (request: FastifyRequest) => {
    if (request.headers.origin) {
      throw new ApiError(403, 'Device login is not available from a browser');
    }
  };

  const limitStarts = (request: FastifyRequest, now: number) => {
    const window = startsByAddress.get(request.ip);
    if (!window || now - window.windowStart > 60_000) {
      startsByAddress.set(request.ip, { windowStart: now, count: 1 });
      return;
    }
    window.count += 1;
    if (window.count > STARTS_PER_MINUTE) {
      throw new ApiError(429, 'Too many login requests, try again in a minute');
    }
  };

  const findByUserCode = (product: ServerProduct, code: string): PendingRequest | undefined => {
    const userCode = normalizeUserCode(code);
    dropExpired(Date.now());
    return [...pending.values()].find((entry) => entry.userCode === userCode && entry.product === product && !entry.decision);
  };

  typedRoute(app, {
    method: 'POST',
    url: DEVICE_START_PATH,
    body: deviceLoginStartRequestSchema,
    response: deviceLoginStartResponseSchema,
    async handler({ request, body }) {
      rejectBrowsers(request);
      if (!products.includes(body.product)) {
        throw new ApiError(400, `This instance does not serve ${body.product}`);
      }
      requireDatabase(app);
      const now = Date.now();
      limitStarts(request, now);
      dropExpired(now);
      if (pending.size >= MAX_PENDING_REQUESTS) {
        throw new ApiError(429, 'Too many open login requests');
      }

      const deviceCode = randomBytes(32).toString('base64url');
      const userCode = Array.from({ length: 8 }, () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]).join('');
      pending.set(hashDeviceCode(deviceCode), {
        userCode,
        product: body.product,
        label: body.label,
        scope: body.scope,
        createdAt: now,
        lastPollAt: 0,
      });

      const uri = app.runtimeProfile === 'server' ? verificationUri(body.product, userCode) : undefined;
      return {
        deviceCode,
        userCode: `${userCode.slice(0, 4)}-${userCode.slice(4)}`,
        ...(uri ? { verificationUri: uri } : {}),
        expiresIn: REQUEST_TTL_MS / 1000,
        interval: POLL_INTERVAL_SECONDS,
      };
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: DEVICE_TOKEN_PATH,
    body: z.object({ deviceCode: z.string().min(1) }),
    response: deviceLoginTokenResponseSchema,
    async handler({ request, body }) {
      rejectBrowsers(request);
      const now = Date.now();
      dropExpired(now);
      const key = hashDeviceCode(body.deviceCode);
      const entry = pending.get(key);
      if (!entry) return { status: 'expired' as const };
      if (now - entry.lastPollAt < MIN_POLL_GAP_MS) {
        throw new ApiError(429, 'Polling too fast');
      }
      entry.lastPollAt = now;
      if (!entry.decision) return { status: 'pending' as const };

      // One answer per request: whatever was decided, the device code is spent.
      pending.delete(key);
      if (!entry.decision.approved) return { status: 'denied' as const };

      const database = requireDatabase(app);
      const { token } = await createServerCliToken(
        database,
        { tenantId: entry.decision.tenantId, userId: entry.decision.userId, product: entry.product },
        { label: entry.label, scope: entry.scope },
      );
      const resolved = await resolveServerCliToken(database, token);
      if (!resolved) {
        throw new ApiError(409, 'The approving user is no longer active');
      }
      return { status: 'approved' as const, token, user: resolved.user };
    },
  });

  for (const product of products) {
    const prefix = `/api/v1/${product}`;
    const ownerOf = (session: AuthSession) => ({ tenantId: session.scope.tenantId, userId: session.user.id, product });

    // Approving, listing and revoking need a person at the app: a CLI token must not mint or manage tokens.
    const requireInteractiveSession = async (request: FastifyRequest): Promise<AuthSession> => {
      const session = await requireSession(app, product, request.headers.authorization);
      if (session.via) {
        throw new ApiError(403, 'CLI access is managed in the app, not with a CLI token');
      }
      return session;
    };

    typedRoute(app, {
      method: 'GET',
      url: `${prefix}/cli-access/pending`,
      query: z.object({ code: z.string().min(1) }),
      response: cliAccessRequestSchema.nullable(),
      async handler({ request, query }) {
        await requireInteractiveSession(request);
        const entry = findByUserCode(product, query.code);
        return entry
          ? { userCode: entry.userCode, label: entry.label, scope: entry.scope, createdAt: new Date(entry.createdAt).toISOString() }
          : null;
      },
    });

    typedRoute(app, {
      method: 'POST',
      url: `${prefix}/cli-access/decide`,
      body: z.object({ code: z.string().min(1), approve: z.boolean() }),
      response: okSchema,
      async handler({ request, body }) {
        const session = await requireInteractiveSession(request);
        const entry = findByUserCode(product, body.code);
        if (!entry) {
          throw new ApiError(404, 'Unknown or expired code');
        }
        entry.decision = body.approve
          ? { approved: true, tenantId: session.scope.tenantId, userId: session.user.id }
          : { approved: false };
        return { ok: true as const };
      },
    });

    typedRoute(app, {
      method: 'GET',
      url: `${prefix}/cli-access/tokens`,
      response: z.array(cliTokenSummarySchema),
      async handler({ request }) {
        const session = await requireInteractiveSession(request);
        return listServerCliTokens(requireDatabase(app), ownerOf(session));
      },
    });

    typedRoute(app, {
      method: 'DELETE',
      url: `${prefix}/cli-access/tokens/:id`,
      params: z.object({ id: z.string().min(1) }),
      response: okSchema,
      async handler({ request, params }) {
        const session = await requireInteractiveSession(request);
        if (!await revokeServerCliToken(requireDatabase(app), ownerOf(session), params.id)) {
          throw new ApiError(404, 'Unknown CLI token');
        }
        return { ok: true as const };
      },
    });

    typedRoute(app, {
      method: 'POST',
      url: `${prefix}${REVOKE_SELF_SUFFIX}`,
      response: okSchema,
      async handler({ request }) {
        const session = await requireSession(app, product, request.headers.authorization);
        if (!session.via) {
          throw new ApiError(400, 'Only a CLI token can revoke itself');
        }
        await revokeServerCliToken(requireDatabase(app), ownerOf(session), session.via.tokenId);
        return { ok: true as const };
      },
    });
  }
};
