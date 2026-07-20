import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresAgentToken, verifyPostgresAgentToken } from './agentTokens.js';

test('agent token creation stores only a hash and returns the token once', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      return { rowCount: 1, rows: [] };
    },
  } as never;

  const result = await createPostgresAgentToken(pool, {
    tenantId: 'tenant-1',
    userId: 'user-1',
    product: 'lite',
    label: 'Invoice agent',
    scopes: ['read', 'clients:write'],
  });

  assert.match(result.token, /^billme_agent_/);
  assert.deepEqual(result.agent.scopes, ['read', 'clients:write']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.params.includes(result.token), false);
  assert.equal(String(calls[0]?.params[5]).length, 64);
});

test('agent token verification is product-bound and reconstructs the tenant session', async () => {
  const token = 'billme_agent_test';
  const pool = {
    async query(sql: string) {
      if (sql.includes('FROM agent_tokens token')) {
        return {
          rowCount: 1,
          rows: [{
            id: 'agent-1',
            tenant_id: 'tenant-1',
            user_id: 'user-1',
            product: 'pro',
            label: 'Pro agent',
            scopes_json: '["read","accounting:write"]',
            created_at: '2026-07-11T00:00:00.000Z',
            revoked_at: null,
            email: 'owner@example.com',
            full_name: 'Owner',
            role: 'owner',
            deployment_mode: 'single-tenant',
          }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
  } as never;

  const verified = await verifyPostgresAgentToken(pool, token, 'pro');
  assert.equal(verified?.tenantId, 'tenant-1');
  assert.deepEqual(verified?.scopes, ['read', 'accounting:write']);
  assert.equal(verified?.role, 'owner');
});
