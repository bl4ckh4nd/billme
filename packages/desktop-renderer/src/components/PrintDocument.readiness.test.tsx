import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../hooks/useSettings', () => ({ useSettingsQuery: () => ({ data: null }) }));
vi.mock('../hooks/useTemplates', () => ({ useActiveTemplateQuery: () => ({ data: { elements: [] } }) }));
vi.mock('../hooks/useInvoices', () => ({ useInvoicesQuery: () => ({ data: [{ id: 'invoice-1', number: 'RE-1', client: 'Acme', clientEmail: 'billing@acme.example', date: '2026-08-06', dueDate: '2026-08-20', amount: 0, status: 'draft', items: [], payments: [] }] }) }));
vi.mock('../hooks/useOffers', () => ({ useOffersQuery: () => ({ data: [] }) }));
vi.mock('@billme/desktop-designer/DocumentPages', () => ({
  DocumentPages: ({ onReady }: { onReady?: () => void }) => <button type="button" onClick={onReady}>layout ready</button>,
}));

import { PrintDocument } from './PrintDocument';

describe('PrintDocument readiness gate', () => {
  it('keeps PDF not-ready until the document pages report painted layout', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    (globalThis as { __PDF_READY__?: boolean }).__PDF_READY__ = undefined;

    render(<PrintDocument kind="invoice" id="invoice-1" />);
    expect((globalThis as { __PDF_READY__?: boolean }).__PDF_READY__).toBe(false);
    await user.click(screen.getByRole('button', { name: 'layout ready' }));
    expect((globalThis as { __PDF_READY__?: boolean }).__PDF_READY__).toBe(true);
  });
});
