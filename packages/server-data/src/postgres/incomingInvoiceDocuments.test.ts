import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { PgliteServerDatabase } from '../pglite/database.js';
import { createSingleTenantScope } from '@billme/server-core';
import { createPostgresProAccountingRepository } from './proAccountingRepository.js';

const seedTenant = async (database: PgliteServerDatabase, tenantId: string, vendorId: string, invoiceId: string) => {
  const now = new Date().toISOString();
  await database.query(`INSERT INTO tenants (id,slug,display_name,product,deployment_mode,status,created_at,updated_at) VALUES ($1,$1,$2,'pro','single-tenant','active',$3,$3)`, [tenantId, tenantId, now]);
  await database.query(`INSERT INTO vendors (id,tenant_id,name,created_at,updated_at) VALUES ($1,$2,'Document vendor',$3,$3)`, [vendorId, tenantId, now]);
  await database.query(`INSERT INTO incoming_invoices (id,tenant_id,vendor_id,number,invoice_date,due_date,net_amount,tax_amount,gross_amount,status,tax_rate,accounting_status,created_at,updated_at) VALUES ($1,$2,$3,$4,'2026-09-01','2026-09-30',100,19,119,'open',19,'unposted',$5,$5)`, [invoiceId, tenantId, vendorId, `ER-${tenantId}`, now]);
};

test('incoming invoice documents persist content and enforce tenant-scoped hash uniqueness', async () => {
  const root = await mkdtemp(join('/tmp', 'billme-incoming-documents-'));
  const database = await PgliteServerDatabase.open(join(root, 'pglite'));
  const repository = createPostgresProAccountingRepository(database);
  const tenantA = 'incoming-doc-tenant-a';
  const tenantB = 'incoming-doc-tenant-b';
  const bytes = new Uint8Array(Buffer.from('%PDF-1.7 incoming test', 'utf8'));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  try {
    await database.migrate();
    await seedTenant(database, tenantA, 'incoming-doc-vendor-a', 'incoming-doc-invoice-a');
    await seedTenant(database, tenantB, 'incoming-doc-vendor-b', 'incoming-doc-invoice-b');
    const saved = await repository.uploadIncomingInvoiceDocument(createSingleTenantScope(tenantA, 'pro'), {
      incomingInvoiceId: 'incoming-doc-invoice-a',
      originalFilename: 'rechnung-september.pdf',
      mimeType: 'application/pdf',
      content: bytes,
      mutation: { reason: 'Originalbeleg archiviert' },
    });
    assert.equal(saved.tenantId, tenantA);
    assert.equal(saved.byteLength, bytes.byteLength);
    assert.equal(saved.sha256, sha256);
    assert.equal(saved.reviewStatus, 'pending');
    assert.equal(saved.journalEntryId, undefined);

    const listed = await repository.listIncomingInvoiceDocuments(createSingleTenantScope(tenantA, 'pro'), 'incoming-doc-invoice-a');
    assert.deepEqual(listed, [saved]);
    const downloaded = await repository.downloadIncomingInvoiceDocument(createSingleTenantScope(tenantA, 'pro'), saved.id);
    assert.deepEqual(Array.from(downloaded.content), Array.from(bytes));
    assert.deepEqual(downloaded.document, saved);

    const reviewed = await repository.reviewIncomingInvoiceDocument(createSingleTenantScope(tenantA, 'pro'), {
      documentId: saved.id,
      reviewStatus: 'accepted',
      mutation: { reason: 'Original geprüft' },
    });
    assert.equal(reviewed.reviewStatus, 'accepted');
    const reviewAudit = await database.query<{ reason: string }>(`SELECT reason FROM audit_log WHERE tenant_id=$1 AND entity_id=$2 AND action='review'`, [tenantA, saved.id]);
    assert.equal(reviewAudit.rows[0]?.reason, 'Original geprüft');

    await assert.rejects(
      () => repository.uploadIncomingInvoiceDocument(createSingleTenantScope(tenantA, 'pro'), {
        incomingInvoiceId: 'incoming-doc-invoice-a', originalFilename: 'mismatch.png', mimeType: 'image/png', content: bytes,
        mutation: { reason: 'MIME geprüft' },
      }),
      /INCOMING_INVOICE_DOCUMENT_CONTENT_MISMATCH/,
    );

    await assert.rejects(
      () => repository.uploadIncomingInvoiceDocument(createSingleTenantScope(tenantA, 'pro'), {
        incomingInvoiceId: 'incoming-doc-invoice-a', originalFilename: 'duplicate.pdf', mimeType: 'application/pdf', content: bytes,
        mutation: { reason: 'Duplikat geprüft' },
      }),
      /INCOMING_INVOICE_DOCUMENT_DUPLICATE/,
    );

    const otherTenant = await repository.uploadIncomingInvoiceDocument(createSingleTenantScope(tenantB, 'pro'), {
      incomingInvoiceId: 'incoming-doc-invoice-b', originalFilename: 'gleiches-pdf.pdf', mimeType: 'application/pdf', content: bytes,
      mutation: { reason: 'Mandantentrennung geprüft' },
    });
    assert.notEqual(otherTenant.tenantId, saved.tenantId);
    await assert.rejects(
      () => repository.downloadIncomingInvoiceDocument(createSingleTenantScope(tenantB, 'pro'), saved.id),
      /INCOMING_INVOICE_DOCUMENT_NOT_FOUND/,
    );
    await assert.rejects(
      () => database.query(`UPDATE incoming_invoice_documents SET original_filename='tampered.pdf' WHERE id=$1`, [saved.id]),
      /incoming invoice documents are immutable/,
    );
    await assert.rejects(
      () => database.query(`DELETE FROM incoming_invoice_documents WHERE id=$1`, [saved.id]),
      /incoming invoice documents are immutable/,
    );
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
