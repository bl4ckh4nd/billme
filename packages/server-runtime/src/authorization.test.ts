import assert from 'node:assert/strict';
import test from 'node:test';
import { createSingleTenantScope } from '@billme/server-core';
import { AuthorizationError, authorizeRequest, requireMutationCapability } from './runtimeContext.js';
import { SessionTokenService } from './auth.js';

const service = new SessionTokenService('authorization-matrix-test-secret-32-chars');
const owner = {
  user: { id: 'user-1', email: 'owner@example.test', fullName: 'Owner', role: 'owner' as const },
  scope: createSingleTenantScope('tenant-1', 'lite'),
  role: 'owner' as const,
};

test('authorization matrix keeps hosted and embedded product scope explicit', () => {
  const hostedToken = service.sign(owner);
  assert.equal(authorizeRequest({
    runtime: 'server',
    product: 'lite',
    authHeader: `Bearer ${hostedToken}`,
    tokenService: service,
  }).scope.tenantId, 'tenant-1');

  assert.throws(
    () => authorizeRequest({
      runtime: 'server',
      product: 'pro',
      authHeader: `Bearer ${hostedToken}`,
      tokenService: service,
    }),
    (error: unknown) => error instanceof AuthorizationError
      && error.code === 'product_scope' && error.statusCode === 403,
  );

  assert.equal(authorizeRequest({
    runtime: 'embedded',
    product: 'lite',
    authHeader: 'Bearer local-token',
    tokenService: service,
    localAccessTokenSecret: 'local-token',
    localSession: owner,
  }), owner);

  assert.throws(
    () => authorizeRequest({
      runtime: 'embedded',
      product: 'pro',
      authHeader: 'Bearer local-token',
      tokenService: service,
      localAccessTokenSecret: 'local-token',
      localSession: owner,
    }),
    (error: unknown) => error instanceof AuthorizationError
      && error.code === 'product_scope' && error.statusCode === 403,
  );

  assert.throws(
    () => authorizeRequest({
      runtime: 'embedded',
      product: 'lite',
      authHeader: 'Bearer wrong-token',
      tokenService: service,
      localAccessTokenSecret: 'local-token',
      localSession: owner,
    }),
    (error: unknown) => error instanceof AuthorizationError
      && error.code === 'invalid_token' && error.statusCode === 401,
  );
});

test('authorization matrix keeps mutation roles and malformed tokens fail closed', () => {
  for (const role of ['sales', 'viewer'] as const) {
    const token = service.sign({ ...owner, user: { ...owner.user, role }, role });
    assert.throws(
      () => requireMutationCapability(authorizeRequest({
        runtime: 'server',
        product: 'lite',
        authHeader: `Bearer ${token}`,
        tokenService: service,
      })),
      (error: unknown) => error instanceof AuthorizationError
        && error.code === 'role_forbidden' && error.statusCode === 403,
    );
  }

  assert.throws(
    () => authorizeRequest({
      runtime: 'server',
      product: 'lite',
      authHeader: 'Bearer malformed.token',
      tokenService: service,
    }),
    (error: unknown) => error instanceof AuthorizationError
      && error.code === 'invalid_token' && error.statusCode === 401,
  );
});
