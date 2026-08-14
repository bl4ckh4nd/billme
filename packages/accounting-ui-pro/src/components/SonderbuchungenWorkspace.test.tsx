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
  const postAccountingCommand = vi.fn(async () => ({ status: 'posted' as const, errors: [], idempotencyKey: 'k', sourceRun: { id: 'run-1', sourceType: 'standalone_source', sourceId: 'beleg-1', sourceRevision: '1', status: 'posted' as const, journalEntryId: 'journal-1', createdAt: new Date().toISOString() } }));
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
    expect((await screen.findByRole('alert')).textContent).toContain('gültiges JSON');
    expect(adapter.postAccountingCommand).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Domain-Fakten (JSON)'), { target: { value: '{}' } });
    expect((await screen.findByRole('alert')).textContent).toContain('Domain-Fakten fehlen');
    expect(adapter.postAccountingCommand).not.toHaveBeenCalled();
  });

  it('prevents double submit and refetches authoritative history', async () => {
    let resolve: ((value: any) => void) | undefined;
    const adapter = valid();
    adapter.postAccountingCommand.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    render(<SonderbuchungenWorkspace dataAdapter={adapter} />);
    fill();
    const submit = screen.getByRole('button', { name: 'Prüfen & verbindlich buchen' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(adapter.postAccountingCommand).toHaveBeenCalledTimes(1);
    resolve?.({ status: 'posted', errors: [], idempotencyKey: 'k', sourceRun: { id: 'run-1', sourceType: 'standalone_source', sourceId: 'beleg-1', sourceRevision: '1', status: 'posted', journalEntryId: 'journal-1', createdAt: new Date().toISOString() } });
    await waitFor(() => expect(screen.getByText('Sonderbuchung wurde erfolgreich gebucht.')).toBeTruthy());
  });

  it('posts selected workflow facts without generic journal lines', async () => {
    const adapter = valid();
    render(<SonderbuchungenWorkspace dataAdapter={adapter} />);
    fireEvent.change(screen.getByLabelText('Workflow'), { target: { value: 'fiscal_close' } });
    fireEvent.change(screen.getByLabelText('Audit-Grund'), { target: { value: 'Abschluss geprüft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen & verbindlich buchen' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen & verbindlich buchen' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen & verbindlich buchen' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Backend nicht erreichbar');
    expect((screen.getByLabelText('Domain-Fakten (JSON)') as HTMLTextAreaElement).value).toContain('correction-1');
  });

  it('fails closed when tax preparation provider is unavailable', async () => {
    const adapter = { postAccountingCommand: vi.fn() };
    render(<SonderbuchungenWorkspace dataAdapter={adapter} />);
    expect(screen.getAllByText(/Provider nicht verfügbar/).length).toBeGreaterThan(0);
    expect((screen.getByRole('button', { name: 'Vorbereitung erstellen' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('guides users through grouped workflows and keeps expert facts collapsed', () => {
    render(<SonderbuchungenWorkspace dataAdapter={valid()} />);
    expect(screen.getByRole('list', { name: 'Buchungsablauf' }).textContent).toContain('Prüfen & buchen');
    expect(screen.getByRole('group', { name: 'Abschluss' })).toBeTruthy();
    expect(screen.getByText('Fachdaten für Experten bearbeiten').closest('details')?.open).toBe(false);
    expect((screen.getByRole('button', { name: 'Prüfen & verbindlich buchen' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not claim a successful booking for noop, conflicts, or missing journal evidence', async () => {
    const adapter = valid();
    adapter.postAccountingCommand.mockResolvedValueOnce({ status: 'noop', errors: [], idempotencyKey: 'k' });
    render(<SonderbuchungenWorkspace dataAdapter={adapter} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen & verbindlich buchen' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Keine Buchung vorgenommen');
    expect(screen.queryByText('Sonderbuchung wurde erfolgreich gebucht.')).toBeNull();

    cleanup();
    const rejectedAdapter = valid();
    rejectedAdapter.postAccountingCommand.mockResolvedValueOnce({ status: 'rejected', errors: [], idempotencyKey: 'k' });
    render(<SonderbuchungenWorkspace dataAdapter={rejectedAdapter} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen & verbindlich buchen' }));
    expect((await screen.findByText(/Buchung abgelehnt/)).textContent).toContain('Buchung abgelehnt');
    expect(screen.queryByText('Sonderbuchung wurde erfolgreich gebucht.')).toBeNull();

    cleanup();
    const conflictAdapter = valid();
    conflictAdapter.postAccountingCommand.mockRejectedValueOnce(new Error('ACCOUNTING_SOURCE_RUN_CONFLICT'));
    render(<SonderbuchungenWorkspace dataAdapter={conflictAdapter} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen & verbindlich buchen' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Konflikt.*Quellbeleg/);
    expect(screen.queryByText('Sonderbuchung wurde erfolgreich gebucht.')).toBeNull();

    cleanup();
    const noJournalAdapter = valid();
    noJournalAdapter.postAccountingCommand.mockResolvedValueOnce({ status: 'posted', errors: [], idempotencyKey: 'k', sourceRun: { id: 'run-1', sourceType: 'standalone_source', sourceId: 'beleg-1', sourceRevision: '1', status: 'posted', createdAt: new Date().toISOString() } });
    render(<SonderbuchungenWorkspace dataAdapter={noJournalAdapter} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen & verbindlich buchen' }));
    expect((await screen.findByRole('alert')).textContent).toContain('keine Journal-ID');
    expect(screen.queryByText('Sonderbuchung wurde erfolgreich gebucht.')).toBeNull();
  });

  it('clears stale tax artifacts, uses the supported 2025 period, and labels empty filings', async () => {
    const artifact = { kind: 'ustva' as const, status: 'prepared' as const, submissionReady: false as const, providerValidation: 'unavailable' as const, exportable: true as const, rows: [{ kennziffer: '81' }] };
    const adapter = {
      prepareTaxExport: vi.fn()
        .mockResolvedValueOnce({ artifact, run: { id: 'tax-run-1' } })
        .mockRejectedValueOnce(new Error('Tax provider unavailable')),
      listAccountingSourceRuns: vi.fn(async () => []),
    };
    render(<SonderbuchungenWorkspace dataAdapter={adapter} />);
    expect((screen.getByLabelText('Steuerzeitraum') as HTMLInputElement).value).toBe('2025-01');
    fireEvent.change(screen.getByLabelText('Audit-Grund Steuerexport'), { target: { value: 'Prüfung' } });
    fireEvent.click(screen.getByRole('button', { name: 'Vorbereitung erstellen' }));
    await screen.findByText(/UStVA vorbereitet/);

    fireEvent.change(screen.getByLabelText('Steuervorbereitung'), { target: { value: 'zm' } });
    expect(screen.queryByText(/UStVA vorbereitet/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Vorbereitung erstellen' }));
    expect(screen.queryByText(/ZM vorbereitet/)).toBeNull();
    expect((await screen.findByText('Tax provider unavailable')).textContent).toContain('Tax provider unavailable');

    cleanup();
    const emptyAdapter = {
      prepareTaxExport: vi.fn(async () => ({ artifact: { ...artifact, rows: [] }, run: { id: 'tax-run-empty' } })),
    };
    render(<SonderbuchungenWorkspace dataAdapter={emptyAdapter} />);
    fireEvent.change(screen.getByLabelText('Audit-Grund Steuerexport'), { target: { value: 'Prüfung' } });
    fireEvent.click(screen.getByRole('button', { name: 'Vorbereitung erstellen' }));
    expect((await screen.findByText(/Keine meldepflichtigen Vorgänge/)).textContent).toContain('Keine meldepflichtigen Vorgänge');
  });

  it('shows a retryable history error instead of an empty history', async () => {
    const listAccountingSourceRuns = vi.fn()
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValueOnce([]);
    render(<SonderbuchungenWorkspace dataAdapter={{ listAccountingSourceRuns }} />);
    expect((await screen.findByText(/503 Service Unavailable/)).textContent).toContain('503 Service Unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    await waitFor(() => expect(listAccountingSourceRuns).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Noch keine Sonderbuchung vorhanden.')).toBeTruthy();
  });

  it('marks required fields invalid with German inline guidance', () => {
    render(<SonderbuchungenWorkspace dataAdapter={valid()} />);
    const reason = screen.getByLabelText('Audit-Grund');
    expect(reason.getAttribute('required')).not.toBeNull();
    expect(reason.getAttribute('aria-invalid')).toBe('true');
    expect(reason.getAttribute('aria-describedby')).toBe('audit-reason-error');
    expect(screen.getAllByText('Audit-Grund ist erforderlich.').length).toBeGreaterThan(0);
  });
});
