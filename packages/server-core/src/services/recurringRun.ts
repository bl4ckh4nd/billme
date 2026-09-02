import type { AuditActor, AuditLogPort, Clock } from '../ports/index.js';
import type { TenantScope } from '../domain/foundations.js';
import type { RecurringDomainDependencies, RecurringResult } from './recurring.js';
import { processRecurringRun } from './recurring.js';

/**
 * The stable result/error seam for scheduled and manual recurring invoice runs.
 * A run either commits all generated invoices and its audit entry, or exposes
 * the result while the transaction has rolled back every mutation.
 */
export class RecurringRunRolledBackError extends Error {
  constructor(readonly result: RecurringResult) {
    super('Recurring run rolled back because one or more profiles failed');
    this.name = 'RecurringRunRolledBackError';
  }
}

export interface RecurringRunFailure {
  readonly result: RecurringResult;
  readonly error: string;
}

/** Stable failure projection shared by HTTP and worker adapters. */
export const toRecurringRunFailure = (error: unknown): RecurringRunFailure | null => {
  if (!(error instanceof RecurringRunRolledBackError)) return null;
  return { result: error.result, error: error.message };
};

export interface RecurringRunOptions {
  readonly auditLog: Pick<AuditLogPort, 'append'>;
  readonly actor: AuditActor;
  readonly reason: string;
  readonly action?: string;
  readonly clock?: Clock;
  /** Runs inside the same transaction, before the run audit entry is appended. */
  readonly afterProcess?: (result: RecurringResult) => Promise<void> | void;
}

export const runRecurringInvoiceRun = async (
  scope: TenantScope,
  dependencies: RecurringDomainDependencies,
  options: RecurringRunOptions,
): Promise<RecurringResult> => dependencies.tx.inTransaction(async () => {
  const result = await processRecurringRun(scope, {
    ...dependencies,
    ...(options.clock ? { clock: options.clock } : {}),
  });

  if (result.errors.length > 0) {
    throw new RecurringRunRolledBackError(result);
  }

  await options.afterProcess?.(result);
  await options.auditLog.append(scope, {
    occurredAt: (options.clock ?? { now: () => new Date() }).now().toISOString(),
    action: options.action ?? 'recurring.run',
    reason: options.reason,
    actor: options.actor,
    subject: {
      entityType: 'tenant',
      entityId: scope.tenantId,
      tenantId: scope.tenantId,
    },
    change: { after: result },
  });

  return result;
});
