import assert from 'node:assert/strict';
import test from 'node:test';
import { createSingleTenantScope } from '@billme/server-core';
import { claimTaxSubmissionJob } from './taxSubmission.js';
import type { PostgresQueryable } from './connection.js';

test('claimTaxSubmissionJob uses one SKIP LOCKED UPDATE so two workers cannot claim one job', async () => {
  let sql = '';
  const db = {
    async query(statement: string) {
      sql = statement;
      return {
        rows: [{
          id: 'job-1', tenant_id: 'tenant-1', submission_id: 'filing-1', job_type: 'tax-filing',
          idempotency_key: 'key-1', status: 'running', attempts: 1, available_at: '2026-01-01',
          locked_at: '2026-01-01', completed_at: null, last_error: null, created_at: '2026-01-01', updated_at: '2026-01-01',
        }],
      };
    },
  };
  const claimed = await claimTaxSubmissionJob(db as unknown as PostgresQueryable, createSingleTenantScope('tenant-1', 'pro'), 'tax-filing');
  assert.equal(claimed?.id, 'job-1');
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(sql, /RETURNING/);
  assert.doesNotMatch(sql, /SELECT id FROM tax_submission_jobs[\s\S]*;[\s\S]*UPDATE/);
});
