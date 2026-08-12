import { describe, expect, it } from 'vitest';
import { getStatusPresentation } from './selectors';
import { BookingWorkflowStatus } from '../types';

describe('workflow status presentation', () => {
  it('uses the shared semantic design tokens for every workflow status', () => {
    const statuses: BookingWorkflowStatus[] = [
      'imported',
      'suggested',
      'incomplete',
      'ready_for_review',
      'pending_approval',
      'approved',
      'posted',
      'reversed',
      'corrected',
      'period_locked',
      'integration_error',
    ];

    for (const status of statuses) {
      const className = getStatusPresentation(status).className;
      expect(className).toMatch(/^(bg-(?:surface-muted|info-bg|warning-bg|success-bg|error-bg) text-(?:muted|info|warning|success|error))$/);
      expect(className).not.toMatch(/(?:gray|blue|amber|indigo|violet|cyan|emerald|rose|orange|red)-/);
    }
  });
});
