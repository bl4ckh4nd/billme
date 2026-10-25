import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ServerWorkerRuntime } from '../../../apps/server-worker/src/runtime.js';
import { WorkerTaskQueue } from '../../../apps/server-worker/src/taskQueue.js';
import { createWorkerLogger } from '../../../apps/server-worker/src/logger.js';
import { captureUncaught, repoRoot, seedMember, startHostedServer, uniqueEmail, type HostedServer } from './server-fixtures.js';
import { startPgliteWire } from './pglite-wire.js';
import { addDays, draftOffer, issueInvoice, newClient, today } from './fixtures.js';

/**
 * The server worker (apps/server-worker) running its job functions against the
 * database the hosted API uses. Data is created through the real API routes, the
 * worker's effects are read back through the API and the tables. SMTP and the
 * offer portal are external boundaries and are replaced by small local servers.
 *
 * How this can fail (each one has a test below):
 * - scheduling: a job running for a tenant that is not configured, outside its
 *   window, with automation off, or twice in one window; the worker touching
 *   another tenant's data; starting on an unmigrated database; a second workspace
 *   never served (only the oldest one), one broken workspace stopping the others
 * - platform secrets: the server's SMTP password sent to an SMTP host a workspace
 *   typed into its settings instead of the host the operator pinned (SMTP_HOST);
 *   the portal key sent to a portal address other than BILLME_PUBLIC_PORTAL_URL
 * - recurring invoices: a due profile generating no invoice or two (second run,
 *   two workers at once), a future / inactive / ended profile generating one, one
 *   broken profile stopping the others, the profile not advancing, the number not
 *   finalized
 * - dunning: a paid, draft or not-yet-due invoice being dunned, the fee charged
 *   twice, a reminder sent twice for one level, placeholders left in the mail,
 *   a failed send hiding itself or charging the fee again on retry
 * - email queue: a mail sent twice (two workers, rerun), lost on a crash (expired
 *   lease), retried at once instead of with backoff, retried forever, a permanent
 *   SMTP refusal retried and a temporary one dropped, a missing provider or
 *   password swallowed instead of reported
 * - portal sync: a decision lost, applied twice, applied to another tenant's
 *   offer, one broken publication stopping the sync, an invalid portal URL
 * - maintenance: a number that was finalized or is still reserved deleted, recent
 *   rows deleted, another tenant's rows deleted, the deletion not audited
 * - tax filing job: a queued filing never claimed, claimed twice, a provider that
 *   is not installed reported as accepted, a self-approved filing getting there, a later tax year (2026) validated without a provider
 * - task queue: a duplicate job running in parallel, one failing job stopping the rest
 * - process: the worker binary exiting non-zero on a healthy database or zero on
 *   an unmigrated one
 */

// ---- external boundaries -------------------------------------------------------------

type Mail = { from: string; to: string[]; data: string };

/** Just enough SMTP for nodemailer: EHLO, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA, QUIT. */
const startSmtpStub = async () => {
  const mails: Mail[] = [];
  const behavior = { rcpt: '250 OK' };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.write('220 stub ESMTP ready\r\n');
    let buffer = '';
    let mail: Mail = { from: '', to: [], data: '' };
    let mode: 'command' | 'data' | 'login-user' | 'login-pass' = 'command';
    const handleLine = (line: string) => {
      if (mode === 'data') {
        if (line === '.') {
          mails.push(mail);
          mail = { from: '', to: [], data: '' };
          mode = 'command';
          socket.write('250 OK queued\r\n');
        } else mail.data += `${line}\n`;
        return;
      }
      if (mode === 'login-user') { mode = 'login-pass'; socket.write('334 UGFzc3dvcmQ6\r\n'); return; }
      if (mode === 'login-pass') { mode = 'command'; socket.write('235 authenticated\r\n'); return; }
      const upper = line.toUpperCase();
      if (upper.startsWith('EHLO') || upper.startsWith('HELO')) socket.write('250-stub\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
      else if (upper.startsWith('AUTH PLAIN')) socket.write('235 authenticated\r\n');
      else if (upper.startsWith('AUTH LOGIN')) { mode = 'login-user'; socket.write('334 VXNlcm5hbWU6\r\n'); }
      else if (upper.startsWith('MAIL FROM')) { mail.from = line; socket.write('250 OK\r\n'); }
      else if (upper.startsWith('RCPT TO')) {
        if (behavior.rcpt.startsWith('250')) mail.to.push(line);
        socket.write(`${behavior.rcpt}\r\n`);
      } else if (upper === 'DATA') { mode = 'data'; socket.write('354 go ahead\r\n'); }
      else if (upper === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
      else socket.write('250 OK\r\n');
    };
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handleLine(line);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port, mails, behavior,
    reset: () => { mails.length = 0; behavior.rcpt = '250 OK'; },
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
};

/** Answers `GET /offers/:token/status` like the offer portal does. */
const startPortalStub = async () => {
  const decisions = new Map<string, unknown>();
  const failing = new Set<string>();
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url ?? '');
    const match = /^\/offers\/([^/]+)\/status$/.exec(request.url ?? '');
    if (!match) { response.writeHead(404).end(); return; }
    const token = decodeURIComponent(match[1]!);
    if (failing.has(token)) { response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"gone"}'); return; }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ decision: decisions.get(token) ?? null }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`, decisions, failing, requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
};

const freePort = async (): Promise<number> => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

/** A HH:MM that the scheduled-run window ([HH:MM, +15 min) in local time) contains right now. */
const dueWindow = (): string => {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(Math.max(0, now.getMinutes() - 5)).padStart(2, '0')}`;
};
const farWindow = (): string => `${String((new Date().getHours() + 6) % 24).padStart(2, '0')}:00`;

const dunningLevels = [
  { id: 1, name: 'Zahlungserinnerung', enabled: true, daysAfterDueDate: 7, fee: 0, subject: 'Erinnerung %N', text: 'Rechnung %N über %A EUR ist seit %T Tagen überfällig (%K).' },
  { id: 2, name: '1. Mahnung', enabled: true, daysAfterDueDate: 21, fee: 5, subject: 'Mahnung %N', text: 'Mahnung zu %N, Gebühr %F EUR, fällig war der %D.' },
];

describe('server worker', () => {
  let h: HostedServer;
  let smtp: Awaited<ReturnType<typeof startSmtpStub>>;
  let portal: Awaited<ReturnType<typeof startPortalStub>>;
  const workers: ServerWorkerRuntime[] = [];
  const previousSmtpPassword = process.env.SMTP_PASSWORD;
  const previousSmtpHost = process.env.SMTP_HOST;

  before(async () => {
    process.env.SMTP_PASSWORD = 'smtp-secret'; // the hosted API reads it to accept /email/send
    process.env.SMTP_HOST = '127.0.0.1'; // the only host that secret may go to
    h = await startHostedServer('worker');
    smtp = await startSmtpStub();
    portal = await startPortalStub();
  });
  after(async () => {
    await Promise.all(workers.map((worker) => worker.close().catch(() => undefined)));
    await smtp.close();
    await portal.close();
    await h.close();
    if (previousSmtpPassword === undefined) delete process.env.SMTP_PASSWORD; else process.env.SMTP_PASSWORD = previousSmtpPassword;
    if (previousSmtpHost === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = previousSmtpHost;
  });

  const smtpSettings = (port = smtp.port) => ({ provider: 'smtp', smtpHost: '127.0.0.1', smtpPort: port, smtpSecure: false, smtpUser: 'worker', fromName: 'Muster GmbH', fromEmail: 'info@muster.example' });

  /** A fresh tenant with an owner who really logs in, so every test owns its data. */
  const newTenant = async (label: string, settings: Record<string, unknown> = {}, product: 'lite' | 'pro' = 'lite') => {
    const email = uniqueEmail(label);
    const { tenantId } = await seedMember(h.wire, { product, email, fullName: label, role: 'owner' });
    const { token, user } = await h.login(product, email);
    const saved = await h.putSettings(product, token, settings);
    return { tenantId, token, user, email, api: h.liteApi(token), settings: saved };
  };
  const updateSettings = async (tenant: Awaited<ReturnType<typeof newTenant>>, patch: Record<string, unknown>) => {
    const next = { ...tenant.settings, ...patch };
    await h.http('PUT', '/api/v1/lite/settings', { token: tenant.token, body: { reason: 'test', settings: next } });
    tenant.settings = next as typeof tenant.settings;
  };
  const worker = async (tenantId: string, env: { smtpPassword?: string | null } = {}) => {
    const instance = new ServerWorkerRuntime({
      databaseUrl: h.wire.url,
      tenantId,
      ...(env.smtpPassword === null ? {} : { smtpPassword: env.smtpPassword ?? 'smtp-secret' }),
      smtpHost: '127.0.0.1',
    }, createWorkerLogger('error'));
    await instance.init();
    workers.push(instance);
    return instance;
  };
  const rows = async <T = Record<string, unknown>>(text: string, values: unknown[] = []) => (await h.wire.sql<T>(text, values)).rows;
  const profile = (clientId: string, overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(), clientId, active: true, name: 'Wartungsvertrag', interval: 'monthly', nextRun: today(), amount: 100,
    items: [{ kind: 'item', description: 'Wartung', quantity: 1, price: 100, total: 100, taxRate: 19 }], taxMode: 'standard_vat', ...overrides,
  });
  const saveProfile = (tenant: Awaited<ReturnType<typeof newTenant>>, body: ReturnType<typeof profile>) =>
    h.http('POST', '/api/v1/lite/recurring', { token: tenant.token, body: { reason: 'Abo anlegen', profile: body } });
  const invoicesOf = async (tenant: Awaited<ReturnType<typeof newTenant>>) => (await h.http('GET', '/api/v1/lite/invoices', { token: tenant.token })).body as Array<Record<string, any>>;

  describe('scheduling and guards', () => {
    test('a tenant that does not exist is skipped by every job, never created or failed', async () => {
      const w = await worker(`ghost-${randomUUID()}`);
      for (const job of [w.runRecurringJob, w.runDunningJob, w.runQueuedEmailJob, w.runTaxFilingSubmissionJob, w.runPortalSyncJob, w.runMaintenanceJob]) {
        const result = await job.call(w);
        assert.deepEqual({ status: result.status, message: result.message }, { status: 'skipped', message: 'No workspace is set up yet' });
      }
    });

    test('a tenant without settings is skipped by the settings-driven jobs', async () => {
      const email = uniqueEmail('nosettings');
      const { tenantId } = await seedMember(h.wire, { product: 'lite', email, fullName: 'No Settings', role: 'owner' });
      const w = await worker(tenantId);
      for (const job of [w.runRecurringJob, w.runDunningJob, w.runQueuedEmailJob, w.runPortalSyncJob]) {
        const result = await job.call(w);
        assert.deepEqual({ status: result.status, message: result.message }, { status: 'skipped', message: 'Server settings are not initialized yet' });
      }
      assert.equal((await w.runMaintenanceJob()).status, 'completed', 'maintenance needs no settings');
    });

    test('recurring and dunning stay idle with automation off or outside their window', async () => {
      const tenant = await newTenant('idle');
      const w = await worker(tenant.tenantId);
      const { id: clientId } = await tenant.api.clients.upsert({ client: newClient() as never });
      await saveProfile(tenant, profile(clientId));
      assert.equal((await w.runRecurringJob()).message, 'Recurring schedule window is not due', 'automation disabled');
      assert.equal((await w.runDunningJob()).message, 'Dunning schedule window is not due');
      await updateSettings(tenant, { automation: { recurringEnabled: true, recurringRunTime: farWindow(), dunningEnabled: true, dunningRunTime: farWindow() } });
      assert.equal((await w.runRecurringJob()).status, 'skipped', 'enabled, but the window is hours away');
      assert.equal((await w.runDunningJob()).status, 'skipped');
      assert.equal((await invoicesOf(tenant)).length, 0);
    });

    test('without a tenant filter every active workspace is served, and one broken workspace does not stop the others', async () => {
      const own = await startHostedServer('worker-workspaces');
      try {
        const workspace = async (label: string) => {
          const email = uniqueEmail(label);
          const { tenantId } = await seedMember(own.wire, { product: 'lite', email, fullName: label, role: 'owner' });
          const { token } = await own.login('lite', email);
          const settings = await own.putSettings('lite', token, { automation: { recurringEnabled: true, recurringRunTime: dueWindow(), dunningEnabled: false } });
          const api = own.liteApi(token);
          const { id: clientId } = await api.clients.upsert({ client: newClient() as never });
          return { tenantId, token, settings, clientId };
        };
        const first = await workspace('ws-first');
        const second = await workspace('ws-second');
        const broken = await workspace('ws-broken');
        for (const ws of [first, second]) {
          assert.equal((await own.http('POST', '/api/v1/lite/recurring', { token: ws.token, body: { reason: 'Abo', profile: profile(ws.clientId) } })).status, 200);
        }
        // A settings row the worker cannot read must only block its own workspace.
        await own.wire.sql(`UPDATE server_settings SET settings_json = '{"broken":' WHERE tenant_id = $1`, [broken.tenantId]);
        await own.wire.sql(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [(await seedMember(own.wire, { product: 'lite', email: uniqueEmail('ws-suspended'), fullName: 'Suspended', role: 'owner' })).tenantId]);

        const w = new ServerWorkerRuntime({ databaseUrl: own.wire.url, smtpHost: '127.0.0.1' }, createWorkerLogger('error'));
        await w.init();
        workers.push(w);
        const result = await w.runRecurringJob();
        const perTenant = (result.details?.tenants ?? []) as Array<{ tenantId: string; status: string }>;
        assert.equal(result.status, 'blocked', 'the broken workspace is reported');
        assert.deepEqual(perTenant.map((entry) => entry.status).sort(), ['blocked', 'completed', 'completed']);
        assert.equal(perTenant.find((entry) => entry.tenantId === broken.tenantId)?.status, 'blocked');
        for (const ws of [first, second]) {
          const invoices = (await own.http('GET', '/api/v1/lite/invoices', { token: ws.token })).body as unknown[];
          assert.equal(invoices.length, 1, `workspace ${ws.tenantId} got its recurring invoice`);
        }
      } finally {
        await own.close();
      }
    });

    test('the worker refuses to start against a database the migrator has not prepared', async () => {
      const bare = await startPgliteWire({ migrate: false });
      try {
        const { result } = await captureUncaught(async () => {
          const w = new ServerWorkerRuntime({ databaseUrl: bare.url }, createWorkerLogger('error'));
          const error = await w.init().then(() => null, (e: Error) => e);
          await w.close().catch(() => undefined);
          return error;
        });
        assert.match(result?.message ?? 'started', /not initialized by the Drizzle migrator/);
      } finally { await bare.close(); }
    });
  });

  describe('recurring invoices', () => {
    const automationOn = { recurringEnabled: true, dunningEnabled: false };

    test('a due profile generates exactly one invoice, advances, finalizes its number and is audited; reruns add nothing', async () => {
      const tenant = await newTenant('recurring');
      const { id: clientId } = await tenant.api.clients.upsert({ client: newClient({ company: 'Abo Kunde GmbH' }) as never });
      const due = profile(clientId);
      const future = profile(clientId, { name: 'Morgen', nextRun: addDays(today(), 1) });
      const inactive = profile(clientId, { name: 'Pausiert', active: false });
      for (const body of [due, future, inactive]) assert.equal((await saveProfile(tenant, body)).status, 200);
      await updateSettings(tenant, { automation: { ...automationOn, recurringRunTime: dueWindow() } });
      const w = await worker(tenant.tenantId);

      const first = await w.runRecurringJob();
      assert.deepEqual({ status: first.status, details: first.details }, { status: 'completed', details: { generated: 1, deactivated: 0, errors: 0 } });
      const invoices = await invoicesOf(tenant);
      assert.equal(invoices.length, 1);
      const invoice = invoices[0]!;
      assert.equal(invoice.client, 'Abo Kunde GmbH');
      assert.equal(invoice.clientId, clientId);
      assert.match(invoice.number, /^RE-\d{4}-\d{3}$/);
      assert.equal(invoice.date, today());
      assert.equal(invoice.amount, 119, '100 net + 19 % VAT');
      assert.equal(invoice.taxSnapshot.grossAmount, 119);
      assert.equal(invoice.items[0].description, 'Wartung');

      const stored = (await h.http('GET', `/api/v1/lite/recurring/${due.id}`, { token: tenant.token })).body;
      assert.equal(stored.lastRun, today());
      assert.ok(stored.nextRun > today(), `nextRun ${stored.nextRun} must move past today`);
      assert.equal((await h.http('GET', `/api/v1/lite/recurring/${future.id}`, { token: tenant.token })).body.nextRun, future.nextRun);
      assert.equal((await h.http('GET', `/api/v1/lite/recurring/${inactive.id}`, { token: tenant.token })).body.lastRun, undefined);

      const reservation = (await rows<{ status: string; document_id: string }>(`SELECT status, document_id FROM number_reservations WHERE tenant_id = $1 AND number = $2`, [tenant.tenantId, invoice.number]))[0];
      assert.deepEqual({ status: reservation?.status, document: reservation?.document_id }, { status: 'finalized', document: invoice.id });
      const audit = await rows<{ action: string }>(`SELECT action FROM audit_log WHERE tenant_id = $1 AND action = 'recurring.scheduled_run'`, [tenant.tenantId]);
      assert.equal(audit.length, 1);
      assert.equal((await h.http('GET', '/api/v1/lite/audit/verify', { token: tenant.token })).body.ok, true);

      const second = await w.runRecurringJob();
      assert.equal(second.status, 'skipped', 'the same day, the window is spent');
      // Even if the window were open again (settings reset), the profile has moved on.
      await updateSettings(tenant, { automation: { ...automationOn, recurringRunTime: dueWindow(), lastRecurringRun: undefined } });
      const third = await w.runRecurringJob();
      assert.equal(third.details?.generated, 0);
      assert.equal((await invoicesOf(tenant)).length, 1, 'no second invoice for the same period');
    });

    test('two workers racing for one due profile still produce one invoice', async () => {
      const tenant = await newTenant('recurring-race');
      const { id: clientId } = await tenant.api.clients.upsert({ client: newClient() as never });
      await saveProfile(tenant, profile(clientId));
      await updateSettings(tenant, { automation: { ...automationOn, recurringRunTime: dueWindow() } });
      const results = await Promise.all([(await worker(tenant.tenantId)).runRecurringJob(), (await worker(tenant.tenantId)).runRecurringJob()]);
      assert.equal(results.reduce((sum, result) => sum + Number(result.details?.generated ?? 0), 0), 1, JSON.stringify(results));
      assert.equal((await invoicesOf(tenant)).length, 1);
    });

    test('a broken profile is reported and does not stop the others; the last period deactivates its profile', async () => {
      const tenant = await newTenant('recurring-mixed');
      const { id: clientId } = await tenant.api.clients.upsert({ client: newClient() as never });
      const orphan = profile(clientId, { name: 'Ohne Kunde' });
      const lastPeriod = profile(clientId, { name: 'Letzte Rate', endDate: addDays(today(), 10) });
      const good = profile(clientId, { name: 'Gut' });
      for (const body of [orphan, lastPeriod, good]) assert.equal((await saveProfile(tenant, body)).status, 200);
      await h.wire.sql('UPDATE recurring_profiles SET client_id=$1 WHERE tenant_id=$2 AND id=$3', ['missing-client', tenant.tenantId, orphan.id]);
      await updateSettings(tenant, { automation: { ...automationOn, recurringRunTime: dueWindow() } });
      const result = await (await worker(tenant.tenantId)).runRecurringJob();
      assert.deepEqual(result.details, { generated: 2, deactivated: 1, errors: 1 });
      assert.equal((await invoicesOf(tenant)).length, 2);
      const ended = (await h.http('GET', `/api/v1/lite/recurring/${lastPeriod.id}`, { token: tenant.token })).body;
      assert.equal(ended.active, false);
      assert.equal((await h.http('GET', `/api/v1/lite/recurring/${orphan.id}`, { token: tenant.token })).body.lastRun, undefined, 'the failed profile is retried next time');
      assert.equal((await rows(`SELECT 1 FROM number_reservations WHERE tenant_id = $1 AND status = 'reserved'`, [tenant.tenantId])).length, 0, 'the failed profile must not leave a reserved number behind');
    });

    test('a worker only touches the tenant it is configured for', async () => {
      const a = await newTenant('recurring-a');
      const b = await newTenant('recurring-b');
      for (const tenant of [a, b]) {
        const { id: clientId } = await tenant.api.clients.upsert({ client: newClient() as never });
        await saveProfile(tenant, profile(clientId));
        await updateSettings(tenant, { automation: { ...automationOn, recurringRunTime: dueWindow() } });
      }
      assert.equal((await (await worker(a.tenantId)).runRecurringJob()).details?.generated, 1);
      assert.equal((await invoicesOf(a)).length, 1);
      assert.equal((await invoicesOf(b)).length, 0, 'tenant B\'s due profile ran under tenant A\'s worker');
    });
  });

  describe('dunning', () => {
    const dunningOn = () => ({ automation: { dunningEnabled: true, dunningRunTime: dueWindow(), recurringEnabled: false }, dunning: { levels: dunningLevels }, email: smtpSettings() });
    const overdueInvoice = (tenant: Awaited<ReturnType<typeof newTenant>>, daysOverdue: number, input: Record<string, unknown> = {}) =>
      issueInvoice(tenant.api, { client: 'Säumig GmbH', clientEmail: 'saeumig@example.com', date: addDays(today(), -daysOverdue - 14), dueDate: addDays(today(), -daysOverdue), ...input });

    test('an overdue invoice gets its reminder once: mail sent, placeholders filled, fee charged once, level recorded', async () => {
      smtp.reset();
      const tenant = await newTenant('dunning', dunningOn());
      const invoice = await overdueInvoice(tenant, 30);
      const untouched = await Promise.all([
        overdueInvoice(tenant, -5, { client: 'Noch nicht fällig' }),
        (async () => { const paid = await overdueInvoice(tenant, 30, { client: 'Schon bezahlt' }); await h.http('POST', `/api/v1/lite/invoices/${paid.id}/payments`, { token: tenant.token, body: { reason: 'bezahlt', payment: { id: randomUUID(), date: today(), amount: paid.amount, method: 'Bank' } } }); return paid; })(),
      ]);
      const w = await worker(tenant.tenantId);

      const first = await w.runDunningJob();
      assert.equal(first.status, 'completed', JSON.stringify(first));
      assert.deepEqual(first.details, { processedInvoices: 1, emailsSent: 1, feesApplied: 5, errors: 0 });
      assert.equal(smtp.mails.length, 1);
      const mail = smtp.mails[0]!;
      assert.match(mail.to.join(), /saeumig@example\.com/);
      assert.match(mail.data, new RegExp(`Mahnung zu ${invoice.number}`));
      assert.ok(!/%[NDATFK]/.test(mail.data), 'a placeholder was left in the mail');
      assert.match(mail.data, /Geb(ü|=C3=BC)hr 5\.00 EUR/);

      const stored = (await h.http('GET', `/api/v1/lite/invoices/${invoice.id}`, { token: tenant.token })).body;
      assert.equal(stored.dunningLevel, 2, '30 days overdue is the second level');
      assert.equal(stored.amount, invoice.amount, 'the fee is recorded in the dunning history, the issued invoice keeps its amount');
      const log = await rows<{ status: string; recipient_email: string }>(`SELECT status, recipient_email FROM email_log WHERE tenant_id = $1 AND document_id = $2`, [tenant.tenantId, invoice.id]);
      assert.deepEqual(log, [{ status: 'sent', recipient_email: 'saeumig@example.com' }]);
      assert.equal((await rows(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 AND action = 'invoice.dunning_reminder_sent'`, [tenant.tenantId, invoice.id])).length, 1);
      for (const other of untouched) assert.equal((await h.http('GET', `/api/v1/lite/invoices/${other.id}`, { token: tenant.token })).body.dunningLevel ?? 0, 0);

      // The next day's window: same level, nothing more happens.
      await updateSettings(tenant, { ...dunningOn(), automation: { dunningEnabled: true, dunningRunTime: dueWindow(), recurringEnabled: false, lastDunningRun: undefined } });
      const again = await w.runDunningJob();
      assert.equal(again.details?.emailsSent, 0);
      assert.equal(smtp.mails.length, 1, 'a reminder for the same level went out twice');
      assert.equal(Number((await rows<{ fee: string }>(`SELECT COALESCE(SUM(fee_applied), 0) AS fee FROM dunning_history WHERE tenant_id = $1 AND invoice_id = $2`, [tenant.tenantId, invoice.id]))[0]!.fee), 5, 'the fee was charged twice');
      assert.equal((await h.http('GET', `/api/v1/lite/invoices/${invoice.id}`, { token: tenant.token })).body.amount, invoice.amount);
    });

    test('a reminder that could not be sent is reported, never raises the level, and never costs the fee or the mail twice', async () => {
      smtp.reset();
      const tenant = await newTenant('dunning-fail', { ...dunningOn(), email: smtpSettings(await freePort()) });
      const invoice = await overdueInvoice(tenant, 25);
      const w = await worker(tenant.tenantId);

      const failed = await w.runDunningJob();
      assert.equal(failed.details?.errors, 1, JSON.stringify(failed));
      assert.equal(failed.details?.emailsSent, 0);
      const afterFailure = (await h.http('GET', `/api/v1/lite/invoices/${invoice.id}`, { token: tenant.token })).body;
      assert.equal(afterFailure.dunningLevel ?? 0, 0, 'a reminder that never left must not raise the level');
      assert.equal(afterFailure.amount, invoice.amount, 'the issued invoice never carries a fee');
      assert.ok(Number((await rows<{ fee: string }>(`SELECT COALESCE(SUM(fee_applied), 0) AS fee FROM dunning_history WHERE tenant_id = $1 AND invoice_id = $2`, [tenant.tenantId, invoice.id]))[0]!.fee) <= 5, 'at most one fee');
      assert.equal((await rows(`SELECT 1 FROM email_log WHERE tenant_id = $1 AND document_id = $2 AND status = 'failed'`, [tenant.tenantId, invoice.id])).length, 1, 'the failure is in the mail log');
      assert.equal((await rows(`SELECT 1 FROM email_log WHERE tenant_id = $1 AND document_id = $2 AND status = 'sent'`, [tenant.tenantId, invoice.id])).length, 0);
      // The send state is not silent: a delivery whose outcome is unclear must be visible for a person to reconcile.
      const deliveries = await rows<{ state: string }>(`SELECT state FROM dunning_deliveries WHERE tenant_id = $1 AND invoice_id = $2`, [tenant.tenantId, invoice.id]);
      assert.equal(deliveries.length, 1);
      assert.ok(['unknown', 'failed'].includes(deliveries[0]!.state), `delivery state ${deliveries[0]!.state}`);
      if (deliveries[0]!.state === 'unknown') {
        const listed = await h.http('GET', '/api/v1/lite/dunning/deliveries', { token: tenant.token });
        assert.equal(listed.status, 200);
        assert.deepEqual(listed.body.map((d: { invoiceId: string; state: string }) => [d.invoiceId, d.state]), [[invoice.id, 'unknown']], 'an unclear send is offered for reconciliation');
      }

      // The mail server is back; whatever the retry policy is, one level never means two mails or two fees.
      await updateSettings(tenant, { ...dunningOn(), automation: { dunningEnabled: true, dunningRunTime: dueWindow(), recurringEnabled: false, lastDunningRun: undefined } });
      await w.runDunningJob().catch(() => undefined);
      await updateSettings(tenant, { ...dunningOn(), automation: { dunningEnabled: true, dunningRunTime: dueWindow(), recurringEnabled: false, lastDunningRun: undefined } });
      await w.runDunningJob().catch(() => undefined);
      assert.ok(smtp.mails.length <= 1, `${smtp.mails.length} reminders for one level`);
      const stored = (await h.http('GET', `/api/v1/lite/invoices/${invoice.id}`, { token: tenant.token })).body;
      assert.equal(stored.amount, invoice.amount);
      assert.ok(Number((await rows<{ fee: string }>(`SELECT COALESCE(SUM(fee_applied), 0) AS fee FROM dunning_history WHERE tenant_id = $1 AND invoice_id = $2`, [tenant.tenantId, invoice.id]))[0]!.fee) <= 5, 'the fee was charged twice');
    });

    test('dunning without a configured mail provider stops loudly instead of marking invoices as reminded', async () => {
      const tenant = await newTenant('dunning-noprovider', { ...dunningOn(), email: { provider: 'none', smtpHost: '', smtpPort: 587, smtpSecure: true, smtpUser: '', fromName: '', fromEmail: '' } });
      const invoice = await overdueInvoice(tenant, 30);
      const w = await worker(tenant.tenantId);
      const result = await w.runDunningJob();
      assert.equal(result.status, 'blocked');
      assert.match(result.message, /^Kein E-Mail-Versand eingerichtet/);
      assert.equal((await h.http('GET', `/api/v1/lite/invoices/${invoice.id}`, { token: tenant.token })).body.dunningLevel ?? 0, 0);
    });
  });

  describe('email queue', () => {
    const queue = (tenant: Awaited<ReturnType<typeof newTenant>>, documentId: string, extra: Record<string, unknown> = {}) =>
      h.http('POST', '/api/v1/lite/email/send', { token: tenant.token, body: { documentType: 'invoice', documentId, recipientEmail: 'empfaenger@example.com', recipientName: 'Emma Empfänger', subject: 'Ihre Rechnung', bodyText: 'Anbei die Rechnung.', ...extra } });
    const outbox = (tenant: Awaited<ReturnType<typeof newTenant>>) =>
      rows<{ id: string; status: string; attempt_count: number; max_attempts: number; next_attempt_at: string; last_error: string | null; provider: string | null }>(
        `SELECT id, status, attempt_count, max_attempts, next_attempt_at, last_error, provider FROM email_outbox WHERE tenant_id = $1 ORDER BY created_at`, [tenant.tenantId]);

    test('a queued mail is delivered once with its text, recorded in the mail log, and a rerun finds nothing', async () => {
      smtp.reset();
      const tenant = await newTenant('mail', { email: smtpSettings() });
      const invoice = await issueInvoice(tenant.api, { client: 'Mail Kunde' });
      const queued = await queue(tenant, invoice.id);
      assert.equal(queued.status, 200, queued.text);
      assert.equal(queued.body.success, true);
      assert.equal((await outbox(tenant))[0]!.status, 'pending');
      assert.equal(smtp.mails.length, 0, 'the API only queues in server mode');

      const w = await worker(tenant.tenantId);
      const result = await w.runQueuedEmailJob();
      assert.deepEqual({ status: result.status, details: result.details }, { status: 'completed', details: { claimed: 1, sent: 1, retried: 0, failed: 0 } });
      assert.equal(smtp.mails.length, 1);
      assert.match(smtp.mails[0]!.data, /Subject: Ihre Rechnung/);
      assert.match(smtp.mails[0]!.data, /Anbei die Rechnung\./);
      assert.match(smtp.mails[0]!.to.join(), /empfaenger@example\.com/);
      const [entry] = await outbox(tenant);
      assert.deepEqual({ status: entry!.status, attempts: entry!.attempt_count, provider: entry!.provider }, { status: 'sent', attempts: 1, provider: 'smtp' });
      assert.equal((await rows(`SELECT 1 FROM email_log WHERE tenant_id = $1 AND status = 'sent'`, [tenant.tenantId])).length, 1);
      assert.equal((await w.runQueuedEmailJob()).details?.claimed, 0);
      assert.equal(smtp.mails.length, 1);
    });

    test('queuing the same mail twice yields one outbox entry and one delivery', async () => {
      smtp.reset();
      const tenant = await newTenant('mail-dedupe', { email: smtpSettings() });
      const invoice = await issueInvoice(tenant.api, { client: 'Dedupe' });
      const first = await queue(tenant, invoice.id);
      const second = await queue(tenant, invoice.id);
      assert.equal(first.body.messageId, second.body.messageId);
      assert.equal((await outbox(tenant)).length, 1);
      await (await worker(tenant.tenantId)).runQueuedEmailJob();
      assert.equal(smtp.mails.length, 1);
    });

    test('the API does not queue a mail nobody can deliver and rejects malformed requests', async () => {
      const tenant = await newTenant('mail-none');
      const invoice = await issueInvoice(tenant.api, { client: 'Kein Provider' });
      const noProvider = await queue(tenant, invoice.id);
      assert.equal(noProvider.body.success, false);
      assert.match(noProvider.body.error, /Kein E-Mail-Anbieter/);
      assert.equal((await outbox(tenant)).length, 0);
      await updateSettings(tenant, { email: smtpSettings() });
      assert.equal((await queue(tenant, invoice.id, { recipientEmail: 'not-an-email' })).status, 400);
      assert.equal((await queue(tenant, invoice.id, { subject: '' })).status, 400);
      assert.equal((await queue(tenant, 'does-not-exist')).status, 404);
      const viewer = uniqueEmail('mail-viewer');
      await seedMember(h.wire, { product: 'lite', email: viewer, fullName: 'Viewer', role: 'viewer', tenantId: tenant.tenantId });
      assert.equal((await h.http('POST', '/api/v1/lite/email/send', { token: (await h.login('lite', viewer)).token, body: { documentType: 'invoice', documentId: invoice.id, recipientEmail: 'a@example.com', recipientName: 'A', subject: 'S', bodyText: 'B' } })).status, 403);
      assert.equal((await outbox(tenant)).length, 0);
    });

    test('the job reports a missing provider or password instead of dropping the mail', async () => {
      const tenant = await newTenant('mail-blocked', { email: smtpSettings() });
      const invoice = await issueInvoice(tenant.api, { client: 'Blockiert' });
      await queue(tenant, invoice.id);
      const noPassword = await (await worker(tenant.tenantId, { smtpPassword: null })).runQueuedEmailJob();
      assert.deepEqual({ status: noPassword.status, message: noPassword.message }, { status: 'blocked', message: 'SMTP-Passwort fehlt. Der Betreiber hinterlegt den Wert am Server (SMTP_PASSWORD).' });
      await updateSettings(tenant, { email: { ...smtpSettings(), provider: 'none' } });
      const noProvider = await (await worker(tenant.tenantId)).runQueuedEmailJob();
      assert.deepEqual({ status: noProvider.status, message: noProvider.message }, { status: 'blocked', message: 'Kein E-Mail-Anbieter eingerichtet. Wähle SMTP oder Resend unter Einstellungen → E-Mail.' });
      assert.equal((await outbox(tenant))[0]!.status, 'pending', 'the mail is still waiting');
    });

    test('the server\'s SMTP password never goes to a host the workspace chose instead of the pinned one', async () => {
      smtp.reset();
      const tenant = await newTenant('mail-pinned', { email: smtpSettings() });
      const invoice = await issueInvoice(tenant.api, { client: 'Gepinnt' });
      assert.equal((await queue(tenant, invoice.id)).body.success, true);
      // "localhost" reaches the same stub as 127.0.0.1, so a leak would show up there.
      await updateSettings(tenant, { email: { ...smtpSettings(), smtpHost: 'localhost' } });
      const result = await (await worker(tenant.tenantId)).runQueuedEmailJob();
      assert.equal(result.status, 'blocked');
      assert.match(result.message, /localhost ist auf diesem Server nicht freigegeben/);
      assert.equal(smtp.mails.length, 0, 'nothing was delivered with the platform password');
      assert.equal((await outbox(tenant))[0]!.status, 'pending');
      const viaApi = await h.http('POST', '/api/v1/lite/email/test-config', { token: tenant.token, body: { provider: 'smtp', smtpHost: 'localhost', smtpPort: smtp.port, smtpSecure: false, smtpUser: 'x' } });
      assert.equal(viaApi.body.success, false);
      assert.match(viaApi.body.error, /nicht freigegeben/);
      const queuedAgain = await queue(tenant, invoice.id, { subject: 'Zweiter Versuch' });
      assert.equal(queuedAgain.body.success, false, 'the API refuses to queue for an unpinned host');
      assert.equal(smtp.mails.length, 0);
    });

    test('an unreachable SMTP server schedules a retry with backoff, then delivers; after the last attempt the mail is failed', async () => {
      smtp.reset();
      const tenant = await newTenant('mail-retry', { email: smtpSettings(await freePort()) });
      const invoice = await issueInvoice(tenant.api, { client: 'Retry' });
      await queue(tenant, invoice.id);
      const w = await worker(tenant.tenantId);

      const first = await w.runQueuedEmailJob();
      assert.deepEqual(first.details, { claimed: 1, sent: 0, retried: 1, failed: 0 });
      const [pending] = await outbox(tenant);
      assert.equal(pending!.status, 'pending');
      assert.equal(pending!.attempt_count, 1);
      assert.match(pending!.last_error ?? '', /ECONNREFUSED/i);
      const waitMs = Date.parse(pending!.next_attempt_at) - Date.now();
      assert.ok(waitMs > 4 * 60_000 && waitMs <= 5 * 60_000 + 5_000, `first retry in ~5 minutes, got ${Math.round(waitMs / 1000)} s`);
      assert.equal((await w.runQueuedEmailJob()).details?.claimed, 0, 'not due yet, no immediate retry storm');

      // Time passes and the server is back.
      await updateSettings(tenant, { email: smtpSettings() });
      await h.wire.sql(`UPDATE email_outbox SET next_attempt_at = $2 WHERE id = $1`, [pending!.id, new Date(Date.now() - 1000).toISOString()]);
      const second = await w.runQueuedEmailJob();
      assert.equal(second.details?.sent, 1, JSON.stringify(second));
      assert.equal(smtp.mails.length, 1);
      assert.deepEqual(await outbox(tenant).then(([e]) => ({ status: e!.status, attempts: e!.attempt_count })), { status: 'sent', attempts: 2 });

      // Out of attempts: the last failure is final.
      const exhausted = await newTenant('mail-exhausted', { email: smtpSettings(await freePort()) });
      await queue(exhausted, (await issueInvoice(exhausted.api, { client: 'Exhausted' })).id);
      const [entry] = await outbox(exhausted);
      await h.wire.sql('UPDATE email_outbox SET attempt_count = max_attempts - 1 WHERE id = $1', [entry!.id]);
      const last = await (await worker(exhausted.tenantId)).runQueuedEmailJob();
      assert.deepEqual(last.details, { claimed: 1, sent: 0, retried: 0, failed: 1 });
      assert.equal((await outbox(exhausted))[0]!.status, 'failed');
      assert.equal((await (await worker(exhausted.tenantId)).runQueuedEmailJob()).details?.claimed, 0, 'a failed mail is not picked up again');
    });

    test('two workers never deliver one mail twice; a crashed worker\'s expired lease is picked up', async () => {
      smtp.reset();
      const tenant = await newTenant('mail-lease', { email: smtpSettings() });
      const invoice = await issueInvoice(tenant.api, { client: 'Lease' });
      await queue(tenant, invoice.id);
      const results = await Promise.all([(await worker(tenant.tenantId)).runQueuedEmailJob(), (await worker(tenant.tenantId)).runQueuedEmailJob()]);
      assert.equal(results.reduce((sum, result) => sum + Number(result.details?.sent ?? 0), 0), 1, JSON.stringify(results));
      assert.equal(smtp.mails.length, 1);

      smtp.reset();
      const second = await queue(tenant, invoice.id, { subject: 'Zweite Mail' });
      assert.equal(second.status, 200);
      const [, crashed] = await outbox(tenant);
      await h.wire.sql(`UPDATE email_outbox SET status = 'processing', locked_by = 'crashed-worker', locked_at = $2, lease_expires_at = $3 WHERE id = $1`,
        [crashed!.id, new Date().toISOString(), new Date(Date.now() + 5 * 60_000).toISOString()]);
      assert.equal((await (await worker(tenant.tenantId)).runQueuedEmailJob()).details?.claimed, 0, 'a live lease belongs to its owner');
      await h.wire.sql(`UPDATE email_outbox SET lease_expires_at = $2 WHERE id = $1`, [crashed!.id, new Date(Date.now() - 1000).toISOString()]);
      const recovered = await (await worker(tenant.tenantId)).runQueuedEmailJob();
      assert.equal(recovered.details?.sent, 1, JSON.stringify(recovered));
      assert.equal(smtp.mails.length, 1);
    });

    test('a permanent SMTP refusal (5xx) is failed at once instead of being retried', async () => {
      smtp.reset();
      smtp.behavior.rcpt = '550 5.1.1 Recipient address rejected: user unknown';
      const tenant = await newTenant('mail-5xx', { email: smtpSettings() });
      await queue(tenant, (await issueInvoice(tenant.api, { client: 'Permanent' })).id);
      const result = await (await worker(tenant.tenantId)).runQueuedEmailJob();
      smtp.reset();
      assert.deepEqual(result.details, { claimed: 1, sent: 0, retried: 0, failed: 1 }, 'a refused recipient will not become valid in five minutes');
      assert.equal((await outbox(tenant))[0]!.status, 'failed');
    });

    test('a temporary SMTP refusal (4xx) is retried instead of being failed for good', async () => {
      smtp.reset();
      smtp.behavior.rcpt = '421 4.3.2 Service shutting down, try again later';
      const tenant = await newTenant('mail-4xx', { email: smtpSettings() });
      await queue(tenant, (await issueInvoice(tenant.api, { client: 'Temporär' })).id);
      const result = await (await worker(tenant.tenantId)).runQueuedEmailJob();
      smtp.reset();
      assert.deepEqual(result.details, { claimed: 1, sent: 0, retried: 1, failed: 0 });
      assert.equal((await outbox(tenant))[0]!.status, 'pending');
    });
  });

  describe('offer portal sync', () => {
    const publish = async (tenant: Awaited<ReturnType<typeof newTenant>>, token: string) => {
      const draft = await draftOffer(tenant.api, { client: 'Portal Kunde' });
      const stored = (await h.http('GET', `/api/v1/lite/offers/${draft.id}`, { token: tenant.token })).body;
      const saved = await h.http('POST', '/api/v1/lite/offers', { token: tenant.token, body: { reason: 'veröffentlicht', offer: { ...stored, kind: 'offer', validUntil: addDays(today(), 30), status: 'open', share: { token, publishedAt: new Date().toISOString() } } } });
      assert.equal(saved.status, 200, saved.text);
      return draft.id;
    };
    const offerOf = async (tenant: Awaited<ReturnType<typeof newTenant>>, id: string) => (await h.http('GET', `/api/v1/lite/offers/${id}`, { token: tenant.token })).body;
    const decision = (kind: 'accepted' | 'declined') => ({ decision: kind, decidedAt: new Date().toISOString(), acceptedName: 'Karl Kunde', acceptedEmail: 'karl@example.com', decisionTextVersion: 'v1' });

    test('a customer decision lands on the offer once, with one audit entry; undecided and withdrawn publications change nothing', async () => {
      const tenant = await newTenant('portal', { portal: { baseUrl: portal.url } });
      const accepted = await publish(tenant, `tok-accepted-${randomUUID()}`);
      const declined = await publish(tenant, `tok-declined-${randomUUID()}`);
      const waiting = await publish(tenant, `tok-waiting-${randomUUID()}`);
      const withdrawn = await publish(tenant, `tok-withdrawn-${randomUUID()}`);
      const tokenOf = async (id: string) => (await offerOf(tenant, id)).share.token as string;
      portal.decisions.set(await tokenOf(accepted), decision('accepted'));
      portal.decisions.set(await tokenOf(declined), decision('declined'));
      portal.failing.add(await tokenOf(withdrawn));

      const w = await worker(tenant.tenantId);
      const result = await w.runPortalSyncJob();
      assert.deepEqual({ status: result.status, details: result.details }, { status: 'completed', details: { pending: 4, updated: 2 } });
      const a = await offerOf(tenant, accepted);
      assert.equal(a.status, 'accepted');
      assert.deepEqual({ by: a.share.acceptedBy, email: a.share.acceptedEmail, decision: a.share.decision }, { by: 'Karl Kunde', email: 'karl@example.com', decision: 'accepted' });
      assert.ok(a.share.acceptedAt);
      assert.equal((await offerOf(tenant, declined)).status, 'declined');
      assert.equal((await offerOf(tenant, waiting)).status, 'open');
      assert.equal((await offerOf(tenant, withdrawn)).status, 'open');
      assert.equal((await rows(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'offer.portal_decision' AND entity_id = $2`, [tenant.tenantId, accepted])).length, 1);

      const again = await w.runPortalSyncJob();
      assert.deepEqual(again.details, { pending: 2, updated: 0 }, 'decided offers are no longer polled');
      // A later change of mind in the portal cannot rewrite an accepted offer.
      portal.decisions.set(await tokenOf(accepted), decision('declined'));
      await w.runPortalSyncJob();
      assert.equal((await offerOf(tenant, accepted)).status, 'accepted');
    });

    test('two workers syncing at once apply a decision once', async () => {
      const tenant = await newTenant('portal-race', { portal: { baseUrl: portal.url } });
      const id = await publish(tenant, `tok-race-${randomUUID()}`);
      portal.decisions.set((await offerOf(tenant, id)).share.token, decision('accepted'));
      const results = await Promise.all([(await worker(tenant.tenantId)).runPortalSyncJob(), (await worker(tenant.tenantId)).runPortalSyncJob()]);
      assert.equal(results.reduce((sum, result) => sum + Number(result.details?.updated ?? 0), 0), 1);
      assert.equal((await rows(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'offer.portal_decision' AND entity_id = $2`, [tenant.tenantId, id])).length, 1);
    });

    test('the server\'s portal key is only sent to the pinned portal address', async () => {
      const saved = { key: process.env.PORTAL_API_KEY, pin: process.env.BILLME_PUBLIC_PORTAL_URL };
      process.env.PORTAL_API_KEY = 'portal-secret';
      process.env.BILLME_PUBLIC_PORTAL_URL = portal.url;
      try {
        // "localhost" reaches the same stub as the pinned 127.0.0.1 address, so a leak would show up there.
        const elsewhere = await newTenant('portal-unpinned', { portal: { baseUrl: portal.url.replace('127.0.0.1', 'localhost') } });
        const offer = await draftOffer(elsewhere.api, { client: 'Portal Kunde' });
        portal.requests.length = 0;
        const refused = await h.http('POST', '/api/v1/lite/portal/publish-offer', { token: elsewhere.token, body: { offerId: offer.id } });
        assert.equal(refused.status, 409, refused.text);
        assert.match(refused.body.message, /nicht freigegeben/);
        assert.equal(portal.requests.length, 0, 'nothing reached the portal with the platform key');
      } finally {
        if (saved.key === undefined) delete process.env.PORTAL_API_KEY; else process.env.PORTAL_API_KEY = saved.key;
        if (saved.pin === undefined) delete process.env.BILLME_PUBLIC_PORTAL_URL; else process.env.BILLME_PUBLIC_PORTAL_URL = saved.pin;
      }
    });

    test('no portal URL is skipped, a non-https URL is refused, another tenant\'s offers are not polled', async () => {
      const without = await newTenant('portal-none');
      assert.deepEqual(await (await worker(without.tenantId)).runPortalSyncJob().then((r) => [r.status, r.message]), ['skipped', 'Portal base URL is not configured']);

      const insecure = await newTenant('portal-http');
      const refused = await h.http('PUT', '/api/v1/lite/settings', { token: insecure.token, body: { reason: 'x', settings: { ...insecure.settings, portal: { baseUrl: 'http://portal.example.com' } } } });
      assert.equal(refused.status, 400, 'the settings route refuses a non-https portal URL');
      await publish(insecure, `tok-insecure-${randomUUID()}`);
      const stored = JSON.parse((await rows<{ settings_json: string }>('SELECT settings_json FROM server_settings WHERE tenant_id = $1', [insecure.tenantId]))[0]!.settings_json);
      await h.wire.sql('UPDATE server_settings SET settings_json = $2 WHERE tenant_id = $1', [insecure.tenantId, JSON.stringify({ ...stored, portal: { baseUrl: 'http://portal.example.com' } })]);
      const insecureRun = await (await worker(insecure.tenantId)).runPortalSyncJob();
      assert.equal(insecureRun.status, 'blocked', 'a URL that slipped into the database is still refused by the worker');
      assert.match(insecureRun.message, /https/);

      const a = await newTenant('portal-a', { portal: { baseUrl: portal.url } });
      const b = await newTenant('portal-b', { portal: { baseUrl: portal.url } });
      const token = `tok-isolated-${randomUUID()}`;
      const offerId = await publish(a, token);
      portal.decisions.set((await offerOf(a, offerId)).share.token, decision('accepted'));
      portal.requests.length = 0;
      const result = await (await worker(b.tenantId)).runPortalSyncJob();
      assert.deepEqual(result.details, { pending: 0, updated: 0 });
      assert.ok(!portal.requests.some((url) => url.includes(token)), 'B\'s worker asked the portal about A\'s publication');
      assert.equal((await offerOf(a, offerId)).status, 'open');
    });
  });

  describe('maintenance', () => {
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    const reservation = (tenantId: string, status: string, ageDays: number, number: string) =>
      h.wire.sql(`INSERT INTO number_reservations (id, tenant_id, kind, number, counter_value, status, document_id, created_at, updated_at) VALUES ($1, $2, 'invoice', $3, 1, $4, $5, $6, $6)`,
        [randomUUID(), tenantId, number, status, status === 'finalized' ? randomUUID() : null, daysAgo(ageDays)]);
    const importRun = (tenantId: string, status: string, ageDays: number) =>
      h.wire.sql(`INSERT INTO sqlite_import_runs (id, tenant_id, source_path, source_product, source_sha256, status, details_json, started_at, completed_at) VALUES ($1, $2, '/old.sqlite', 'lite', 'abc', $3, '{}', $4, $4)`,
        [randomUUID(), tenantId, status, daysAgo(ageDays)]);

    test('only released reservations older than 90 days and settled import runs older than a year go; nothing a gapless numbering or a migration receipt needs', async () => {
      const tenant = await newTenant('maintenance');
      const other = await newTenant('maintenance-other');
      await Promise.all([
        reservation(tenant.tenantId, 'released', 120, 'RE-OLD-1'),
        reservation(tenant.tenantId, 'released', 91, 'RE-OLD-2'),
        reservation(tenant.tenantId, 'released', 30, 'RE-NEW-1'),
        reservation(tenant.tenantId, 'finalized', 900, 'RE-FINAL-1'),
        reservation(tenant.tenantId, 'reserved', 900, 'RE-OPEN-1'),
        reservation(other.tenantId, 'released', 500, 'RE-OTHER-1'),
        importRun(tenant.tenantId, 'completed', 400),
        importRun(tenant.tenantId, 'failed', 400),
        importRun(tenant.tenantId, 'completed', 30),
        importRun(tenant.tenantId, 'started', 400),
        importRun(other.tenantId, 'completed', 800),
      ]);
      const w = await worker(tenant.tenantId);
      const result = await w.runMaintenanceJob();
      assert.equal(result.status, 'completed');
      assert.equal(result.details?.totalDeleted, 4);
      const steps = Object.fromEntries((result.details?.steps as Array<{ key: string; deletedCount: number }>).map((step) => [step.key, step.deletedCount]));
      assert.deepEqual(steps, { 'released-number-reservations': 2, 'sqlite-import-runs': 2 });

      const left = (await rows<{ number: string }>(`SELECT number FROM number_reservations WHERE tenant_id = $1 ORDER BY number`, [tenant.tenantId])).map((r) => r.number);
      assert.deepEqual(left, ['RE-FINAL-1', 'RE-NEW-1', 'RE-OPEN-1']);
      assert.equal((await rows(`SELECT 1 FROM number_reservations WHERE tenant_id = $1`, [other.tenantId])).length, 1, 'another tenant\'s reservation was deleted');
      assert.equal((await rows(`SELECT 1 FROM sqlite_import_runs WHERE tenant_id = $1`, [other.tenantId])).length, 1, 'another tenant\'s import receipt was deleted');
      assert.deepEqual((await rows<{ status: string }>(`SELECT status FROM sqlite_import_runs WHERE tenant_id = $1 ORDER BY status`, [tenant.tenantId])).map((r) => r.status), ['completed', 'started']);
      assert.equal((await rows(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'maintenance.retention'`, [tenant.tenantId])).length, 1);
      assert.equal((await h.http('GET', '/api/v1/lite/audit/verify', { token: tenant.token })).body.ok, true);

      const second = await w.runMaintenanceJob();
      assert.equal(second.details?.totalDeleted, 0);
      assert.equal((await rows(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'maintenance.retention'`, [tenant.tenantId])).length, 1, 'a sweep that deletes nothing writes no audit entry');
    });
  });

  describe('tax filing submission', () => {
    type Pro = Awaited<ReturnType<typeof newTenant>>;
    const proTenant = (): Promise<Pro> => newTenant('tax', {}, 'pro');
    const draftFiling = async (tenant: Pro, payload: Record<string, unknown> = {}) => {
      const snapshotId = randomUUID();
      const sourceHash = createHash('sha256').update(snapshotId).digest('hex');
      await h.wire.sql(`INSERT INTO report_snapshots (id, tenant_id, report_type, args_json, payload_json, source_hash, created_at) VALUES ($1, $2, 'euer', '{}', '{}', $3, $4)`, [snapshotId, tenant.tenantId, sourceHash, new Date().toISOString()]);
      const created = await h.http('POST', '/api/v1/pro/tax-filings', { token: tenant.token, body: {
        kind: 'euer', periodStart: '2025-01-01', periodEnd: '2025-12-31', payload: { taxYear: 2025, reportSnapshotId: snapshotId, sourceSnapshotHash: sourceHash, ...payload },
        idempotencyKey: `create-${snapshotId}`, reason: 'EÜR 2025 vorbereiten',
      } });
      assert.equal(created.status, 200, created.text);
      return created.body.id as string;
    };
    const step = (tenant: Pro, id: string, action: string) =>
      h.http('POST', `/api/v1/pro/tax-filings/${id}/${action}`, { token: tenant.token, body: { reason: `${action} per Test`, idempotencyKey: `${action}-${id}-${randomUUID()}` } });
    /** The filing workflow is fail-closed until a provider is installed, so a queued filing is put there directly. */
    const queuedFiling = async (tenant: Pro) => {
      const id = await draftFiling(tenant);
      await h.wire.sql(`UPDATE tax_submissions SET status = 'queued' WHERE id = $1`, [id]);
      const stamp = new Date().toISOString();
      await h.wire.sql(`INSERT INTO tax_submission_jobs (id, tenant_id, submission_id, job_type, idempotency_key, status, attempts, available_at, created_at, updated_at) VALUES ($1, $2, $3, 'tax-filing', $4, 'pending', 0, $5, $5, $5)`,
        [randomUUID(), tenant.tenantId, id, `submit:${id}`, stamp]);
      return id;
    };
    const jobs = (tenant: Pro) => rows<{ status: string; attempts: number; last_error: string | null }>(`SELECT status, attempts, last_error FROM tax_submission_jobs WHERE tenant_id = $1 ORDER BY created_at`, [tenant.tenantId]);

    test('a filing cannot be validated, approved or queued without the provider contract: the workflow fails closed', async () => {
      const tenant = await proTenant();
      const id = await draftFiling(tenant);
      const validate = await step(tenant, id, 'validate');
      assert.equal(validate.status, 422);
      assert.match(validate.body.message, /EÜR ELSTER catalog\/provider is unavailable/);
      const wrongYear = await draftFiling(tenant, { taxYear: 2024 });
      assert.match((await step(tenant, wrongYear, 'validate')).body.message, /tax year from 2025 on/);
      // 2026 is accepted as a tax year, but the provider is still missing: no simulated validation.
      const nextYear = await step(tenant, await draftFiling(tenant, { taxYear: 2026 }), 'validate');
      assert.deepEqual([nextYear.status, /provider is unavailable/.test(nextYear.body.message)], [422, true], nextYear.text);
      for (const action of ['freeze', 'request-second-approval', 'approve', 'queue']) {
        assert.equal((await step(tenant, id, action)).status, 409, `${action} on a draft`);
      }
      assert.equal((await h.http('GET', `/api/v1/pro/tax-filings/${id}`, { token: tenant.token })).body.status, 'draft');
      assert.deepEqual(await jobs(tenant), [], 'nothing was queued');
      const result = await (await worker(tenant.tenantId)).runTaxFilingSubmissionJob();
      assert.equal(result.details?.queued, 0);
    });

    test('a queued filing is claimed once; the provider that is not installed leaves it retryable, never accepted', async () => {
      const tenant = await proTenant();
      const id = await queuedFiling(tenant);
      const w = await worker(tenant.tenantId);
      const run = await w.runTaxFilingSubmissionJob();
      assert.deepEqual({ status: run.status, details: run.details }, { status: 'blocked', details: { queued: 1, processed: 1, accepted: 0, rejected: 0, retryableFailed: 1 } });
      const afterFirst = (await h.http('GET', `/api/v1/pro/tax-filings/${id}`, { token: tenant.token })).body;
      assert.equal(afterFirst.status, 'retryable_failed');
      assert.match(afterFirst.failureMessage ?? '', /not installed or configured/);
      assert.deepEqual((await jobs(tenant)).map((j) => ({ status: j.status, attempts: j.attempts })), [{ status: 'pending', attempts: 1 }]);
      assert.match((await jobs(tenant))[0]!.last_error ?? '', /not installed or configured/);
      assert.equal((await rows(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 AND action = 'tax_filing.fail_retryable'`, [tenant.tenantId, id])).length, 1);

      assert.equal((await step(tenant, id, 'retry')).status, 200);
      assert.equal((await jobs(tenant)).length, 2, 'a retry by a person queues a new job');
      const retried = await w.runTaxFilingSubmissionJob();
      assert.ok((retried.details?.retryableFailed as number) >= 1 && retried.details?.accepted === 0);
      assert.equal((await h.http('GET', `/api/v1/pro/tax-filings/${id}`, { token: tenant.token })).body.status, 'retryable_failed');
    });

    test('the job of a filing that already failed is closed instead of being re-claimed and failed forever', async () => {
      const tenant = await proTenant();
      const id = await queuedFiling(tenant);
      const w = await worker(tenant.tenantId);
      await w.runTaxFilingSubmissionJob();
      assert.equal((await h.http('GET', `/api/v1/pro/tax-filings/${id}`, { token: tenant.token })).body.status, 'retryable_failed');
      await w.runTaxFilingSubmissionJob();
      assert.equal((await jobs(tenant))[0]!.status, 'completed', 'the first job is spent, only a person\'s retry makes a new one');
      assert.equal((await w.runTaxFilingSubmissionJob()).details?.queued, 0, 'nothing left to claim');
    });

    test('two workers cannot claim the same submission job', async () => {
      const tenant = await proTenant();
      const id = await queuedFiling(tenant);
      const results = await Promise.all([(await worker(tenant.tenantId)).runTaxFilingSubmissionJob(), (await worker(tenant.tenantId)).runTaxFilingSubmissionJob()]);
      assert.equal(results.reduce((sum, result) => sum + Number(result.details?.queued ?? 0), 0), 1, JSON.stringify(results.map((r) => r.details)));
      assert.equal((await rows(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 AND action = 'tax_filing.transmitting'`, [tenant.tenantId, id])).length, 1, 'transmitted twice');
    });

    test('tenant B cannot see, validate or queue tenant A\'s filing, and its worker leaves A\'s job alone', async () => {
      const a = await proTenant();
      const b = await proTenant();
      const id = await queuedFiling(a);
      assert.equal((await h.http('GET', `/api/v1/pro/tax-filings/${id}`, { token: b.token })).body, null);
      assert.deepEqual((await h.http('GET', '/api/v1/pro/tax-filings', { token: b.token })).body, []);
      assert.ok([403, 404, 409, 422].includes((await step(b, id, 'validate')).status));
      assert.equal((await (await worker(b.tenantId)).runTaxFilingSubmissionJob()).details?.queued, 0);
      assert.equal((await jobs(a))[0]!.status, 'pending');
    });

    test('with nothing queued the job completes empty', async () => {
      const tenant = await proTenant();
      const result = await (await worker(tenant.tenantId)).runTaxFilingSubmissionJob();
      assert.deepEqual({ status: result.status, details: result.details }, { status: 'completed', details: { queued: 0, processed: 0, accepted: 0, rejected: 0, retryableFailed: 0 } });
    });
  });

  describe('task queue', () => {
    const logger = (errors: string[]) => {
      const make = (): ReturnType<typeof createWorkerLogger> => ({ debug() {}, info() {}, warn() {}, error: (message, meta) => { errors.push(`${message} ${JSON.stringify(meta ?? {})}`); }, child: make });
      return make();
    };

    test('a job that is pending or running is not queued again; it can be queued once it finished', async () => {
      const queue = new WorkerTaskQueue(logger([]));
      let running = 0;
      let peak = 0;
      let runs = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const task = { name: 'recurring', run: async () => { running += 1; peak = Math.max(peak, running); runs += 1; await gate; running -= 1; } };
      assert.equal(queue.enqueue(task), true);
      assert.equal(queue.enqueue(task), false, 'pending');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(queue.enqueue(task), false, 'running');
      release();
      await queue.whenIdle();
      assert.deepEqual({ runs, peak }, { runs: 1, peak: 1 });
      assert.equal(queue.enqueue({ name: 'recurring', run: async () => { runs += 1; } }), true);
      await queue.whenIdle();
      assert.equal(runs, 2);
    });

    test('a failing job is logged and the next job still runs; different jobs run one after another', async () => {
      const errors: string[] = [];
      const queue = new WorkerTaskQueue(logger(errors));
      const order: string[] = [];
      queue.enqueue({ name: 'explodes', run: async () => { order.push('explodes'); throw new Error('boom'); } });
      queue.enqueue({ name: 'survives', run: async () => { order.push('survives'); } });
      queue.enqueue({ name: 'last', run: async () => { order.push('last'); } });
      await queue.whenIdle();
      assert.deepEqual(order, ['explodes', 'survives', 'last']);
      assert.equal(errors.length, 1);
      assert.match(errors[0]!, /explodes.*boom/);
    });
  });

  describe('worker process', () => {
    const run = (env: Record<string, string>) => new Promise<{ code: number | null; lines: Array<Record<string, any>>; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', join(repoRoot, 'apps', 'server-worker', 'src', 'worker.ts')], {
        cwd: join(repoRoot, 'apps', 'server-worker'),
        env: { ...process.env, WORKER_RUN_ONCE: '1', WORKER_LOG_LEVEL: 'info', ...env },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 150_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        // Warnings (a blocked workspace) go to stderr, the rest to stdout.
        const lines = `${stdout}\n${stderr}`.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
        resolve({ code, lines, stderr });
      });
    });

    test('WORKER_RUN_ONCE runs every job and exits 0 (the due recurring profile became an invoice); on a never-migrated database it exits non-zero', async () => {
      const tenant = await newTenant('process');
      const { id: clientId } = await tenant.api.clients.upsert({ client: newClient() as never });
      await saveProfile(tenant, profile(clientId));
      await updateSettings(tenant, { automation: { recurringEnabled: true, dunningEnabled: false, recurringRunTime: dueWindow() } });
      const bare = await startPgliteWire({ migrate: false });
      try {
        // Both processes start in parallel: loading the worker's module graph dominates the cost.
        const [healthy, unmigrated] = await Promise.all([
          run({ DATABASE_URL: h.wire.url, WORKER_TENANT_ID: tenant.tenantId, SMTP_PASSWORD: 'x' }),
          captureUncaught(() => run({ DATABASE_URL: bare.url })).then((r) => r.result),
        ]);
        assert.equal(healthy.code, 0, healthy.stderr.slice(-400));
        const reported = healthy.lines.filter((line) => line.job).map((line) => line.job);
        for (const name of ['recurring-invoices', 'dunning', 'queued-email-dispatch', 'tax-filing-submission', 'offer-portal-sync', 'scheduled-maintenance']) {
          assert.ok(reported.includes(name), `${name} did not report (${reported})`);
        }
        assert.equal((await invoicesOf(tenant)).length, 1);
        assert.notEqual(unmigrated.code, 0);
        assert.match(unmigrated.stderr, /not initialized by the Drizzle migrator/);
      } finally { await bare.close(); }
    });
  });
});
