import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createTaxFilingRecord, transitionTaxFiling } from "@billme/accounting-engine";
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
import { createPostgresTaxFilingRepository } from "./taxFilingRepository.js";

test("reporting and filing migration is additive, tenant-scoped, and guarded", async () => {
  const sql = await readFile(new URL("../../drizzle/0015_server_data_reporting_tax_submissions.sql", import.meta.url), "utf8");
  for (const table of [
    "report_snapshot_positions", "report_account_mappings", "report_catalog_refs", "tax_adjustments",
    "tax_submissions", "tax_submission_approvals", "tax_submission_receipts", "tax_credentials", "tax_submission_jobs",
  ]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`), table);
  for (const trigger of [
    "report_snapshots_immutable", "report_snapshot_positions_immutable", "report_catalog_refs_immutable",
    "tax_submission_approvals_immutable", "tax_submission_receipts_immutable", "tax_credentials_immutable",
  ]) assert.match(sql, new RegExp(trigger), trigger);
  assert.match(sql, /CHECK \(requester_id <> approver_id\)/);
  assert.match(sql, /ux_report_snapshots_source/);
  assert.match(sql, /ux_tax_submissions_idempotency/);
  assert.match(sql, /ux_tax_submission_jobs_idempotency/);
});

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

    const filingRepository = createPostgresTaxFilingRepository(pool);
    let filing = createTaxFilingRecord({
      id: `filing-${suffix}`,
      tenantId: tenantA,
      provider: "eric_e_bilanz",
      snapshot: {
        kind: "e_bilanz",
        periodStart: "2025-01-01",
        periodEnd: "2025-12-31",
        payload: {
          taxYear: 2025,
          taxonomy: "6.9",
          facts: [{ key: "revenue", value: 100 }],
          reportSnapshotId: "filing-report",
          sourceSnapshotHash: "a".repeat(64),
        },
      },
      idempotencyKey: `filing-create-${suffix}`,
      actorId: "creator",
      now,
    });
    filing = await filingRepository.create(scopeA, filing);
    for (const [action, actorId] of [
      ["validate", "creator"],
      ["freeze", "creator"],
      ["request_second_approval", "creator"],
    ] as const) {
      const next = transitionTaxFiling(filing, action, {
        actorId,
        reason: action,
        idempotencyKey: `${action}-${suffix}`,
        now,
      }).record;
      filing = await filingRepository.update(scopeA, next, filing.status);
    }
    const approved = transitionTaxFiling(filing, "approve", {
      actorId: "approver",
      reason: "second review",
      idempotencyKey: `approve-${suffix}`,
      now,
    }).record;
    filing = await filingRepository.recordApproval!(scopeA, {
      id: filing.id,
      record: approved,
      requesterId: "creator",
      approverId: "approver",
      reason: "second review",
      idempotencyKey: `approve-${suffix}`,
      now,
    });
    const approvalRows = await pool.query(
      `SELECT requester_id, approver_id, reason FROM tax_submission_approvals WHERE tenant_id=$1 AND submission_id=$2`,
      [tenantA, filing.id],
    );
    assert.deepEqual(approvalRows.rows, [{ requester_id: "creator", approver_id: "approver", reason: "second review" }]);
    for (const [action, actorId] of [["queue", "approver"], ["transmitting", "worker"]] as const) {
      const next = transitionTaxFiling(filing, action, {
        actorId,
        reason: action,
        idempotencyKey: `${action}-${suffix}`,
        now,
      }).record;
      filing = await filingRepository.update(scopeA, next, filing.status);
    }
    const accepted = transitionTaxFiling(filing, "accept", {
      actorId: "worker",
      reason: "provider accepted",
      idempotencyKey: `accept-${suffix}`,
      now,
    }).record;
    filing = await filingRepository.recordProviderResult!(scopeA, {
      id: filing.id,
      record: accepted,
      result: { status: "accepted", providerReference: `provider-${suffix}` },
      action: "accept",
      actorId: "worker",
      reason: "provider accepted",
      idempotencyKey: `receipt-${suffix}`,
      now,
    });
    assert.equal(filing.status, "accepted");
    const receiptRows = await pool.query(
      `SELECT receipt_type, receipt_number FROM tax_submission_receipts WHERE tenant_id=$1 AND submission_id=$2`,
      [tenantA, filing.id],
    );
    assert.deepEqual(receiptRows.rows, [{ receipt_type: "tax_filing_provider_result", receipt_number: `provider-${suffix}` }]);

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
