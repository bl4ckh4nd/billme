import type { AuditActor, AuditLogPort, Clock } from '../ports/index.js';
import type { TenantScope } from '../domain/foundations.js';
import type { RecurringDomainDependencies, RecurringResult } from './recurring.js';
import { processRecurringRun } from './recurring.js';

export interface RecurringRunOptions {
  readonly auditLog: Pick<AuditLogPort, 'append'>;
  readonly actor: AuditActor;
  readonly reason: string;
  readonly action?: string;
  readonly clock?: Clock;
  /** Runs in the finalization transaction, before the run audit entry is appended. */
  readonly afterProcess?: (result: RecurringResult) => Promise<void> | void;
}

export const runRecurringInvoiceRun = async (
  scope: TenantScope,
  dependencies: RecurringDomainDependencies,
  options: RecurringRunOptions,
): Promise<RecurringResult> => {
  const result = await processRecurringRun(scope, {
    ...dependencies,
    ...(options.clock ? { clock: options.clock } : {}),
  });

  // Profile transactions have already committed independently. Keep settings
  // progression and the summary audit together, while allowing infrastructure
  // failures here to remain visible to the adapter.
  await dependencies.tx.inTransaction(async () => {
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
  });

  return result;
};
