import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDefaultTemplateBody } from '@billme/server-core';
import { PgliteServerDatabase } from '@billme/server-data';
import { buildServerApi } from './app.js';

const token = 'document-templates-local-access-token';
const tenantId = 'document-templates-tenant';
const headers = { 'x-billme-local-token': token };

const settings = {
  company: { name: 'Holzwerk Brandt', owner: 'Jana Brandt', street: 'Sägewerkstraße 12', zip: '14482', city: 'Potsdam', email: '', phone: '', website: '' },
  catalog: { categories: [] },
  finance: { bankName: '', iban: '', bic: '', taxId: '', vatId: '', registerCourt: '' },
  numbers: {
    invoicePrefix: 'RE-', nextInvoiceNumber: 1, numberLength: 4,
    offerPrefix: 'AN-', nextOfferNumber: 1, customerPrefix: 'KD-', nextCustomerNumber: 1, customerNumberLength: 4,
  },
  dunning: { levels: [] },
  legal: {
    smallBusinessRule: false, defaultVatRate: 19, countryCode: 'DE', taxAccountingMethod: 'soll',
    paymentTermsDays: 14, defaultIntroText: '', defaultFooterText: '',
  },
  portal: { baseUrl: '' },
  eInvoice: { enabled: false, standard: 'zugferd-en16931', profile: 'EN16931', version: '2.3' },
  email: { provider: 'none', smtpHost: '', smtpPort: 587, smtpSecure: true, smtpUser: '', fromName: '', fromEmail: '' },
  automation: { dunningEnabled: false, dunningRunTime: '09:00', recurringEnabled: false, recurringRunTime: '03:00' },
  dashboard: { monthlyRevenueGoal: 30000, dueSoonDays: 7, topCategoriesLimit: 5, recentPaymentsLimit: 5, topClientsLimit: 5 },
};

const boot = (database: PgliteServerDatabase) => buildServerApi({
  database,
  runtime: 'embedded',
  product: 'lite',
  logger: false,
  sessionSecret: 'document-templates-server-api-test-secret',
  localAuth: { accessToken: token, tenantId, userId: 'owner', email: 'owner@example.com', fullName: 'Owner' },
});

/** The server prices a draft from its lines, so the amount follows them. */
const line = (total: number) => [{ kind: 'item', description: 'Beratung', quantity: 1, price: total, total, taxRate: 0 }];
const invoice = (id: string, extra: Record<string, unknown> = {}) => ({
  kind: 'invoice', id, number: `RE-${id}`, client: 'Kanzlei Weber', clientEmail: 'weber@example.com',
  date: '2026-09-24', dueDate: '2026-10-08', amount: 100, status: 'draft', items: line(100), payments: [], ...extra,
});

test('document templates: versions, defaults, per-document layout, render context and legacy conversion', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-document-templates-'));
  let database = await PgliteServerDatabase.open(dataDir);
  let app = await boot(database);
  try {
    const now = new Date().toISOString();
    await database.query(
      `INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at) VALUES ($1, 'dt', 'DT', 'lite', $2, $2)`,
      [tenantId, now],
    );
    await database.query(
      `INSERT INTO server_settings (tenant_id, settings_json, created_at, updated_at) VALUES ($1, $2, $3, $3)`,
      [tenantId, JSON.stringify(settings), now],
    );
    // A canvas template with an edited intro and a logo, marked active for invoices.
    await database.query(
      `INSERT INTO templates (id, tenant_id, kind, name, elements_json, created_at, updated_at) VALUES ('canvas-1', $1, 'invoice', 'Meine Rechnung', $2, $3, $3)`,
      [tenantId, JSON.stringify([
        { id: 'intro', type: 'TEXT', x: 75, y: 400, zIndex: 1, label: 'intro_text', content: 'Hallo Nachbar,\nhier die Rechnung.', style: {} },
        { id: 'logo', type: 'IMAGE', x: 600, y: 60, zIndex: 1, src: 'data:image/png;base64,iVBORw0KGgo=', style: { width: 150 } },
        { id: 'terms', type: 'TEXT', x: 75, y: 900, zIndex: 1, label: 'payment_terms', content: 'Bitte überweisen Sie den Betrag bis spätestens {{invoice.dueDate}} ohne Abzug auf das unten genannte Konto.\nEs gelten unsere AGB.', style: {} },
      ]), now],
    );
    await database.query(
      `INSERT INTO active_templates (tenant_id, id, invoice_template_id, offer_template_id) VALUES ($1, 1, 'canvas-1', NULL)`,
      [tenantId],
    );
    await app.close();

    // Boot converts the canvas template and makes it the invoice default.
    database = await PgliteServerDatabase.open(dataDir);
    app = await boot(database);
    await app.ready();
    const converted = (await app.inject({ method: 'GET', url: '/api/v1/lite/document-templates', headers })).json();
    assert.equal(converted.length, 1);
    assert.equal(converted[0].id, 'legacy-canvas-1');
    assert.equal(converted[0].name, 'Meine Rechnung');
    assert.equal(converted[0].body.texts.intro, 'Hallo Nachbar,\nhier die Rechnung.');
    assert.equal(converted[0].body.texts.closing, createDefaultTemplateBody('invoice').texts.closing, 'unchanged canvas default gives way to the preset text');
    assert.equal(converted[0].body.logo.position, 'right');
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/v1/lite/document-templates/defaults', headers })).json(), { invoice: 'legacy-canvas-1' });

    // Deleting the converted template must survive the next boot (idempotent converter).
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/lite/document-templates/legacy-canvas-1', headers })).statusCode, 200);
    await app.close();
    database = await PgliteServerDatabase.open(dataDir);
    app = await boot(database);
    await app.ready();
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/v1/lite/document-templates', headers })).json(), []);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/v1/lite/document-templates/defaults', headers })).json(), {});

    // Every save bumps the version.
    const body = createDefaultTemplateBody('invoice', 'klassisch');
    const created = await app.inject({ method: 'POST', url: '/api/v1/lite/document-templates', headers,
      payload: { template: { kind: 'invoice', name: 'Klassisch', body } } });
    assert.equal(created.statusCode, 200, created.body);
    const v1 = created.json();
    assert.equal(v1.version, 1);
    const v2 = (await app.inject({ method: 'POST', url: '/api/v1/lite/document-templates', headers,
      payload: { template: { id: v1.id, kind: 'invoice', name: 'Klassisch', body: { ...body, accentColor: '#aa0000' } } } })).json();
    assert.equal(v2.version, 2);
    assert.equal(v2.createdAt, v1.createdAt);
    const kindChange = await app.inject({ method: 'POST', url: '/api/v1/lite/document-templates', headers,
      payload: { template: { id: v1.id, kind: 'offer', name: 'Klassisch', body } } });
    assert.equal(kindChange.statusCode, 409);

    const wrongKindDefault = await app.inject({ method: 'PUT', url: '/api/v1/lite/document-templates/defaults', headers,
      payload: { kind: 'offer', templateId: v1.id } });
    assert.equal(wrongKindDefault.statusCode, 404);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/lite/document-templates/defaults', headers,
      payload: { kind: 'invoice', templateId: v1.id } })).statusCode, 200);

    // Layout round-trips on the document.
    const layout = { templateId: v1.id, texts: { intro: 'Individuelle Einleitung' } };
    const saved = await app.inject({ method: 'POST', url: '/api/v1/lite/invoices', headers,
      payload: { reason: 'test', invoice: invoice('1', { layout }) } });
    assert.equal(saved.statusCode, 200, saved.body);
    const reloaded = (await app.inject({ method: 'GET', url: '/api/v1/lite/invoices/1', headers })).json();
    assert.deepEqual(reloaded.layout, layout);

    // A writer that does not send layout (older shell, payment update) keeps the stored one.
    await app.inject({ method: 'POST', url: '/api/v1/lite/invoices', headers, payload: { reason: 'test', invoice: invoice('1', { amount: 200, items: line(200) }) } });
    const kept = (await app.inject({ method: 'GET', url: '/api/v1/lite/invoices/1', headers })).json();
    assert.equal(kept.amount, 200);
    assert.deepEqual(kept.layout, layout);

    // Switching the default of a kind replaces it.
    const other = (await app.inject({ method: 'POST', url: '/api/v1/lite/document-templates', headers,
      payload: { template: { kind: 'invoice', name: 'Modern', body: createDefaultTemplateBody('invoice') } } })).json();
    await app.inject({ method: 'PUT', url: '/api/v1/lite/document-templates/defaults', headers, payload: { kind: 'invoice', templateId: other.id } });
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/v1/lite/document-templates/defaults', headers })).json(), { invoice: other.id });
    await app.inject({ method: 'PUT', url: '/api/v1/lite/document-templates/defaults', headers, payload: { kind: 'invoice', templateId: v1.id } });

    const context = await app.inject({ method: 'GET', url: '/api/v1/lite/documents/invoice/1/render-context', headers });
    assert.equal(context.statusCode, 200, context.body);
    assert.equal(context.json().templateKind, 'invoice');
    assert.equal(context.json().template.version, 2);
    assert.equal(context.json().template.body.accentColor, '#aa0000');
    assert.equal(context.json().settings.company.name, 'Holzwerk Brandt');

    // A credit note resolves its own kind (preset fallback) and names its source invoice.
    await app.inject({ method: 'POST', url: '/api/v1/lite/invoices', headers,
      payload: { reason: 'test', invoice: invoice('2', { documentKind: 'credit_note', sourceDocumentId: '1', layout: { templateId: v1.id } }) } });
    const credit = (await app.inject({ method: 'GET', url: '/api/v1/lite/documents/invoice/2/render-context', headers })).json();
    assert.equal(credit.templateKind, 'credit_note');
    assert.equal(credit.template.id, undefined, 'an invoice template is never used for a credit note');
    assert.deepEqual(credit.template.body, createDefaultTemplateBody('credit_note'));
    assert.deepEqual(credit.source, { number: 'RE-1', date: '2026-09-24', documentKind: 'invoice' });

    // Deleting the template clears the default and falls back to the preset; the version stays readable.
    await app.inject({ method: 'DELETE', url: `/api/v1/lite/document-templates/${v1.id}`, headers });
    const fallback = (await app.inject({ method: 'GET', url: '/api/v1/lite/documents/invoice/1/render-context', headers })).json();
    assert.deepEqual(fallback.template, { body: createDefaultTemplateBody('invoice') });
    // The deleted id stays with this tenant: its versions still belong here.
    await database.query(`INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at) VALUES ('another-tenant', 'another', 'Another', 'lite', $1, $1)`, [now]);
    await database.query(
      `INSERT INTO document_template_versions (template_id, version, tenant_id, kind, body_json, created_at) VALUES ('foreign-deleted', 1, 'another-tenant', 'invoice', '{}', $1)`,
      [now],
    );
    const takeover = await app.inject({ method: 'POST', url: '/api/v1/lite/document-templates', headers,
      payload: { template: { id: 'foreign-deleted', kind: 'invoice', name: 'Übernahme', body } } });
    assert.equal(takeover.statusCode, 409, takeover.body);
    const versions = await database.query('SELECT version FROM document_template_versions WHERE template_id = $1 ORDER BY version', [v1.id]);
    assert.deepEqual(versions.rows.map((row) => Number(row.version)), [1, 2]);

    // Issuing freezes template version and sender; later template and company changes do not reach it.
    const current = (await app.inject({ method: 'POST', url: '/api/v1/lite/document-templates', headers,
      payload: { template: { kind: 'invoice', name: 'Ausgestellt', body: { ...body, accentColor: '#123456' } } } })).json();
    await app.inject({ method: 'POST', url: '/api/v1/lite/invoices', headers,
      payload: { reason: 'test', invoice: invoice('3', { status: 'open', layout: { templateId: current.id, snapshot: {
        templateId: 'forged', templateVersion: 9, sender: { company: { name: 'Gefälscht' } }, frozenAt: now,
      } } }) } });
    const issued = (await app.inject({ method: 'GET', url: '/api/v1/lite/invoices/3', headers })).json();
    assert.equal(issued.layout.snapshot.templateId, current.id, 'a sent snapshot is ignored');
    assert.equal(issued.layout.snapshot.templateVersion, 1);
    assert.equal(issued.layout.snapshot.sender.company.name, 'Holzwerk Brandt');
    await app.inject({ method: 'POST', url: '/api/v1/lite/document-templates', headers,
      payload: { template: { id: current.id, kind: 'invoice', name: 'Ausgestellt', body: { ...body, accentColor: '#654321' } } } });
    await app.inject({ method: 'PUT', url: '/api/v1/lite/settings', headers,
      payload: { settings: { ...settings, company: { ...settings.company, name: 'Holzwerk Neu' } } } });
    // A later writer without layout cannot touch the issued invoice at all; the frozen snapshot stays.
    const staleUpdate = await app.inject({ method: 'POST', url: '/api/v1/lite/invoices', headers, payload: { reason: 'test', invoice: invoice('3', { number: issued.number, status: 'paid' }) } });
    assert.equal(staleUpdate.statusCode, 409, staleUpdate.body);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/v1/lite/invoices/3', headers })).json().layout, issued.layout);
    const payment = await app.inject({ method: 'POST', url: '/api/v1/lite/invoices/3/payments', headers, payload: { payment: { id: 'template-payment', date: '2026-09-25', amount: 100, method: 'Bank' }, reason: 'Payment preserves frozen template' } });
    assert.equal(payment.statusCode, 200, payment.body);
    const frozen = (await app.inject({ method: 'GET', url: '/api/v1/lite/documents/invoice/3/render-context', headers })).json();
    assert.equal(frozen.template.version, 1);
    assert.equal(frozen.template.body.accentColor, '#123456');
    assert.equal(frozen.settings.company.name, 'Holzwerk Brandt');
    assert.equal(frozen.document.status, 'paid');

    // Without any template the preset is frozen through the version log, once per preset body.
    await app.inject({ method: 'PUT', url: '/api/v1/lite/document-templates/defaults', headers, payload: { kind: 'invoice', templateId: null } });
    await app.inject({ method: 'POST', url: '/api/v1/lite/invoices', headers, payload: { reason: 'test', invoice: invoice('4', { status: 'open' }) } });
    await app.inject({ method: 'POST', url: '/api/v1/lite/invoices', headers, payload: { reason: 'test', invoice: invoice('5', { status: 'open' }) } });
    const presetFrozen = (await app.inject({ method: 'GET', url: '/api/v1/lite/invoices/5', headers })).json();
    assert.equal(presetFrozen.layout.snapshot.templateId, `preset-${tenantId}-invoice`);
    assert.equal(presetFrozen.layout.snapshot.templateVersion, 1);
    const presetContext = (await app.inject({ method: 'GET', url: '/api/v1/lite/documents/invoice/5/render-context', headers })).json();
    assert.deepEqual(presetContext.template.body, createDefaultTemplateBody('invoice'));
    assert.equal(presetContext.settings.company.name, 'Holzwerk Neu');
    const templatesAfter = (await app.inject({ method: 'GET', url: '/api/v1/lite/document-templates', headers })).json();
    assert.ok(!templatesAfter.some((template: { id: string }) => template.id.startsWith('preset-')), 'presets stay out of the template list');

    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/lite/documents/offer/1/render-context', headers })).statusCode, 404);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
