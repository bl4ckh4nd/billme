import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { authUserSchema, serverProductSchema, serverRoleSchema, type TenantScope } from '@billme/server-core';

const authSessionSchema = z.object({
  user: authUserSchema,
  scope: z.object({
    tenantId: z.string().min(1),
    product: serverProductSchema,
    deploymentMode: z.literal('single-tenant'),
  }),
  role: serverRoleSchema,
});

const tokenPayloadSchema = authSessionSchema.extend({
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
});

export type AuthSession = z.infer<typeof authSessionSchema>;
export type AuthSessionInfo = {
  user: z.infer<typeof authUserSchema>;
  tenantId: string;
  product: z.infer<typeof serverProductSchema>;
  role: z.infer<typeof serverRoleSchema>;
};

const encodeBase64Url = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');
const decodeBase64Url = (value: string): string => Buffer.from(value, 'base64url').toString('utf8');

export const DEV_SESSION_SECRET = 'billme-dev-session-secret';
export const MIN_SESSION_SECRET_LENGTH = 32;

export type SessionSecretVerdict =
  | { ok: true; warning?: string }
  | { ok: false; error: string };

/**
 * A session token is only as trustworthy as its signing secret. The constructor
 * default keeps `pnpm dev` frictionless, but any deployment that talks to a real
 * database must not silently sign tokens with a secret that is published in this
 * repository — anyone could forge a session.
 */
export const checkSessionSecret = (
  env: Record<string, string | undefined> = process.env,
): SessionSecretVerdict => {
  const secret = env.SESSION_SECRET?.trim() ?? '';
  const isDeployed = env.NODE_ENV === 'production' || Boolean(env.DATABASE_URL?.trim());

  let problem: string | undefined;
  if (!secret) problem = 'SESSION_SECRET is not set';
  else if (secret === DEV_SESSION_SECRET) problem = 'SESSION_SECRET is still the built-in development value';
  else if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    problem = `SESSION_SECRET is shorter than ${MIN_SESSION_SECRET_LENGTH} characters`;
  }

  if (!problem) return { ok: true };
  if (!isDeployed) return { ok: true, warning: `${problem}. Fine for local development, never for a deployment.` };

  return {
    ok: false,
    error:
      `${problem}. Refusing to start: session tokens would be forgeable. ` +
      `Set SESSION_SECRET to at least ${MIN_SESSION_SECRET_LENGTH} random characters ` +
      `(for example: openssl rand -hex 32).`,
  };
};

export class SessionTokenService {
  private readonly secret: string;

  constructor(secret = process.env.SESSION_SECRET?.trim() || DEV_SESSION_SECRET) {
    this.secret = secret;
  }

  sign(session: AuthSession, ttlSeconds = 60 * 60 * 12): string {
    const now = Math.floor(Date.now() / 1000);
    const payload = encodeBase64Url(
      JSON.stringify(
        tokenPayloadSchema.parse({
          ...session,
          iat: now,
          exp: now + ttlSeconds,
        }),
      ),
    );
    const signature = createHmac('sha256', this.secret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  verify(token: string): AuthSession | null {
    const [payload, signature] = token.split('.');
    if (!payload || !signature) {
      return null;
    }

    const expected = createHmac('sha256', this.secret).update(payload).digest('base64url');
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
      return null;
    }

    const parsed = tokenPayloadSchema.safeParse(JSON.parse(decodeBase64Url(payload)));
    if (!parsed.success) {
      return null;
    }

    if (parsed.data.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }

    return authSessionSchema.parse(parsed.data);
  }

  readBearerToken(headerValue: string | undefined): string | null {
    if (!headerValue) {
      return null;
    }
    const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
    return match?.[1] ?? null;
  }
}
