import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackProvider } from '@billme/ui';
import type { DocumentTemplate } from '@billme/desktop-designer';
import { InvoiceEditor as LiteEditor } from '../../../../apps/desktop/components/InvoiceEditor';
import { InvoiceEditor as ProEditor } from '../../../../apps/pro-desktop/components/InvoiceEditor';

const api = vi.hoisted(() => ({ active: vi.fn(), upsert: vi.fn(), setActive: vi.fn() }));
vi.mock('../runtime-api', () => ({ ipc: { templates: api } }));
// Geometry/dragging is covered by the designer; keep its state, controls and persistence real.
vi.mock('../../../desktop-designer/src/CanvasStage', () => ({
  CanvasStage: ({ elements, onCommitText }: { elements: DocumentTemplate['elements']; onCommitText: (id: string, text: string) => void }) => (
    <div>{elements.map((element) => <input key={element.id} aria-label={`Canvas ${element.id}`} value={element.content ?? ''} onChange={(event) => onCommitText(element.id, event.target.value)} />)}</div>
  ),
}));

let active: DocumentTemplate | null;
let stored: DocumentTemplate;
const template = (kind: 'invoice' | 'offer'): DocumentTemplate => ({
  id: `saved-${kind}`, kind, name: 'Meine Vorlage', createdAt: '2020-01-01', updatedAt: '2020-01-01',
  elements: [
    { id: 'sender', type: 'TEXT', label: 'sender_company', content: 'Meine GmbH', x: 0, y: 0, zIndex: 1, style: {} },
    { id: 'recipient', type: 'TEXT', label: 'recipient_block', content: 'Empfänger', x: 0, y: 30, zIndex: 2, style: {} },
    { id: 'date', type: 'TEXT', content: 'Datum', x: 0, y: 60, zIndex: 3, style: {} },
    { id: 'tax', type: 'TEXT', content: '{{invoice.taxExemptionReason}}', x: 0, y: 90, zIndex: 4, style: {} },
  ],
});
beforeEach(() => {
  vi.clearAllMocks();
  api.active.mockImplementation(async () => active);
  api.upsert.mockImplementation(async ({ template: value }) => { stored = value; return value; });
  api.setActive.mockImplementation(async () => { active = stored; return { ok: true }; });
});
afterEach(cleanup);
const mount = (Editor: typeof LiteEditor, kind: 'invoice' | 'offer') => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><FeedbackProvider><Editor templateType={kind} onBack={() => undefined} /></FeedbackProvider></QueryClientProvider>);
};

describe('routed Lite and Pro template editor adapters', () => {
  for (const [product, Editor] of [['lite', LiteEditor], ['pro', ProEditor]] as const) {
    for (const kind of ['invoice', 'offer'] as const) it(`${product} ${kind} loads, edits, undoes, saves then activates and copies`, async () => {
      active = template(kind);
      mount(Editor, kind);
      const input = await screen.findByDisplayValue('Meine Vorlage');
      fireEvent.change(screen.getByLabelText('Canvas sender'), { target: { value: 'Bearbeitet' } });
      fireEvent.click(screen.getByTitle('Rückgängig (Strg+Z)'));
      expect(screen.getByLabelText('Canvas sender')).toHaveValue('Meine GmbH');
      fireEvent.change(input, { target: { value: 'Neue Vorlage' } });
      let finish!: () => void;
      api.upsert.mockImplementationOnce(({ template: value }) => new Promise((resolve) => { finish = () => { stored = value; resolve(value); }; }));
      fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
      await waitFor(() => expect(api.upsert).toHaveBeenCalledTimes(1));
      expect(api.setActive).not.toHaveBeenCalled();
      fireEvent.keyDown(window, { key: 's', ctrlKey: true });
      expect(api.upsert).toHaveBeenCalledTimes(1);
      await act(async () => finish());
      await screen.findByText('Vorlage gespeichert.');
      expect(api.setActive).toHaveBeenCalledWith({ kind, templateId: `saved-${kind}` });
      expect(stored.createdAt).toBe('2020-01-01');
      expect(stored.name).toBe('Neue Vorlage');
      fireEvent.click(screen.getByTitle('Als Kopie speichern'));
      await waitFor(() => expect(api.setActive).toHaveBeenCalledTimes(2));
      expect(stored.id).not.toBe(`saved-${kind}`);
      expect(stored.kind).toBe(kind);
      fireEvent.click(screen.getByTitle('DIN & Pflichtangaben prüfen'));
      if (product === 'pro') expect(screen.getByText('Steuerhinweis / USt-Ausweis fehlt.')).toBeInTheDocument();
      else expect(screen.queryByText(/Steuerblock fehlt/)).not.toBeInTheDocument();
    });
    it(`${product} reports save failure without activating and permits retry`, async () => {
      active = template('invoice');
      mount(Editor, 'invoice');
      await screen.findByDisplayValue('Meine Vorlage');
      api.upsert.mockRejectedValueOnce(new Error('Disk full'));
      fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
      await screen.findByText(/Speichern fehlgeschlagen.*Disk full/);
      expect(api.setActive).not.toHaveBeenCalled();
      expect(screen.getByDisplayValue('Meine Vorlage')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
      await waitFor(() => expect(api.setActive).toHaveBeenCalledTimes(1));
    });
    for (const kind of ['invoice', 'offer'] as const) it(`${product} ${kind} preserves default identity when no active template exists`, async () => {
      active = null;
      mount(Editor, kind);
      await screen.findByDisplayValue(kind === 'offer' ? 'Standard Angebot' : 'Standard Rechnung');
      fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
      await waitFor(() => expect(api.setActive).toHaveBeenCalledTimes(1));
      expect(stored.id).toBe(`default-${kind}`);
      expect(stored.elements.length).toBeGreaterThan(0);
    });
  }
  it('does not allow saving defaults after a load error', async () => {
    api.active.mockRejectedValue(new Error('Offline'));
    mount(LiteEditor, 'invoice');
    await screen.findByText('Vorlage konnte nicht geladen werden.');
    expect(screen.queryByRole('button', { name: 'Speichern' })).not.toBeInTheDocument();
    expect(api.upsert).not.toHaveBeenCalled();
  });
  it('reuses the copy id when persistence succeeds but activation fails', async () => {
    active = template('invoice');
    mount(LiteEditor, 'invoice');
    await screen.findByDisplayValue('Meine Vorlage');
    api.setActive.mockRejectedValueOnce(new Error('Activation failed'));
    fireEvent.click(screen.getByTitle('Als Kopie speichern'));
    await screen.findByText(/Speichern fehlgeschlagen.*Activation failed/);
    const copyId = stored.id;
    expect(copyId).not.toBe('saved-invoice');
    fireEvent.click(screen.getByTitle('Als Kopie speichern'));
    await screen.findByText('Vorlage gespeichert.');
    expect(stored.id).toBe(copyId);
    expect(api.upsert.mock.calls.map(([args]) => args.template.id)).toEqual([copyId, copyId]);
    expect(api.setActive).toHaveBeenLastCalledWith({ kind: 'invoice', templateId: copyId });
  });
});
