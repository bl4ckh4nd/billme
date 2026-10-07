import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresPool } from "./connection";
import { runDrizzleMigrations } from "./migrations";
import {
  createPostgresAuditLogPort,
  verifyPostgresAuditChain,
} from "./audit";

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
