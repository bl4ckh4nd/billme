import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServerApi } from '@billme/server-runtime';
import { runCli } from './cli.js';

const makeIo = (env: NodeJS.ProcessEnv, stdinText = '', stdinIsTTY = true) => {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      env,
      stdin: {
        isTTY: stdinIsTTY,
        async *[Symbol.asyncIterator]() {
          if (stdinText) {
            yield stdinText;
          }
        },
      },
      stdout: {
        write(chunk: string) {
          stdout += chunk;
        },
      },
      stderr: {
        write(chunk: string) {
          stderr += chunk;
        },
      },
    },
    read: () => ({ stdout, stderr }),
  };
};

test('auth login stores a profile and auth me can reuse it', async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousSessionSecret = process.env.SESSION_SECRET;
  delete process.env.DATABASE_URL;
  process.env.SESSION_SECRET = 'billme-server-cli-test-secret';

  const app = await buildServerApi();
  const baseUrl = (await app.listen({ host: '127.0.0.1', port: 0 })).replace(/\/+$/, '');
  const dir = await mkdtemp(join(tmpdir(), 'billme-cli-'));
  const configPath = join(dir, 'config.json');

  try {
    const bootstrap = makeIo({ ...process.env, BILLME_CLI_CONFIG: configPath });
    const bootstrapExitCode = await runCli(
      [
        'auth',
        'bootstrap',
        '--base-url',
        baseUrl,
        '--product',
        'lite',
        '--email',
        'owner@example.com',
        '--password',
        'billme-server-123',
        '--full-name',
        'CLI Owner',
      ],
      bootstrap.io,
    );
    assert.equal(bootstrapExitCode, 0);
    const bootstrapJson = JSON.parse(bootstrap.read().stdout);
    assert.equal(bootstrapJson.user.email, 'owner@example.com');

    const me = makeIo({ ...process.env, BILLME_CLI_CONFIG: configPath });
    const meExitCode = await runCli(['auth', 'me', '--base-url', baseUrl], me.io);
    assert.equal(meExitCode, 0);
    const meJson = JSON.parse(me.read().stdout);
    assert.equal(meJson.user.email, 'owner@example.com');

    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(config.profiles.default.product, 'lite');
    assert.equal(typeof config.profiles.default.token, 'string');
  } finally {
    await app.close();
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    if (previousSessionSecret === undefined) {
      delete process.env.SESSION_SECRET;
    } else {
      process.env.SESSION_SECRET = previousSessionSecret;
    }
  }
});
