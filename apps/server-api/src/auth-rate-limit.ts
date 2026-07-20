import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from './http.js';

type Limit = { max: number; windowMs: number };

const limits: Record<string, Limit> = {
  login: { max: 5, windowMs: 15 * 60_000 },
  bootstrap: { max: 3, windowMs: 60 * 60_000 },
};

const limitFor = (request: FastifyRequest): { name: 'login' | 'bootstrap'; limit: Limit } | null => {
  const path = new URL(request.raw.url ?? '/', 'http://localhost').pathname;
  if (path.endsWith('/auth/login')) return { name: 'login', limit: limits.login };
  if (path.endsWith('/auth/bootstrap')) return { name: 'bootstrap', limit: limits.bootstrap };
  return null;
};

export const registerAuthRateLimit = (app: FastifyInstance): void => {
  const attempts = new Map<string, { count: number; resetAt: number }>();

  app.addHook('onRequest', async (request) => {
    const policy = limitFor(request);
    if (!policy) return;

    // ponytail: process-local limiter; use a shared store if the API is scaled horizontally.
    const now = Date.now();
    const key = `${request.ip}:${policy.name}`;
    const current = attempts.get(key);
    if (!current || current.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + policy.limit.windowMs });
      return;
    }
    if (current.count >= policy.limit.max) {
      throw new ApiError(429, 'Too many authentication attempts. Try again later.');
    }
    current.count += 1;
  });
};
