import type { TaxFilingRecord } from '@billme/accounting-shared';
import type { TaxFilingService, TenantScope } from '@billme/server-core';

export interface TaxFilingSubmissionBatchResult {
  queued: number;
  processed: number;
  accepted: number;
  rejected: number;
  retryableFailed: number;
}

export const submitQueuedTaxFilings = async (input: {
  scope: TenantScope;
  service: TaxFilingService;
  jobs: {
    claim(scope: TenantScope): Promise<{ id: string; submissionId: string } | null>;
    complete(scope: TenantScope, id: string): Promise<unknown>;
    fail(scope: TenantScope, id: string, error: string): Promise<unknown>;
  };
  limit?: number;
}): Promise<TaxFilingSubmissionBatchResult> => {
  const batch: Array<{ id: string; submissionId: string }> = [];
  for (let index = 0; index < (input.limit ?? 25); index += 1) {
    const job = await input.jobs.claim(input.scope);
    if (!job) break;
    batch.push(job);
  }
  let accepted = 0;
  let rejected = 0;
  let retryableFailed = 0;
  for (const job of batch) {
    try {
      const result: TaxFilingRecord = await input.service.submit(input.scope, job.submissionId, {
      actorId: 'billme-server-worker',
      reason: 'Tax filing transmission worker',
        idempotencyKey: `worker-submit:${job.submissionId}`,
      });
      if (result.status === 'accepted') accepted += 1;
      else if (result.status === 'rejected') rejected += 1;
      else if (result.status === 'retryable_failed') retryableFailed += 1;
      if (result.status === 'retryable_failed') {
        await input.jobs.fail(input.scope, job.id, result.failureMessage ?? result.failureCode ?? 'retryable failure');
      } else {
        await input.jobs.complete(input.scope, job.id);
      }
    } catch (error) {
      retryableFailed += 1;
      await input.jobs.fail(input.scope, job.id, error instanceof Error ? error.message : String(error));
    }
  }
  return {
    queued: batch.length,
    processed: batch.length,
    accepted,
    rejected,
    retryableFailed,
  };
};
