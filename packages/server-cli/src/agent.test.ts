import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentClient } from './agent.js';

test('server agent client maps a typed action to the existing server API', async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  const fetchImplementation: typeof fetch = async (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return new Response(JSON.stringify([]), { status: 200 });
  };
  const client = createAgentClient({
    product: 'lite',
    target: 'server',
    server: {
      baseUrl: 'http://127.0.0.1:3100',
      token: 'agent-token',
      fetchImplementation,
    },
  });

  try {
    const result = await client.invoke({
      action: 'clients:list',
      target: 'server',
    });
    assert.equal((result as { status: string }).status, 'completed');
    assert.deepEqual((result as { data: unknown }).data, []);
    assert.deepEqual(calls, ['GET http://127.0.0.1:3100/api/v1/lite/clients']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('server agent client rejects destructive actions before network access', async () => {
  const client = createAgentClient({
    product: 'lite',
    target: 'server',
    server: { baseUrl: 'http://127.0.0.1:3100', token: 'agent-token' },
  });
  await assert.rejects(
    () => client.invoke({ action: 'clients:delete', target: 'server', args: { id: 'c1' }, reason: 'cleanup' }),
    /requires --confirm/,
  );
});
