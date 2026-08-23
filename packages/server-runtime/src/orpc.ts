import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { OpenAPIHandler } from '@orpc/openapi/fastify';
import { OpenAPIGenerator } from '@orpc/openapi';
import { implement, ORPCError } from '@orpc/server';
import { ZodToJsonSchemaConverter } from '@orpc/zod';
import {
  serverApiContract,
} from '@billme/server-core/orpc';
import {
  createSingleTenantScope,
  validateVatId,
  type AuthSessionInfo,
  type ServerProduct,
} from '@billme/server-core';
import { ApiError } from './http.js';
import { type AuthStore } from './authStore.js';
import { SessionTokenService, type AuthSession } from './auth.js';

type OrpcContext = {
  request: FastifyRequest;
  authStore: AuthStore;
  tokenService: SessionTokenService;
};

const orpc = implement(serverApiContract).$context<OrpcContext>();

const toSessionInfo = (session: AuthSession): AuthSessionInfo => ({
  user: session.user,
  tenantId: session.scope.tenantId,
  product: session.scope.product,
  role: session.role,
});

const toAuthResponse = (context: OrpcContext, principal: Awaited<ReturnType<AuthStore['bootstrap']>>) => ({
  token: context.tokenService.sign({
    user: principal.user,
    scope: createSingleTenantScope(principal.tenantId, principal.product),
    role: principal.role,
  }),
  user: principal.user,
});

const mapAuthError = (error: unknown): never => {
  const message = error instanceof Error ? error.message : 'Authentication failed';
  if (message === 'Invalid email or password') {
    throw new ORPCError('UNAUTHORIZED', { message });
  }
  if (message.includes('Bootstrap already completed') || message.includes('already exists')) {
    throw new ORPCError('CONFLICT', { status: 409, message });
  }
  throw error;
};

const runAuth = async <T>(action: () => Promise<T> | T): Promise<T> => {
  try {
    return await action();
  } catch (error) {
    return mapAuthError(error);
  }
};

const requireSession = (context: OrpcContext, product: ServerProduct): AuthSession => {
  const token = context.tokenService.readBearerToken(context.request.headers.authorization);
  if (!token) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Missing bearer token' });
  }
  const session = context.tokenService.verify(token);
  if (!session) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Invalid or expired bearer token' });
  }
  if (session.scope.product !== product) {
    throw new ORPCError('FORBIDDEN', { message: `Token is not authorized for ${product}` });
  }
  return session;
};

const createProductRouter = (product: 'lite' | 'pro') => {
  if (product === 'lite') {
    return {
      auth: {
        bootstrapStatus: orpc.lite.auth.bootstrapStatus.handler(({ context }) => context.authStore.getBootstrapStatus('lite')),
        bootstrap: orpc.lite.auth.bootstrap.handler(async ({ context, input }) =>
          toAuthResponse(context, await runAuth(() => context.authStore.bootstrap('lite', input))),
        ),
        login: orpc.lite.auth.login.handler(async ({ context, input }) =>
          toAuthResponse(context, await runAuth(() => context.authStore.login('lite', input))),
        ),
        me: orpc.lite.auth.me.handler(({ context }) => toSessionInfo(requireSession(context, 'lite'))),
      },
      tax: {
        validateVatId: orpc.lite.tax.validateVatId.handler(({ context, input }) => {
          requireSession(context, 'lite');
          return validateVatId(input);
        }),
      },
    };
  }
  return {
    auth: {
      bootstrapStatus: orpc.pro.auth.bootstrapStatus.handler(({ context }) => context.authStore.getBootstrapStatus('pro')),
      bootstrap: orpc.pro.auth.bootstrap.handler(async ({ context, input }) =>
        toAuthResponse(context, await runAuth(() => context.authStore.bootstrap('pro', input))),
      ),
      login: orpc.pro.auth.login.handler(async ({ context, input }) =>
        toAuthResponse(context, await runAuth(() => context.authStore.login('pro', input))),
      ),
      me: orpc.pro.auth.me.handler(({ context }) => toSessionInfo(requireSession(context, 'pro'))),
    },
    tax: {
      validateVatId: orpc.pro.tax.validateVatId.handler(({ context, input }) => {
        requireSession(context, 'pro');
        return validateVatId(input);
      }),
    },
  };
};

/** Build the product and generic implementation from the shared contract. */
export const createServerApiOrpcRouter = () => {
  const lite = createProductRouter('lite');
  const pro = createProductRouter('pro');
  const implementation = orpc.router({
    lite,
    pro,
    auth: {
      bootstrapStatus: orpc.auth.bootstrapStatus.handler(({ context, input }) =>
        context.authStore.getBootstrapStatus(input.product),
      ),
      bootstrap: orpc.auth.bootstrap.handler(async ({ context, input }) =>
        toAuthResponse(context, await runAuth(() => context.authStore.bootstrap(input.query.product, input.body))),
      ),
      login: orpc.auth.login.handler(async ({ context, input }) =>
        toAuthResponse(context, await runAuth(() => context.authStore.login(input.query.product, input.body))),
      ),
      me: orpc.auth.me.handler(({ context, input }) =>
        toSessionInfo(requireSession(context, input.product)),
      ),
    },
    meta: {
      capabilities: orpc.meta.capabilities.handler(() => ({
        backend: 'fastify' as const,
        deploymentMode: 'single-tenant' as const,
        desktopServerMode: true as const,
        database: {
          production: 'postgres' as const,
          local: 'sqlite' as const,
        },
        auth: {
          multiUser: true as const,
          roles: ['owner', 'admin', 'accountant', 'sales', 'viewer'] as const,
        },
        products: ['lite', 'pro'] as const,
      })),
    },
    health: orpc.health.handler(() => ({
      ok: true as const,
      service: 'billme-server-api',
      backend: 'fastify' as const,
      mode: 'api' as const,
      ts: new Date().toISOString(),
    })),
  });
  return implementation;
};

export type ServerApiOrpcRouter = ReturnType<typeof createServerApiOrpcRouter>;

export const createServerApiOrpcHandler = () =>
  new OpenAPIHandler(createServerApiOrpcRouter());

export const createServerApiOpenApiDocument = async () => {
  const generator = new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
  });
  return generator.generate(serverApiContract, {
    info: {
      title: 'Billme Server API',
      version: '1.0.0',
      description: 'Stable Lite and Pro server-mode API contract.',
    },
    servers: [{ url: '/' }],
  });
};

export const registerServerApiOrpc = async (app: FastifyInstance) => {
  const handler = createServerApiOrpcHandler();
  const context = {
    authStore: app.authStore,
    tokenService: app.tokenService,
  };

  const handle = async (request: FastifyRequest, reply: FastifyReply) => {
    const result = await handler.handle(request as never, reply as never, {
      context: {
        ...context,
        request,
      },
    });
    if (!result.matched && !reply.sent) {
      throw new ApiError(404, 'No API procedure matched');
    }
  };

  // Product-prefixed auth and tax routes are served by oRPC. The wildcard is
  // intentionally scoped to these route families and cannot shadow billing.
  app.all('/api/v1/lite/auth/*', handle);
  app.all('/api/v1/lite/tax/*', handle);
  app.all('/api/v1/pro/auth/*', handle);
  app.all('/api/v1/pro/tax/*', handle);
  app.get('/api/v1/openapi.json', async (_request, reply) => {
    return reply.type('application/json').send(await createServerApiOpenApiDocument());
  });
};
