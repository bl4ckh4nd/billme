import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SonderbuchungenWorkspace from './SonderbuchungenWorkspace';

const correctionFacts = {
  id: 'correction-1',
  idempotencyKey: 'correction-1:1',
  correctionDate: '2026-08-14',
  taxEffectiveDate: '2026-08-14',
  original: {
    documentId: 'invoice-1', documentNumber: 'RE-1', revision: 'revision-1', snapshotHash: 'snapshot-1',
    taxEffectiveDate: '2026-08-14', taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }],
  },
  deltas: [{ rate: 19, grossAmount: 11.9 }],
};

const valid = () => {
  const postAccountingCommand = vi.fn(async () => ({ status: 'posted' as const, errors: [], idempotencyKey: 'k', sourceRun: { id: 'run-1', sourceType: 'standalone_source', sourceId: 'beleg-1', sourceRevision: '1', status: 'posted' as const, createdAt: new Date().toISOString() } }));
  return { postAccountingCommand, listAccountingSourceRuns: vi.fn(async () => []) };
};

const fill = () => {
  fireEvent.change(screen.getByLabelText('Domain-Fakten (JSON)'), { target: { value: JSON.stringify(correctionFacts) } });
  fireEvent.change(screen.getByLabelText('Audit-Grund'), { target: { value: 'Beleg geprüft' } });
};

describe('SonderbuchungenWorkspace', () => {
  afterEach(() => cleanup());

  it('blocks malformed JSON and missing facts before adapter', async () => {
    const adapter = valid();
    render(<SonderbuchungenWorkspace dataAdapter={adapter} />);
    fireEvent.change(screen.getByLabelText('Domain-Fakten (JSON)'), { target: { value: '{' } });
    fireEvent.change(screen.getByLabelText('Audit-Grund'), { target: { value: 'Prüfung' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sonderbuchung speichern' }));
    expect((await screen.findByRole('alert')).textContent).toContain('gültiges JSON');
    expect(adapter.postAccountingCommand).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Domain-Fakten (JSON)'), { target: { value: '{}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sonderbuchung speichern' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Domain-Fakten fehlen');
    expect(adapter.postAccountingCommand).not.toHaveBeenCalled();
  });

  it('prevents double submit and refetches authoritative history', async () => {
    let resolve: ((value: any) => void) | undefined;
    const adapter = valid();
    adapter.postAccountingCommand.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    render(<SonderbuchungenWorkspace dataAdapter={adapter} />);
    fill();
    const submit = screen.getByRole('button', { name: 'Sonderbuchung speichern' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(adapter.postAccountingCommand).toHaveBeenCalledTimes(1);
    resolve?.({ status: 'posted', errors: [], idempotencyKey: 'k', sourceRun: { id: 'run-1', sourceType: 'standalone_source', sourceId: 'beleg-1', sourceRevision: '1', status: 'posted', createdAt: new Date().toISOString() } });
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/refetched/));
  });

  it('posts selected workflow facts without generic journal lines', async () => {
    const adapter = valid();
    render(<SonderbuchungenWorkspace dataAdapter={adapter} />);
    fireEvent.change(screen.getByLabelText('Workflow'), { target: { value: 'fiscal_close' } });
    fireEvent.change(screen.getByLabelText('Audit-Grund'), { target: { value: 'Abschluss geprüft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sonderbuchung speichern' }));
    await waitFor(() => expect(adapter.postAccountingCommand).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fiscal_close', domainFacts: expect.any(Object), source: expect.objectContaining({ lines: [] }) })));
  });

  it('templates explicit settlement accounts by workflow direction', () => {
    const adapter = valid();
    render(<SonderbuchungenWorkspace dataAdapter={adapter} />);
    fireEvent.change(screen.getByLabelText('Workflow'), { target: { value: 'bad_debt' } });
    expect(JSON.parse((screen.getByLabelText('Domain-Fakten (JSON)') as HTMLTextAreaElement).value)).toMatchObject({ badDebtExpenseAccount: '2400' });
    fireEvent.change(screen.getByLabelText('Workflow'), { target: { value: 'advance_settlement' } });
    expect(JSON.parse((screen.getByLabelText('Domain-Fakten (JSON)') as HTMLTextAreaElement).value)).toMatchObject({ advanceClearingReceivable: '1593', advanceClearingPayable: '1518' });
  });

  it('re-syncs source context when source and date change after selecting a workflow', async () => {
    const adapter = valid();
    render(<SonderbuchungenWorkspace dataAdapter={adapter} />);
    fireEvent.change(screen.getByLabelText('Workflow'), { target: { value: 'fiscal_close' } });
    fireEvent.change(screen.getByLabelText('Quellbeleg'), { target: { value: 'close-2025' } });
    fireEvent.change(screen.getByLabelText('Buchungsdatum'), { target: { value: '2025-12-31' } });

    const facts = JSON.parse((screen.getByLabelText('Domain-Fakten (JSON)') as HTMLTextAreaElement).value) as Record<string, unknown>;
    expect(facts).toMatchObject({ sourceId: 'close-2025', date: '2025-12-31', period: '2025-12', fiscalYear: 2025, closingDate: '2025-12-31' });

    fireEvent.change(screen.getByLabelText('Audit-Grund'), { target: { value: 'Abschluss geprüft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sonderbuchung speichern' }));
    await waitFor(() => expect(adapter.postAccountingCommand).toHaveBeenCalledWith(expect.objectContaining({
      domainFacts: expect.objectContaining({ sourceId: 'close-2025', date: '2025-12-31', period: '2025-12', fiscalYear: 2025, closingDate: '2025-12-31' }),
      source: expect.objectContaining({ sourceId: 'close-2025', effectiveDate: '2025-12-31', period: '2025-12', fiscalYear: 2025 }),
    })));
  });

  it('keeps entered facts after adapter failure and exposes the error', async () => {
    const adapter = valid();
    adapter.postAccountingCommand.mockRejectedValueOnce(new Error('Backend nicht erreichbar'));
    render(<SonderbuchungenWorkspace dataAdapter={adapter} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Sonderbuchung speichern' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Backend nicht erreichbar');
    expect((screen.getByLabelText('Domain-Fakten (JSON)') as HTMLTextAreaElement).value).toContain('correction-1');
  });

  it('fails closed when tax preparation provider is unavailable', async () => {
    const adapter = { postAccountingCommand: vi.fn() };
    render(<SonderbuchungenWorkspace dataAdapter={adapter} />);
    expect(screen.getAllByText(/Provider nicht verfügbar/).length).toBeGreaterThan(0);
    expect((screen.getByRole('button', { name: 'Vorbereitung erstellen' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
