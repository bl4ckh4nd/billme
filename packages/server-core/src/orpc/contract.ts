import { oc } from '@orpc/contract';
import {
  authResponseSchema,
  authSessionInfoSchema,
  bootstrapRequestSchema,
  bootstrapStatusSchema,
  capabilitiesResponseSchema,
  healthResponseSchema,
  loginRequestSchema,
  vatValidationRequestSchema,
} from '../api-schemas.js';
import { z } from 'zod';
import { serverProductSchema } from '../shared/runtime-profile.js';
import { vatValidationResultSchema } from '../services/vatValidation.js';

const productAuthQuerySchema = z.object({
  product: serverProductSchema.default('lite'),
});

const productAuthContract = (product: 'lite' | 'pro') => ({
  auth: {
    bootstrapStatus: oc
      .output(bootstrapStatusSchema)
      .route({
        method: 'GET',
        path: `/api/v1/${product}/auth/bootstrap/status`,
        operationId: `${product}AuthBootstrapStatus`,
        summary: `${product} bootstrap status`,
        tags: ['auth', product],
      }),
    bootstrap: oc
      .input(bootstrapRequestSchema)
      .output(authResponseSchema)
      .route({
        method: 'POST',
        path: `/api/v1/${product}/auth/bootstrap`,
        operationId: `${product}AuthBootstrap`,
        summary: `Bootstrap ${product} authentication`,
        tags: ['auth', product],
      }),
    login: oc
      .input(loginRequestSchema)
      .output(authResponseSchema)
      .route({
        method: 'POST',
        path: `/api/v1/${product}/auth/login`,
        operationId: `${product}AuthLogin`,
        summary: `Login to ${product}`,
        tags: ['auth', product],
      }),
    me: oc
      .output(authSessionInfoSchema)
      .route({
        method: 'GET',
        path: `/api/v1/${product}/auth/me`,
        operationId: `${product}AuthMe`,
        summary: `Current ${product} session`,
        tags: ['auth', product],
      }),
  },
  tax: {
    validateVatId: oc
      .input(vatValidationRequestSchema)
      .output(vatValidationResultSchema)
      .route({
        method: 'POST',
        path: `/api/v1/${product}/tax/validate-vat-id`,
        operationId: `${product}ValidateVatId`,
        summary: `Validate a ${product} VAT ID`,
        tags: ['tax', product],
      }),
  },
});

const genericAuthContract = {
  bootstrapStatus: oc
    .input(productAuthQuerySchema)
    .output(bootstrapStatusSchema)
    .route({
      method: 'GET',
      path: '/api/v1/auth/bootstrap/status',
      operationId: 'authBootstrapStatus',
      summary: 'Bootstrap status',
      tags: ['auth'],
    }),
  bootstrap: oc
    .input(
      z.object({
        query: productAuthQuerySchema,
        body: bootstrapRequestSchema,
      }),
    )
    .output(authResponseSchema)
    .route({
      method: 'POST',
      path: '/api/v1/auth/bootstrap',
      inputStructure: 'detailed',
      operationId: 'authBootstrap',
      summary: 'Bootstrap authentication',
      tags: ['auth'],
    }),
  login: oc
    .input(
      z.object({
        query: productAuthQuerySchema,
        body: loginRequestSchema,
      }),
    )
    .output(authResponseSchema)
    .route({
      method: 'POST',
      path: '/api/v1/auth/login',
      inputStructure: 'detailed',
      operationId: 'authLogin',
      summary: 'Login',
      tags: ['auth'],
    }),
  me: oc
    .input(productAuthQuerySchema)
    .output(authSessionInfoSchema)
    .route({
      method: 'GET',
      path: '/api/v1/auth/me',
      operationId: 'authMe',
      summary: 'Current session',
      tags: ['auth'],
    }),
};

export const serverApiContract = {
  lite: productAuthContract('lite'),
  pro: productAuthContract('pro'),
  auth: genericAuthContract,
  meta: {
    capabilities: oc
      .output(capabilitiesResponseSchema)
      .route({
        method: 'GET',
        path: '/api/v1/meta/capabilities',
        operationId: 'metaCapabilities',
        summary: 'Server capabilities',
        tags: ['meta'],
      }),
  },
  health: oc
    .output(healthResponseSchema)
    .route({
      method: 'GET',
      path: '/health',
      operationId: 'health',
      summary: 'Server health',
      tags: ['meta'],
    }),
} as const;

export type ServerApiContract = typeof serverApiContract;
