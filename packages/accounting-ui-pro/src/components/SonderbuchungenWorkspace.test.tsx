import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JournalEntryEntity } from '@billme/accounting-shared';
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

const journalEntry: JournalEntryEntity = {
  id: 'journal-1', tenantId: 'tenant-1', entryNumber: 42, postingDate: '2026-08-14', documentDate: '2026-08-14',
  bookingText: 'Sonderbuchung', reference: 'beleg-1', period: '2026-08', fiscalYear: 2026, status: 'posted', sourceType: 'manual',
  createdAt: '2026-08-14T10:00:00.000Z', lines: [
    { id: 'line-1', accountNumber: '4900', debitAmount: 119, creditAmount: 0 },
    { id: 'line-2', accountNumber: '1200', debitAmount: 0, creditAmount: 119 },
  ],
};

const historyWithJournal = {
  id: 'run-1', sourceType: 'standalone_source', sourceId: 'beleg-1', sourceRevision: '1', status: 'posted' as const,
  journalEntryId: 'journal-1', createdAt: '2026-08-14T10:00:00.000Z',
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

  it('replaces a successful booking with the next validation failure', async () => {
    const adapter = valid();
    adapter.postAccountingCommand
      .mockResolvedValueOnce({ status: 'posted', errors: [], idempotencyKey: 'k', sourceRun: { id: 'run-1', sourceType: 'standalone_source', sourceId: 'beleg-1', sourceRevision: '1', status: 'posted', journalEntryId: 'journal-1', createdAt: new Date().toISOString() } })
      .mockResolvedValueOnce({ status: 'rejected', errors: [], idempotencyKey: 'k' });
    render(<SonderbuchungenWorkspace dataAdapter={adapter} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen & verbindlich buchen' }));
    await waitFor(() => expect(screen.getByTestId('sonderbuchungen-feedback').textContent).toBe('Sonderbuchung wurde erfolgreich gebucht.'));

    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen & verbindlich buchen' }));

    const feedback = await screen.findByTestId('sonderbuchungen-feedback');
    expect(screen.getAllByTestId('sonderbuchungen-feedback')).toHaveLength(1);
    expect(feedback.getAttribute('role')).toBe('alert');
    expect(feedback.getAttribute('aria-live')).toBe('assertive');
    expect(feedback.textContent).toContain('Buchung abgelehnt: Der Fachworkflow hat keinen buchbaren Vorgang zurückgegeben.');
  });

  it('keeps a successful booking when the follow-up history refresh fails', async () => {
    const listAccountingSourceRuns = vi.fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('Historie vorübergehend nicht verfügbar'))
      .mockResolvedValueOnce([]);
    const adapter = { ...valid(), listAccountingSourceRuns };
    render(<SonderbuchungenWorkspace dataAdapter={adapter} />);
    await waitFor(() => expect(listAccountingSourceRuns).toHaveBeenCalledTimes(1));
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen & verbindlich buchen' }));

    await waitFor(() => expect(screen.getByText('Sonderbuchung wurde erfolgreich gebucht.')).toBeTruthy());
    expect((screen.getByLabelText('Audit-Grund') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Domain-Fakten (JSON)') as HTMLTextAreaElement).value).not.toContain('correction-1');
    expect(screen.getByText(/Historie vorübergehend nicht verfügbar/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    await waitFor(() => expect(listAccountingSourceRuns).toHaveBeenCalledTimes(3));
    expect(screen.getByText('Sonderbuchung wurde erfolgreich gebucht.')).toBeTruthy();
  });

  it('keeps the post-submit history when the mount request resolves out of order', async () => {
    let resolveMount!: (runs: typeof historyWithJournal[]) => void;
    let resolvePostSubmit!: (runs: typeof historyWithJournal[]) => void;
    const mountRequest = new Promise<typeof historyWithJournal[]>((resolve) => { resolveMount = resolve; });
    const postSubmitRequest = new Promise<typeof historyWithJournal[]>((resolve) => { resolvePostSubmit = resolve; });
    const listAccountingSourceRuns = vi.fn()
      .mockReturnValueOnce(mountRequest)
      .mockReturnValueOnce(postSubmitRequest);
    const adapter = { ...valid(), listAccountingSourceRuns };
    render(<SonderbuchungenWorkspace dataAdapter={adapter} />);
    await waitFor(() => expect(listAccountingSourceRuns).toHaveBeenCalledTimes(1));

    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen & verbindlich buchen' }));
    await waitFor(() => expect(listAccountingSourceRuns).toHaveBeenCalledTimes(2));

    resolvePostSubmit([historyWithJournal]);
    expect(await screen.findByText('beleg-1')).toBeTruthy();
    await act(async () => {
      resolveMount([]);
      await Promise.resolve();
    });
    expect(screen.getByText('beleg-1')).toBeTruthy();
  });

  it('does not surface a stale mount history failure after a post-submit refresh succeeds', async () => {
    let rejectMount!: (error: Error) => void;
    const mountRequest = new Promise<typeof historyWithJournal[]>((_, reject) => { rejectMount = reject; });
    const listAccountingSourceRuns = vi.fn()
      .mockReturnValueOnce(mountRequest)
      .mockResolvedValueOnce([historyWithJournal]);
    const adapter = { ...valid(), listAccountingSourceRuns };
    render(<SonderbuchungenWorkspace dataAdapter={adapter} />);
    await waitFor(() => expect(listAccountingSourceRuns).toHaveBeenCalledTimes(1));

    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen & verbindlich buchen' }));
    expect(await screen.findByText('beleg-1')).toBeTruthy();
    await act(async () => {
      rejectMount(new Error('stale history failure'));
      await Promise.resolve();
    });
    expect(screen.queryByText(/Buchungshistorie konnte nicht geladen werden/)).toBeNull();
  });

  it('posts selected workflow facts without generic journal lines', async () => {
    const adapter = valid();
    render(<SonderbuchungenWorkspace dataAdapter={adapter} />);
    fireEvent.change(screen.getByLabelText('Workflow'), { target: { value: 'fiscal_close' } });
    fireEvent.change(screen.getByLabelText('Audit-Grund'), { target: { value: 'Abschluss geprüft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen & verbindlich buchen' }));
    await waitFor(() => expect(adapter.postAccountingCommand).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fiscal_close', domainFacts: expect.any(Object), source: expect.objectContaining({ lines: [] }) })));
  });

  it('keeps shareholder flows distinct from standalone sources', async () => {
    const adapter = valid();
    render(<SonderbuchungenWorkspace dataAdapter={adapter} />);
    fireEvent.change(screen.getByLabelText('Workflow'), { target: { value: 'shareholder_flow' } });
    fireEvent.change(screen.getByLabelText('Audit-Grund'), { target: { value: 'Gesellschaftervorgang geprüft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen & verbindlich buchen' }));
    await waitFor(() => expect(adapter.postAccountingCommand).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'shareholder_flow',
      source: expect.objectContaining({ sourceType: 'shareholder_flow', lines: [] }),
    })));
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

  it('retains a prepared tax artifact when the follow-up history refresh fails', async () => {
    const artifact = { kind: 'ustva' as const, status: 'prepared' as const, submissionReady: false as const, providerValidation: 'unavailable' as const, exportable: true as const, rows: [{ kennziffer: '81' }] };
    const listAccountingSourceRuns = vi.fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('Historie vorübergehend nicht verfügbar'));
    const adapter = {
      prepareTaxExport: vi.fn(async () => ({ artifact, run: { id: 'tax-run-1' } })),
      listAccountingSourceRuns,
      exportTaxArtifact: vi.fn(async () => new Blob(['{}'], { type: 'application/json' })),
    };
    render(<SonderbuchungenWorkspace dataAdapter={adapter} />);
    await waitFor(() => expect(listAccountingSourceRuns).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('Audit-Grund Steuerexport'), { target: { value: 'Prüfung' } });
    fireEvent.click(screen.getByRole('button', { name: 'Vorbereitung erstellen' }));

    expect(await screen.findByText(/UStVA vorbereitet/)).toBeTruthy();
    expect(screen.getByText(/Historie vorübergehend nicht verfügbar/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Vorbereitungs-Export' })).toBeTruthy();
    expect(screen.queryByText(/Tax provider unavailable/)).toBeNull();
  });

  it('hides Zod and transport details behind a retryable history error', async () => {
    const zodError = new Error('ZodError: [{"code":"invalid_type","path":["source"],"message":"Required"}]');
    zodError.name = 'ZodError';
    const zodDump = '[{"code":"invalid_type","path":["source"],"message":"Required"}]';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const listAccountingSourceRuns = vi.fn()
      .mockRejectedValueOnce(zodError)
      .mockRejectedValueOnce(zodDump)
      .mockResolvedValueOnce([]);
    try {
      render(<SonderbuchungenWorkspace dataAdapter={{ listAccountingSourceRuns }} />);
      const firstError = await screen.findByText('Buchungshistorie konnte nicht geladen werden: Bitte versuchen Sie es erneut.');
      expect(firstError.textContent).toContain('Buchungshistorie konnte nicht geladen werden: Bitte versuchen Sie es erneut.');
      expect(firstError.textContent).not.toContain('ZodError');
      expect(firstError.textContent).not.toContain('invalid_type');
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Buchungshistorie konnte nicht geladen werden'), zodError);

      fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
      const secondError = await screen.findByText('Buchungshistorie konnte nicht geladen werden: Bitte versuchen Sie es erneut.');
      expect(secondError.textContent).not.toContain('invalid_type');
      expect(secondError.textContent).toContain('Bitte versuchen Sie es erneut.');
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Buchungshistorie konnte nicht geladen werden'), zodDump);

      fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
      await waitFor(() => expect(listAccountingSourceRuns).toHaveBeenCalledTimes(3));
      expect(screen.getByText('Noch keine Sonderbuchung vorhanden.')).toBeTruthy();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('marks required fields invalid with German inline guidance', () => {
    render(<SonderbuchungenWorkspace dataAdapter={valid()} />);
    const reason = screen.getByLabelText('Audit-Grund');
    expect(reason.getAttribute('required')).not.toBeNull();
    expect(reason.getAttribute('aria-invalid')).toBe('true');
    expect(reason.getAttribute('aria-describedby')).toBe('audit-reason-error');
    expect(screen.getAllByText('Audit-Grund ist erforderlich.').length).toBeGreaterThan(0);
  });

  it('opens journal details from history and closes the accessible dialog', async () => {
    const getJournalEntryById = vi.fn(async () => journalEntry);
    render(<SonderbuchungenWorkspace dataAdapter={{ listAccountingSourceRuns: vi.fn(async () => [historyWithJournal]), getJournalEntryById }} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Journal öffnen' }));
    const dialog = screen.getByRole('dialog', { name: 'Journalbuchung' });
    expect(dialog).toBeTruthy();
    expect(await within(dialog).findByRole('heading', { name: 'Journal 42' })).toBeTruthy();
    expect(getJournalEntryById).toHaveBeenCalledWith('journal-1');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Journalansicht schließen' }));
    expect(screen.queryByRole('dialog', { name: 'Journalbuchung' })).toBeNull();
  });

  it('surfaces journal not-found and adapter errors inside the dialog', async () => {
    const notFoundAdapter = { listAccountingSourceRuns: vi.fn(async () => [historyWithJournal]), getJournalEntryById: vi.fn(async () => null) };
    render(<SonderbuchungenWorkspace dataAdapter={notFoundAdapter} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Journal öffnen' }));
    const notFoundDialog = screen.getByRole('dialog', { name: 'Journalbuchung' });
    expect((await within(notFoundDialog).findByRole('status')).textContent).toContain('Journalbuchung nicht gefunden');

    cleanup();
    const errorAdapter = { listAccountingSourceRuns: vi.fn(async () => [historyWithJournal]), getJournalEntryById: vi.fn(async () => { throw new Error('Journal-Backend nicht erreichbar'); }) };
    render(<SonderbuchungenWorkspace dataAdapter={errorAdapter} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Journal öffnen' }));
    const errorDialog = screen.getByRole('dialog', { name: 'Journalbuchung' });
    expect((await within(errorDialog).findByRole('alert')).textContent).toContain('Journal-Backend nicht erreichbar');
  });
});
