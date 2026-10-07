import { execFile } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect } from '@playwright/test';
import { Pool } from 'pg';
import { readServerHarnessState } from './harness.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const seedScriptPath = path.join(repoRoot, 'tests', 'e2e', 'server', 'seedWorkerScenario.ts');
const workerAppDir = path.join(repoRoot, 'apps', 'server-worker');
const seedScriptFromWorker = path.relative(workerAppDir, seedScriptPath);
const smtpPassword = 'worker-smtp-secret';

const randomSuffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const waitForServerListen = (server) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });

const closeServer = (server) =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

const parseMail = (raw) => {
  const [headerBlock = '', ...bodyParts] = raw.split(/\r?\n\r?\n/u);
  const headers = {};
  let currentHeader = null;

  for (const line of headerBlock.split(/\r?\n/u)) {
    if (/^\s/u.test(line) && currentHeader) {
      headers[currentHeader] = `${headers[currentHeader]} ${line.trim()}`.trim();
      continue;
    }

    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) {
      continue;
    }

    currentHeader = line.slice(0, separatorIndex).trim().toLowerCase();
    headers[currentHeader] = line.slice(separatorIndex + 1).trim();
  }

  return {
    raw,
    headers,
    subject: headers.subject ?? '',
    to: headers.to ?? '',
    from: headers.from ?? '',
    body: bodyParts.join('\n\n'),
  };
};

const createSmtpSink = async () => {
  const messages = [];
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 billme-e2e SMTP ready\r\n');

    let buffer = '';
    let authStage = null;
    let dataMode = false;
    let messageLines = [];

    const reply = (line) => socket.write(`${line}\r\n`);
    const replyMultiline = (lines) => {
      for (const [index, line] of lines.entries()) {
        const separator = index === lines.length - 1 ? ' ' : '-';
        socket.write(`250${separator}${line}\r\n`);
      }
    };

    const finishMessage = () => {
      messages.push(parseMail(messageLines.join('\n')));
      messageLines = [];
      reply(`250 2.0.0 queued as billme-${messages.length}`);
    };

    socket.on('data', (chunk) => {
      buffer += chunk;

      while (buffer.includes('\n')) {
        const newlineIndex = buffer.indexOf('\n');
        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const line = rawLine.replace(/\r$/u, '');

        if (dataMode) {
          if (line === '.') {
            dataMode = false;
            finishMessage();
          } else {
            messageLines.push(line);
          }
          continue;
        }

        if (authStage === 'username') {
          authStage = 'password';
          reply('334 UGFzc3dvcmQ6');
          continue;
        }
        if (authStage === 'password') {
          authStage = null;
          reply('235 2.7.0 Authentication successful');
          continue;
        }

        const upperLine = line.toUpperCase();
        if (upperLine.startsWith('EHLO ') || upperLine.startsWith('HELO ')) {
          replyMultiline(['billme-e2e', 'AUTH LOGIN PLAIN', '8BITMIME']);
          continue;
        }
        if (upperLine.startsWith('AUTH PLAIN')) {
          reply('235 2.7.0 Authentication successful');
          continue;
        }
        if (upperLine === 'AUTH LOGIN') {
          authStage = 'username';
          reply('334 VXNlcm5hbWU6');
          continue;
        }
        if (upperLine.startsWith('AUTH LOGIN ')) {
          authStage = 'password';
          reply('334 UGFzc3dvcmQ6');
          continue;
        }
        if (upperLine.startsWith('MAIL FROM:') || upperLine.startsWith('RCPT TO:')) {
          reply('250 2.1.0 OK');
          continue;
        }
        if (upperLine === 'DATA') {
          dataMode = true;
          reply('354 End data with <CR><LF>.<CR><LF>');
          continue;
        }
        if (upperLine === 'NOOP' || upperLine === 'RSET') {
          reply('250 OK');
          continue;
        }
        if (upperLine === 'QUIT') {
          reply('221 2.0.0 Bye');
          socket.end();
          continue;
        }

        reply('250 OK');
      }
    });
  });

  const address = await waitForServerListen(server);

  return {
    port: address.port,
    async waitForMessageCount(count, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (messages.length >= count) {
          return [...messages];
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Timed out waiting for ${count} SMTP messages. Received ${messages.length}.`);
    },
    async close() {
      await closeServer(server);
    },
  };
};

const startWorkerPortal = async (state, product) => {
  if (state.urls.portal) return { baseUrl: state.urls.portal, apiKey: state.env.BILLME_PORTAL_PUBLISH_API_KEY, close: async () => {} };
  const { register } = await import('tsx/esm/api');
  const unregister = register();
  try {
    const { startPortal } = await import('../../../packages/integration-tests/src/offer-portal-fixtures.ts');
    return await startPortal({ suite: `server-worker-${product}` });
  } finally { unregister(); }
};

const portalJson = async (portal, path, body, headers = {}) => {
  const response = await fetch(`${portal.baseUrl}${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
  });
  expect(response.ok, `Portal ${path}: ${response.status} ${await response.clone().text()}`).toBeTruthy();
  return response.json();
};

const runJsonCommand = async (command, args, options = {}) => {
  const result = await execFileAsync(command, args, {
    cwd: repoRoot,
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
  const stdout = result.stdout?.trim() ?? '';
  if (!stdout) {
    throw new Error(`Command ${command} ${args.join(' ')} produced no JSON output.`);
  }
  return JSON.parse(stdout);
};

const seedWorkerScenario = async ({
  stateFile,
  product,
  namespace,
  shareToken,
  queuedSubject,
  smtpPort,
  portalBaseUrl,
}) => {
  return runJsonCommand(
    'pnpm',
    [
      '-C',
      'apps/server-worker',
      'exec',
      'node',
      '--import',
      'tsx',
      seedScriptFromWorker,
      JSON.stringify({
        stateFile,
        product,
        namespace,
        shareToken,
        queuedSubject,
        smtpPort,
        portalBaseUrl,
      }),
    ],
  );
};

const runWorkerOnce = async (databaseUrl, tenantId) => {
  try {
    return await execFileAsync(
      'pnpm',
      ['-C', 'apps/server-worker', 'exec', 'node', '--import', 'tsx', 'src/worker.ts'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          SMTP_PASSWORD: smtpPassword,
          // The seeded workspace sends through the local SMTP stub; the password only goes to this host.
          SMTP_HOST: '127.0.0.1',
          WORKER_TENANT_ID: tenantId,
          WORKER_RUN_ONCE: '1',
          WORKER_LOG_LEVEL: 'info',
        },
        maxBuffer: 10 * 1024 * 1024,
      },
    );
  } catch (error) {
    const details = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
    throw new Error(`Worker run failed:\n${details}`);
  }
};

const fetchJson = async (url, token) => {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    },
  });
  const body = await response.text();
  expect(response.ok, `Expected ${url} to return 200, got ${response.status}: ${body}`).toBeTruthy();
  return JSON.parse(body);
};

export const runWorkerFlowScenario = async (product) => {
  const state = await readServerHarnessState();
  const namespace = `${product}-worker-${randomSuffix()}`;
  const shareToken = `${namespace}-portal-token`;
  const queuedSubject = `Queued worker delivery ${namespace}`;
  const portalDecision = {
    decidedAt: new Date().toISOString(),
    decision: 'accepted',
    acceptedName: `${product === 'pro' ? 'Pro' : 'Lite'} Portal Approver`,
    acceptedEmail: `portal+${namespace}@example.com`,
    decisionTextVersion: `${namespace}-decision-v1`,
  };

  const smtp = await createSmtpSink();
  const portal = await startWorkerPortal(state, product);

  try {
    const metadata = await seedWorkerScenario({
      stateFile: state.stateFile,
      product,
      namespace,
      shareToken,
      queuedSubject,
      smtpPort: smtp.port,
      portalBaseUrl: portal.baseUrl,
    });

    const offerSnapshot = (await fetchJson(`${state.urls.api}/api/v1/${product}/offers`, metadata.token)).find((offer) => offer.id === metadata.offerId);
    await portalJson(portal, '/offers', { token: shareToken, snapshot: offerSnapshot }, { 'x-api-key': portal.apiKey });
    const savedDecision = await portalJson(portal, `/offers/${shareToken}/decision`, portalDecision, { origin: portal.baseUrl });
    expect(savedDecision.decision).toMatchObject({ decision: 'accepted', acceptedEmail: portalDecision.acceptedEmail });
    const worker = await runWorkerOnce(metadata.databaseUrl, metadata.tenantId);
    console.log(worker.stdout, worker.stderr);

    const messages = await smtp.waitForMessageCount(2);
    const invoices = await fetchJson(`${state.urls.api}/api/v1/${product}/invoices`, metadata.token);
    const recurringProfiles = await fetchJson(`${state.urls.api}/api/v1/${product}/recurring`, metadata.token);
    const offers = await fetchJson(`${state.urls.api}/api/v1/${product}/offers`, metadata.token);

    const recurringProfile = recurringProfiles.find((profile) => profile.id === metadata.recurringProfileId);
    expect(recurringProfile).toBeTruthy();
    expect(recurringProfile.lastRun).toBe(metadata.todayIso);
    expect(recurringProfile.nextRun > metadata.todayIso).toBeTruthy();

    const generatedInvoice = invoices.find(
      (invoice) =>
        !metadata.seedInvoiceIds.includes(invoice.id) &&
        invoice.clientId === metadata.recurringClientId &&
        invoice.status === 'draft' &&
        invoice.servicePeriod === metadata.todayIso,
    );
    expect(generatedInvoice).toBeTruthy();

    const overdueInvoice = invoices.find((invoice) => invoice.id === metadata.overdueInvoiceId);
    expect(overdueInvoice).toBeTruthy();
    expect(Number(overdueInvoice.amount)).toBeCloseTo(Number(metadata.expectedOverdueAmount), 2);

    const offer = offers.find((entry) => entry.id === metadata.offerId);
    expect(offer).toBeTruthy();
    expect(offer.status).toBe('accepted');
    expect(offer.share?.decision).toBe('accepted');
    expect(offer.share?.acceptedEmail).toBe(portalDecision.acceptedEmail);

    expect((await portalJson(portal, `/offers/${shareToken}/status`)).decision).toEqual(savedDecision.decision);

    const pool = new Pool({
      connectionString: metadata.databaseUrl,
    });

    try {
      const dunningHistory = await pool.query(
        `
          SELECT dunning_level, fee_applied, email_sent
          FROM dunning_history
          WHERE tenant_id = $1 AND invoice_id = $2
        `,
        [metadata.tenantId, metadata.overdueInvoiceId],
      );
      expect(dunningHistory.rowCount).toBe(1);
      expect(Number(dunningHistory.rows[0].dunning_level)).toBe(1);
      expect(Number(dunningHistory.rows[0].fee_applied)).toBeCloseTo(Number(metadata.dunningFee), 2);
      expect(dunningHistory.rows[0].email_sent).toBe(true);

      const outboxRows = await pool.query(
        `
          SELECT status, attempt_count, provider, sent_at
          FROM email_outbox
          WHERE tenant_id = $1 AND id = $2
        `,
        [metadata.tenantId, metadata.queuedEmailId],
      );
      expect(outboxRows.rowCount).toBe(1);
      expect(outboxRows.rows[0].status).toBe('sent');
      expect(Number(outboxRows.rows[0].attempt_count)).toBe(1);
      expect(outboxRows.rows[0].provider).toBe('smtp');
      expect(outboxRows.rows[0].sent_at).toBeTruthy();

      const emailLogs = await pool.query(
        `
          SELECT document_id, subject, status, provider
          FROM email_log
          WHERE tenant_id = $1
            AND (document_id = $2 OR document_id = $3)
          ORDER BY created_at ASC
        `,
        [metadata.tenantId, metadata.overdueInvoiceId, metadata.queuedEmailDocumentId],
      );
      expect(emailLogs.rowCount).toBe(2);
      expect(emailLogs.rows.map((row) => row.subject)).toEqual(
        expect.arrayContaining([metadata.expectedDunningSubject, metadata.queuedSubject]),
      );
      for (const row of emailLogs.rows) {
        expect(row.status).toBe('sent');
        expect(row.provider).toBe('smtp');
      }
    } finally {
      await pool.end();
    }

    expect(messages.map((message) => message.subject)).toEqual(
      expect.arrayContaining([metadata.expectedDunningSubject, metadata.queuedSubject]),
    );
  } finally {
    await Promise.allSettled([smtp.close(), portal.close()]);
  }
};
