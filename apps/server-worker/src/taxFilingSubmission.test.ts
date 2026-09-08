import test from 'node:test';
import assert from 'node:assert/strict';
import { submitQueuedTaxFilings } from './taxFilingSubmission.js';

test('tax filing worker submits only queued filings and preserves retryable failure', async () => {
  const calls: string[] = [];
  const jobs = [{ id: 'job-1', submissionId: 'queued' }];
  const service = {
    async submit(_scope: unknown, id: string) {
      calls.push(id);
      return { id, status: 'retryable_failed' } as never;
    },
  } as never;
  const result = await submitQueuedTaxFilings({
    scope: { tenantId: 'tenant-1', product: 'pro', deploymentMode: 'single-tenant' },
    service,
    jobs: {
      async claim() { return jobs.shift() ?? null; },
      async complete() {},
      async fail() {},
    },
  });
  assert.deepEqual(result, { queued: 1, processed: 1, accepted: 0, rejected: 0, retryableFailed: 1 });
  assert.deepEqual(calls, ['queued']);
});
