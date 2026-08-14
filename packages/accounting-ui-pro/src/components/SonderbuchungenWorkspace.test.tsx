import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SonderbuchungenWorkspace from './SonderbuchungenWorkspace';

const valid = () => {
  const postAccountingCommand = vi.fn(async () => ({ status: 'posted' as const, errors: [], idempotencyKey: 'k', sourceRun: { id: 'run-1', sourceType: 'standalone_source', sourceId: 'beleg-1', sourceRevision: '1', status: 'posted' as const, createdAt: new Date().toISOString() } }));
  return { postAccountingCommand, listAccountingSourceRuns: vi.fn(async () => []) };
};

const fill = () => {
  fireEvent.change(screen.getByLabelText('Betrag'), { target: { value: '10' } });
  fireEvent.change(screen.getByLabelText('Sollkonto'), { target: { value: '4900' } });
  fireEvent.change(screen.getByLabelText('Habenkonto'), { target: { value: '1200' } });
  fireEvent.change(screen.getByLabelText('Buchungstext'), { target: { value: 'Korrektur' } });
  fireEvent.change(screen.getByLabelText('Audit-Grund'), { target: { value: 'Beleg geprüft' } });
};

describe('SonderbuchungenWorkspace', () => {
  afterEach(() => cleanup());
  it('blocks invalid amount/date and missing reason before adapter', async () => {
    const adapter = valid();
    render(<SonderbuchungenWorkspace dataAdapter={adapter} />);
    fireEvent.change(screen.getByLabelText('Buchungsdatum'), { target: { value: '2026-02-30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sonderbuchung speichern' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Betrag muss größer/);
    expect(alert.textContent).toMatch(/gültiges ISO-Datum/);
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

  it('posts the selected workflow as the typed command kind', async () => {
    const adapter = valid();
    render(<SonderbuchungenWorkspace dataAdapter={adapter} />);
    fill();
    fireEvent.change(screen.getByLabelText('Workflow'), { target: { value: 'fiscal_close' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sonderbuchung speichern' }));
    await waitFor(() => expect(adapter.postAccountingCommand).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fiscal_close' })));
  });

  it('keeps entered facts after adapter failure and exposes the error', async () => {
    const adapter = valid();
    adapter.postAccountingCommand.mockRejectedValueOnce(new Error('Backend nicht erreichbar'));
    render(<SonderbuchungenWorkspace dataAdapter={adapter} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Sonderbuchung speichern' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Backend nicht erreichbar');
    expect((screen.getByLabelText('Buchungstext') as HTMLInputElement).value).toBe('Korrektur');
  });

  it('fails closed when tax preparation provider is unavailable', async () => {
    const adapter = { postAccountingCommand: vi.fn() };
    render(<SonderbuchungenWorkspace dataAdapter={adapter} />);
    expect(screen.getAllByText(/Provider nicht verfügbar/).length).toBeGreaterThan(0);
    expect((screen.getByRole('button', { name: 'Vorbereitung erstellen' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
