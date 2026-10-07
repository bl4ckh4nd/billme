import assert from "node:assert/strict";
import test from "node:test";
import { createSingleTenantScope } from "@billme/server-core";
import { createPostgresPool } from "./connection.js";
import { runDrizzleMigrations } from "./migrations.js";
import {
  createReportSnapshot,
  listReportAccountMappings,
  saveReportAccountMapping,
} from "./reporting.js";
import {
  approveTaxSubmission,
  claimTaxSubmissionJob,
  completeTaxSubmissionJob,
  createTaxSubmission,
  enqueueTaxSubmissionJob,
  listTaxCredentialMetadata,
  putEncryptedTaxCredential,
  recordTaxSubmissionReceipt,
} from "./taxSubmission.js";

test("reporting and tax submission persistence is tenant-safe and evidence is immutable", { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const pool = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tenantA = `reporting-a-${suffix}`;
  const tenantB = `reporting-b-${suffix}`;
  const now = new Date().toISOString();
  const scopeA = createSingleTenantScope(tenantA, "pro");
  const scopeB = createSingleTenantScope(tenantB, "pro");
  try {
    await runDrizzleMigrations(pool);
    const { rows: taxSubmissionIndexes } = await pool.query<{ indexname: string }>(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'tax_submissions'`,
    );
    assert.ok(taxSubmissionIndexes.some(({ indexname }) => indexname === "ux_tax_submissions_id_tenant"));
    for (const tenant of [tenantA, tenantB]) {
      await pool.query(`INSERT INTO tenants (id,slug,display_name,product,deployment_mode,status,created_at,updated_at) VALUES ($1,$1,$2,'pro','single-tenant','active',$3,$3)`, [tenant, tenant, now]);
    }
    await saveReportAccountMapping(pool, scopeA, { reportType: "guv", chart: "SKR03", accountNumber: "8400", positionKey: "revenue", positionLabel: "Umsatz", version: 1, source: "test", sourceHash: `mapping-${suffix}`, createdBy: "creator" });
    assert.equal((await listReportAccountMappings(pool, scopeB)).length, 0);
    const snapshot = await createReportSnapshot(pool, scopeA, { reportType: "guv", argsJson: "{}", payloadJson: "{\"total\":100}", sourceHash: `snapshot-${suffix}`, positions: [{ positionKey: "revenue", positionLabel: "Umsatz", amount: 100, debitAmount: 0, creditAmount: 100, metadataJson: "{}" }] });
    assert.equal(snapshot.positions[0]?.amount, 100);
    const submission = await createTaxSubmission(pool, scopeA, { submissionType: "ustva", taxYear: 2026, period: "08", payloadJson: "{}", sourceSnapshotId: snapshot.id, idempotencyKey: `submission-${suffix}`, createdBy: "creator" });
    await assert.rejects(() => approveTaxSubmission(pool, scopeA, { submissionId: submission.id, requesterId: "creator", approverId: "creator", decision: "approved", reason: "same user" }), /CREATOR_CANNOT_APPROVE/);
    await approveTaxSubmission(pool, scopeA, { submissionId: submission.id, requesterId: "creator", approverId: "approver", decision: "approved", reason: "reviewed" });
    await recordTaxSubmissionReceipt(pool, scopeA, { submissionId: submission.id, receiptType: "ack", receiptNumber: `receipt-${suffix}`, receiptJson: "{}", receivedAt: now });

    const credential = await putEncryptedTaxCredential(pool, scopeA, { provider: "elster", credentialKey: "org", encryptionAlgorithm: "AES-256-GCM", keyVersion: "v1", metadataJson: "{\"key\":\"redacted\"}", encryptedBlob: new Uint8Array([1, 2, 3]), createdBy: "creator" });
    assert.equal((await listTaxCredentialMetadata(pool, scopeA))[0]?.id, credential.id);
    const job = await enqueueTaxSubmissionJob(pool, scopeA, { submissionId: submission.id, jobType: "submit", idempotencyKey: `job-${suffix}` });
    const claimed = await claimTaxSubmissionJob(pool, scopeA, "submit");
    assert.equal(claimed?.id, job.id);
    await completeTaxSubmissionJob(pool, scopeA, job.id);
    await assert.rejects(() => pool.query(`UPDATE report_snapshots SET payload_json='changed' WHERE tenant_id=$1 AND id=$2`, [tenantA, snapshot.id]), /immutable/);
    await assert.rejects(() => pool.query(`DELETE FROM tax_credentials WHERE tenant_id=$1 AND id=$2`, [tenantA, credential.id]), /immutable/);
  } finally {
    await pool.query(`DELETE FROM tenants WHERE id = ANY($1::text[])`, [[tenantA, tenantB]]).catch(() => undefined);
    await pool.end();
  }
});
