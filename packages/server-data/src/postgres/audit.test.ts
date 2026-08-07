import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresPool } from "./connection";
import { runDrizzleMigrations } from "./migrations";
import {
  createPostgresAuditLogPort,
  sha256Hex,
  stableStringify,
  verifyAuditChainRows,
  verifyPostgresAuditChain,
} from "./audit";

test("stableStringify keeps object keys deterministic", () => {
  const left = stableStringify({ b: 2, a: 1, nested: { z: true, y: false } });
  const right = stableStringify({ nested: { y: false, z: true }, a: 1, b: 2 });
  assert.equal(left, right);
});

test("verifyAuditChainRows accepts a valid chain", () => {
  const firstPayload = {
    sequence: 1,
    ts: "2026-01-01T00:00:00.000Z",
    entityType: "invoice",
    entityId: "inv-1",
    action: "created",
    reason: null,
    before: null,
    after: { id: "inv-1" },
    prevHash: null,
    actor: "local",
  };
  const firstHash = sha256Hex(`:${stableStringify(firstPayload)}`);
  const secondPayload = {
    sequence: 2,
    ts: "2026-01-02T00:00:00.000Z",
    entityType: "invoice",
    entityId: "inv-1",
    action: "updated",
    reason: null,
    before: { id: "inv-1" },
    after: { id: "inv-1", status: "paid" },
    prevHash: firstHash,
    actor: "local",
  };
  const secondHash = sha256Hex(
    `${firstHash}:${stableStringify(secondPayload)}`,
  );

  const result = verifyAuditChainRows([
    {
      sequence: 1,
      ts: firstPayload.ts,
      entity_type: firstPayload.entityType,
      entity_id: firstPayload.entityId,
      action: firstPayload.action,
      reason: null,
      before_json: null,
      after_json: JSON.stringify(firstPayload.after),
      prev_hash: null,
      hash: firstHash,
      actor: "local",
    },
    {
      sequence: 2,
      ts: secondPayload.ts,
      entity_type: secondPayload.entityType,
      entity_id: secondPayload.entityId,
      action: secondPayload.action,
      reason: null,
      before_json: JSON.stringify(secondPayload.before),
      after_json: JSON.stringify(secondPayload.after),
      prev_hash: firstHash,
      hash: secondHash,
      actor: "local",
    },
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.equal(result.headHash, secondHash);
});

test("verifyAuditChainRows reports hash mismatches", () => {
  const result = verifyAuditChainRows([
    {
      sequence: 1,
      ts: "2026-01-01T00:00:00.000Z",
      entity_type: "invoice",
      entity_id: "inv-1",
      action: "created",
      reason: null,
      before_json: null,
      after_json: '{"id":"inv-1"}',
      prev_hash: null,
      hash: "broken",
      actor: "local",
    },
  ]);

  assert.equal(result.ok, false);
  assert.match(result.errors[0]?.message ?? "", /hash mismatch/);
});

const databaseUrl =
  process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

test(
  "createPostgresAuditLogPort persists and verifies a real Postgres chain",
  { skip: !databaseUrl },
  async () => {
    const pool = createPostgresPool(databaseUrl!);
    const tenantId = `audit-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const now = new Date().toISOString();
    await runDrizzleMigrations(pool);
    const client = await pool.connect();
    try {
      // Keep the append-only audit rows inside a rolled-back transaction. A
      // direct DELETE is intentionally rejected by the production trigger.
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'lite', 'single-tenant', 'active', $4, $4)`,
        [tenantId, tenantId, "Audit integration test", now],
      );
      const auditLog = createPostgresAuditLogPort(client);
      const scope = {
        tenantId,
        product: "lite",
        deploymentMode: "single-tenant",
      } as const;
      const entry = {
        occurredAt: now,
        action: "client.create",
        reason: "Regression test",
        actor: { type: "system", displayName: "test-runner" },
        subject: {
          entityType: "client",
          entityId: "client-1",
        },
        change: {
          before: null,
          after: { id: "client-1" },
        },
      } as const;
      const appended = await auditLog.append(scope, entry);
      assert.equal(appended.sequence, 1);

      const listed = await auditLog.listBySubject(scope, entry.subject);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.hash, appended.hash);

      const verified = await verifyPostgresAuditChain(client, tenantId);
      assert.equal(verified.ok, true);
      assert.equal(verified.count, 1);
      assert.equal(verified.headHash, appended.hash);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  },
);
