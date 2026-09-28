import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createDefaultTemplateBody } from '@billme/server-core/domain';

const renderContext = vi.hoisted(() => ({
  current: { data: undefined as unknown, isError: false, error: null as unknown },
}));
vi.mock('../hooks/useDocuments', () => ({ useDocumentRenderContextQuery: () => renderContext.current }));
vi.mock('@billme/desktop-designer/flow', () => ({
  DocumentFlowPages: ({ onReady }: { onReady?: (pages: number) => void }) => (
    <button type="button" onClick={() => onReady?.(2)}>layout ready</button>
  ),
}));

import { PrintDocument } from './PrintDocument';

const settings = {
  company: { name: 'Beispiel GmbH', owner: '', street: '', zip: '', city: '', email: '', phone: '', website: '' },
  finance: { bankName: '', iban: '', bic: '', taxId: '', vatId: '', registerCourt: '' },
  legal: { smallBusinessRule: false, defaultVatRate: 19 },
};
const context = (overrides: Record<string, unknown> = {}) => ({
  templateKind: 'invoice',
  template: { body: createDefaultTemplateBody('invoice') },
  settings,
  document: { id: 'invoice-1', number: 'RE-1', client: 'Acme', clientEmail: 'billing@acme.example', date: '2026-08-06', dueDate: '2026-08-20', amount: 0, status: 'draft', items: [], payments: [] },
  ...overrides,
});
const pdf = globalThis as { __PDF_READY__?: boolean; __PDF_ERROR__?: string; __PDF_PAGES__?: number };

describe('PrintDocument readiness gate', () => {
  it('keeps PDF not-ready until the flow pages report painted layout', async () => {
    renderContext.current = { data: context(), isError: false, error: null };
    pdf.__PDF_READY__ = undefined;
    const user = userEvent.setup();
    render(<PrintDocument kind="invoice" id="invoice-1" />);
    expect(pdf.__PDF_READY__).toBe(false);
    await user.click(screen.getByRole('button', { name: 'layout ready' }));
    expect(pdf.__PDF_READY__).toBe(true);
    expect(pdf.__PDF_PAGES__).toBe(2);
  });

  it('reports an error instead of printing without company data', () => {
    renderContext.current = { data: context({ settings: null }), isError: false, error: null };
    render(<PrintDocument kind="invoice" id="invoice-1" />);
    expect(pdf.__PDF_ERROR__).toBe('Ohne Firmen- und Bankdaten wird der Beleg nicht gedruckt.');
    expect(screen.queryByRole('button', { name: 'layout ready' })).not.toBeInTheDocument();
  });

  it('reports a missing document to the exporter', () => {
    renderContext.current = { data: undefined, isError: true, error: new Error('Beleg nicht gefunden.') };
    render(<PrintDocument kind="invoice" id="missing" />);
    expect(pdf.__PDF_ERROR__).toContain('Beleg nicht gefunden.');
  });
});
