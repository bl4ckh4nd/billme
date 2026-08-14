import { describe, expect, it } from 'vitest';
import type { AccountingSourceFact, AccountingSourceRun } from './sourceRuns';

const shareholderFlowRun: AccountingSourceRun = {
  id: 'run-shareholder-flow',
  sourceType: 'shareholder_flow',
  sourceId: 'flow-1',
  sourceRevision: '1',
  status: 'noop',
  fact: {
    sourceType: 'shareholder_flow',
    sourceId: 'flow-1',
    sourceRevision: '1',
    effectiveDate: '2026-08-14',
    postingDate: '2026-08-14',
    period: '2026-08',
    fiscalYear: 2026,
    currency: 'EUR',
    bookingText: 'Gesellschaftervorgang',
    lines: [],
  } satisfies AccountingSourceFact,
  createdAt: '2026-08-14T10:00:00.000Z',
};

describe('accounting source runs', () => {
  it('accepts shareholder flow facts emitted by the Pro IPC contract', () => {
    expect(shareholderFlowRun.fact?.sourceType).toBe('shareholder_flow');
  });
});
