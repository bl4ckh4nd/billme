import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PgliteServerDatabase } from '@billme/server-data';
import { buildServerApi } from './app.js';

const token = 'dunning-letter-local-access-token';
const tenantId = 'dunning-letter-tenant';
const headers = { 'x-billme-local-token': token };

/** Minimal SMTP sink: accepts AUTH and one message per DATA, keeps the raw messages. */
const startSmtpSink = async () => {
  const messages: string[] = [];
  const server = createServer((socket: Socket) => {
    let buffer = '';
    let data: string[] | null = null;
    let authStep = 0;
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply('220 sink ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (data) {
          if (line === '.') {
            messages.push(data.join('\n'));
            data = null;
            reply('250 queued');
          } else data.push(line);
          continue;
        }
        if (authStep > 0) {
          authStep = authStep === 1 ? 2 : 0;
          reply(authStep === 2 ? '334 UGFzc3dvcmQ6' : '235 ok');
          continue;
        }
        const command = line.split(' ')[0]!.toUpperCase();
        if (command === 'EHLO' || command === 'HELO') {
          socket.write('250-sink\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
        } else if (command === 'AUTH') {
          if (/^AUTH LOGIN$/i.test(line)) {
            authStep = 1;
            reply('334 VXNlcm5hbWU6');
          } else reply('235 ok');
        } else if (command === 'DATA') {
          data = [];
          reply('354 go ahead');
        } else if (command === 'QUIT') {
          reply('221 bye');
          socket.end();
        } else reply('250 ok');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, messages, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
};

const settings = (smtpPort: number) => ({
  company: { name: 'Holzwerk Brandt', owner: 'Jana Brandt', street: 'Sägewerkstraße 12', zip: '14482', city: 'Potsdam', email: 'buero@holzwerk.test', phone: '', website: '' },
  catalog: { categories: [] },
  finance: { bankName: '', iban: '', bic: '', taxId: '046/123/45678', vatId: '', registerCourt: '' },
  numbers: { invoicePrefix: 'RE-', nextInvoiceNumber: 1, numberLength: 4, offerPrefix: 'AN-', nextOfferNumber: 1, customerPrefix: 'KD-', nextCustomerNumber: 1, customerNumberLength: 4 },
  dunning: {
    levels: [
      { id: 1, name: 'Zahlungserinnerung', enabled: true, daysAfterDueDate: 7, fee: 0, subject: 'Erinnerung %N', text: 'Die Rechnung %N ist noch offen.' },
      { id: 2, name: '1. Mahnung', enabled: true, daysAfterDueDate: 14, fee: 2.5, subject: '1. Mahnung %N', text: 'Erste Mahnung zur Rechnung %N.' },
    ],
  },
  legal: { smallBusinessRule: false, defaultVatRate: 19, countryCode: 'DE', taxAccountingMethod: 'soll', paymentTermsDays: 14, defaultIntroText: '', defaultFooterText: '' },
  portal: { baseUrl: '' },
  eInvoice: { enabled: false, standard: 'zugferd-en16931', profile: 'EN16931', version: '2.3' },
  email: { provider: 'smtp', smtpHost: '127.0.0.1', smtpPort, smtpSecure: false, smtpUser: 'buero', fromName: 'Holzwerk', fromEmail: 'buero@holzwerk.test' },
  automation: { dunningEnabled: true, dunningRunTime: '09:00', recurringEnabled: false, recurringRunTime: '03:00' },
  dashboard: { monthlyRevenueGoal: 30000, dueSoonDays: 7, topCategoriesLimit: 5, recentPaymentsLimit: 5, topClientsLimit: 5 },
});

test('the embedded dunning run mails the rendered dunning letter as PDF attachment', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-dunning-letter-'));
  const sink = await startSmtpSink();
  const database = await PgliteServerDatabase.open(dataDir);
  const rendered: Array<{ kind: string; id: string; level?: number; suggestedName: string }> = [];
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'lite',
    logger: false,
    sessionSecret: 'dunning-letter-server-api-test-secret',
    localAuth: { accessToken: token, tenantId, userId: 'owner', email: 'owner@example.com', fullName: 'Owner' },
    desktopIntegration: {
      getSecret: async () => 'smtp-secret',
      renderDocumentPdf: async (args) => {
        rendered.push(args);
        const path = join(dataDir, `${args.suggestedName}.pdf`);
        await writeFile(path, '%PDF-1.7 dunning letter');
        return { path };
      },
    },
  });
  try {
    const now = new Date();
    await database.query(`INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at) VALUES ($1, 'dl', 'DL', 'lite', $2, $2)`, [tenantId, now.toISOString()]);
    await database.query(`INSERT INTO server_settings (tenant_id, settings_json, created_at, updated_at) VALUES ($1, $2, $3, $3)`, [tenantId, JSON.stringify(settings(sink.port)), now.toISOString()]);
    await app.ready();
    const due = new Date(now.getTime() - 20 * 86_400_000).toISOString().slice(0, 10);
    const saved = await app.inject({ method: 'POST', url: '/api/v1/lite/invoices', headers, payload: { reason: 'test', invoice: {
      kind: 'invoice', id: 'overdue-1', number: 'RE-0042', client: 'Kanzlei Weber', clientEmail: 'weber@example.com',
      date: due, dueDate: due, amount: 100, status: 'open', items: [], payments: [],
    } } });
    assert.equal(saved.statusCode, 200, saved.body);

    const run = await app.inject({ method: 'POST', url: '/api/v1/lite/dunning/manual-run', headers });
    assert.equal(run.statusCode, 200, run.body);
    assert.equal(run.json().success, true, run.body);
    assert.deepEqual(run.json().result.errors, []);
    assert.equal(run.json().result.emailsSent, 1);

    assert.deepEqual(rendered.map(({ kind, id, level }) => ({ kind, id, level })), [{ kind: 'dunning', id: 'overdue-1', level: 2 }]);
    assert.equal(sink.messages.length, 1);
    const mail = sink.messages[0]!;
    assert.match(mail, /Subject: 1\. Mahnung RE-0042/);
    assert.match(mail, /filename=.?1\. Mahnung RE-0042\.pdf/);
    assert.match(mail, /Content-Type: application\/pdf/);

    // The letter's figures after the run: the fee is on the invoice and in the history, but counted once.
    const context = (await app.inject({ method: 'GET', url: '/api/v1/lite/documents/dunning/overdue-1/render-context', headers })).json();
    assert.equal(context.templateKind, 'dunning');
    assert.equal(context.document.amount, 102.5);
    assert.deepEqual(
      { level: context.dunning.level, levelName: context.dunning.levelName, fee: context.dunning.fee, originalAmount: context.dunning.originalAmount, daysOverdue: context.dunning.daysOverdue },
      { level: 2, levelName: '1. Mahnung', fee: 2.5, originalAmount: 100, daysOverdue: 20 },
    );
    assert.equal(context.texts.intro, 'Sehr geehrte Damen und Herren,\n\nErste Mahnung zur Rechnung {{invoice.number}}.\n\nBitte überweisen Sie den offenen Betrag bis zum {{dunning.payUntil}}.');
  } finally {
    await app.close();
    await sink.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
