import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLocalAgentBridge, readLocalAgentEndpoint } from './bridge.js';

test('local bridge authenticates and invokes a typed read action', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'billme-agent-'));
  const bridge = await startLocalAgentBridge({
    userDataPath,
    product: 'lite',
    invoke: async ({ action, args }) => {
      assert.equal(action, 'settings:get');
      assert.equal(args, undefined);
      return null;
    },
  });

  try {
    const endpoint = await readLocalAgentEndpoint(bridge.endpointPath);
    const unauthorized = await fetch(`${endpoint.baseUrl}/actions`, {
      headers: { authorization: 'Bearer invalid' },
    });
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${endpoint.baseUrl}/actions/settings%3Aget`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ args: undefined }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { data: unknown; status: string };
    assert.equal(payload.status, 'completed');
    assert.equal(payload.data, null);
  } finally {
    await bridge.stop();
  }
});
