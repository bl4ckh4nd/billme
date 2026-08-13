import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@billme/ui';
import type { UserRole } from '../types';
import { permissionContextForRole } from '../mocks/users';
import type { ProAccountingDataAdapter } from '../services/mockBookingStore';
import type {
  AccountingCommandInput,
  AccountingCommandKind,
  AccountingSourceFact,
  AccountingSourceRun,
  TaxPreparationKind,
} from '../sourceRuns';

void React;

const workflows: Array<{ value: AccountingCommandKind; label: string }> = [
  { value: 'correction', label: 'Korrektur / Gutschrift' },
  { value: 'skonto', label: 'Skonto' },
  { value: 'bad_debt', label: 'Forderungsausfall' },
  { value: 'advance_settlement', label: 'Vorauszahlung / Verrechnung' },
  { value: 'fiscal_close', label: 'Geschäftsjahresabschluss' },
  { value: 'carry_forward', label: 'Vortrag' },
  { value: 'provision', label: 'Rückstellung' },
  { value: 'accrual', label: 'Abgrenzung' },
  { value: 'inventory_closing', label: 'Inventurabschluss' },
  { value: 'fx_valuation', label: 'Fremdwährungsbewertung' },
  { value: 'loan_schedule', label: 'Darlehen' },
  { value: 'payroll_batch', label: 'Lohnlauf' },
  { value: 'shareholder_flow', label: 'Gesellschaftervorgang' },
];

const taxPreparations: Array<{ value: TaxPreparationKind; label: string }> = [
  { value: 'ustva', label: 'UStVA' },
  { value: 'zm', label: 'Zusammenfassende Meldung (ZM)' },
  { value: 'oss', label: 'OSS' },
];

type FormState = {
  kind: AccountingCommandKind;
  sourceId: string;
  date: string;
  amount: string;
  debitAccount: string;
  creditAccount: string;
  bookingText: string;
  reason: string;
};

const initialForm = (): FormState => ({
  kind: 'correction',
  sourceId: `sonderbuchung-${Date.now()}`,
  date: new Date().toISOString().slice(0, 10),
  amount: '',
  debitAccount: '',
  creditAccount: '',
  bookingText: '',
  reason: '',
});

const validDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const validateForm = (form: FormState): string[] => {
  const errors: string[] = [];
  const amount = Number(form.amount);
  if (!Number.isFinite(amount) || amount <= 0) errors.push('Betrag muss größer als 0,00 € sein.');
  if (!validDate(form.date)) errors.push('Datum muss ein gültiges ISO-Datum sein.');
  if (!form.sourceId.trim()) errors.push('Quellbeleg ist erforderlich.');
  if (!form.debitAccount.trim() || !form.creditAccount.trim()) errors.push('Soll- und Habenkonto sind erforderlich.');
  if (form.debitAccount.trim() === form.creditAccount.trim()) errors.push('Soll- und Habenkonto müssen verschieden sein.');
  if (!form.bookingText.trim()) errors.push('Buchungstext ist erforderlich.');
  if (!form.reason.trim()) errors.push('Audit-Grund ist erforderlich.');
  return errors;
};

const toSource = (form: FormState): AccountingSourceFact => {
  const amount = Number(form.amount);
  return {
    sourceType: 'standalone_source',
    sourceId: form.sourceId.trim(),
    sourceRevision: '1',
    effectiveDate: form.date,
    postingDate: form.date,
    period: form.date.slice(0, 7),
    fiscalYear: Number(form.date.slice(0, 4)),
    currency: 'EUR',
    bookingText: form.bookingText.trim(),
    reference: form.kind,
    lines: [
      { accountNumber: form.debitAccount.trim(), debitAmount: amount, creditAmount: 0 },
      { accountNumber: form.creditAccount.trim(), debitAmount: 0, creditAmount: amount },
    ],
  };
};

type Props = {
  dataAdapter?: ProAccountingDataAdapter;
  role?: UserRole;
};

export default function SonderbuchungenWorkspace({ dataAdapter, role = 'admin' }: Props) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<AccountingSourceRun[]>([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [taxKind, setTaxKind] = useState<TaxPreparationKind>('ustva');
  const [taxPeriod, setTaxPeriod] = useState(() => new Date().toISOString().slice(0, 7));
  const [taxReason, setTaxReason] = useState('');
  const [taxBusy, setTaxBusy] = useState(false);
  const [taxError, setTaxError] = useState<string | null>(null);
  const [preparedArtifact, setPreparedArtifact] = useState<{ kind: TaxPreparationKind; id?: string; status: string } | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const canMutate = permissionContextForRole(role).canMutate;

  const preview = useMemo(() => (form.amount || form.date || form.reason ? validateForm(form) : []), [form]);

  const refetchHistory = async () => {
    if (!dataAdapter?.listAccountingSourceRuns) return;
    const next = await dataAdapter.listAccountingSourceRuns();
    setHistory(next);
  };

  useEffect(() => {
    void refetchHistory().catch((error: unknown) => setErrors([error instanceof Error ? error.message : 'Historie konnte nicht geladen werden.']));
  }, [dataAdapter]);

  const update = (key: keyof FormState, value: string) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    if (busyRef.current || !dataAdapter?.postAccountingCommand || !canMutate) return;
    const validation = validateForm(form);
    setErrors(validation);
    setNotice(null);
    if (validation.length) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const input: AccountingCommandInput = {
        // Workflow-specific domain facts are intentionally not guessed here;
        // the source-run remains a balanced standalone command until its
        // dedicated fact editor is supplied.
        kind: 'standalone',
        source: toSource(form),
        reason: form.reason.trim(),
      };
      const result = await dataAdapter.postAccountingCommand(input);
      if (result.errors.length || result.status === 'rejected') {
        setErrors(result.errors.map((error) => error.message));
        return;
      }
      // Keep local history untouched until the authoritative read succeeds.
      await refetchHistory();
      setNotice(result.status === 'duplicate' ? 'Doppelte Quelle erkannt; bestehender Lauf bleibt maßgeblich.' : 'Sonderbuchung gespeichert und refetched.');
      setForm(initialForm());
    } catch (error) {
      setErrors([error instanceof Error ? error.message : 'Sonderbuchung konnte nicht gespeichert werden.']);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const prepareTax = async () => {
    if (taxBusy || !dataAdapter?.prepareTaxExport) return;
    const reason = taxReason.trim();
    if (!reason) {
      setTaxError('Audit-Grund ist erforderlich.');
      return;
    }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(taxPeriod)) {
      setTaxError('Zeitraum muss YYYY-MM sein.');
      return;
    }
    setTaxBusy(true);
    setTaxError(null);
    try {
      const result = await dataAdapter.prepareTaxExport({ kind: taxKind, period: taxPeriod, reason, idempotencyKey: `tax:${taxKind}:${taxPeriod}` });
      setPreparedArtifact({ kind: result.artifact.kind, id: result.run?.id, status: result.artifact.status });
      await refetchHistory();
    } catch (error) {
      setTaxError(error instanceof Error ? error.message : 'Vorbereitung konnte nicht erstellt werden.');
    } finally {
      setTaxBusy(false);
    }
  };

  const exportTax = async () => {
    if (!preparedArtifact?.id || !dataAdapter?.exportTaxArtifact) return;
    setExportBusy(true);
    try {
      const output = await dataAdapter.exportTaxArtifact(preparedArtifact.kind, preparedArtifact.id);
      const blob = output instanceof Blob ? output : new Blob([output as BlobPart], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${preparedArtifact.kind}-vorbereitung.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setTaxError(error instanceof Error ? error.message : 'Export konnte nicht erstellt werden.');
    } finally {
      setExportBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4" data-testid="sonderbuchungen-workspace">
      <header>
        <h1 className="text-lg font-black text-foreground">Sonderbuchungen &amp; Abschluss</h1>
        <p className="text-sm text-muted">Ein gemeinsamer, prüfbarer Source-Run für Korrekturen und Abschlussvorgänge.</p>
      </header>

      {!dataAdapter?.postAccountingCommand ? <p className="rounded-lg border border-border bg-surface-muted p-3 text-sm text-muted" role="status">Source-Run-Adapter nicht verfügbar.</p> : null}
      {!canMutate ? <p className="rounded-lg border border-border bg-surface-muted p-3 text-sm text-muted" role="status">Diese Rolle darf Sonderbuchungen nur lesen.</p> : null}
      <section className="rounded-xl border border-border bg-surface p-4 space-y-3" aria-labelledby="special-entry-form-heading">
        <h2 id="special-entry-form-heading" className="text-sm font-bold">Vorschau und Buchung</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs font-semibold">Workflow
            <select aria-label="Workflow" value={form.kind} onChange={(event) => update('kind', event.target.value)} disabled={!canMutate || busy} className="rounded-lg border border-border bg-surface px-2 py-2 text-sm font-normal">
              {workflows.map((workflow) => <option key={workflow.value} value={workflow.value}>{workflow.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold">Quellbeleg
            <input aria-label="Quellbeleg" value={form.sourceId} onChange={(event) => update('sourceId', event.target.value)} disabled={!canMutate || busy} className="rounded-lg border border-border px-2 py-2 text-sm font-normal" />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold">Buchungsdatum
            <input aria-label="Buchungsdatum" type="date" value={form.date} onChange={(event) => update('date', event.target.value)} disabled={!canMutate || busy} className="rounded-lg border border-border px-2 py-2 text-sm font-normal" />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold">Betrag (EUR)
            <input aria-label="Betrag" type="number" min="0" step="0.01" value={form.amount} onChange={(event) => update('amount', event.target.value)} disabled={!canMutate || busy} className="rounded-lg border border-border px-2 py-2 text-sm font-normal" />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold">Sollkonto
            <input aria-label="Sollkonto" inputMode="numeric" value={form.debitAccount} onChange={(event) => update('debitAccount', event.target.value)} disabled={!canMutate || busy} className="rounded-lg border border-border px-2 py-2 text-sm font-normal" />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold">Habenkonto
            <input aria-label="Habenkonto" inputMode="numeric" value={form.creditAccount} onChange={(event) => update('creditAccount', event.target.value)} disabled={!canMutate || busy} className="rounded-lg border border-border px-2 py-2 text-sm font-normal" />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold sm:col-span-2">Buchungstext
            <input aria-label="Buchungstext" value={form.bookingText} onChange={(event) => update('bookingText', event.target.value)} disabled={!canMutate || busy} className="rounded-lg border border-border px-2 py-2 text-sm font-normal" />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold sm:col-span-2 lg:col-span-1">Audit-Grund (Pflicht)
            <input aria-label="Audit-Grund" value={form.reason} onChange={(event) => update('reason', event.target.value)} disabled={!canMutate || busy} className="rounded-lg border border-border px-2 py-2 text-sm font-normal" />
          </label>
        </div>
        {preview.length > 0 ? <div className="rounded-lg border border-error-border bg-error-bg px-3 py-2 text-sm text-error" role="alert"><ul className="list-disc pl-4">{preview.map((error) => <li key={error}>{error}</li>)}</ul></div> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" onClick={() => setErrors(validateForm(form))} disabled={busy || !canMutate}>Vorschau prüfen</Button>
          <Button type="button" onClick={() => void submit()} disabled={busy || !canMutate || !dataAdapter?.postAccountingCommand} aria-busy={busy}>{busy ? 'Speichere…' : 'Sonderbuchung speichern'}</Button>
        </div>
        {notice ? <p className="text-sm text-success" role="status" aria-live="polite">{notice}</p> : null}
        {errors.length > 0 && preview.length === 0 ? <p className="text-sm text-error" role="alert">{errors.join(' ')}</p> : null}
      </section>

      <section className="rounded-xl border border-border bg-surface p-4 space-y-3" aria-labelledby="tax-preparation-heading">
        <div>
          <h2 id="tax-preparation-heading" className="text-sm font-bold">Steuerliche Vorbereitung / Export</h2>
          <p className="text-xs text-muted">Vorbereitung und Export sind keine offizielle Übermittlung. Der Provider bleibt nicht verfügbar.</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs font-semibold">Meldung
            <select aria-label="Steuervorbereitung" value={taxKind} onChange={(event) => setTaxKind(event.target.value as TaxPreparationKind)} disabled={taxBusy} className="rounded-lg border border-border px-2 py-2 text-sm font-normal">
              {taxPreparations.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold">Zeitraum
            <input aria-label="Steuerzeitraum" type="month" value={taxPeriod} onChange={(event) => setTaxPeriod(event.target.value)} disabled={taxBusy} className="rounded-lg border border-border px-2 py-2 text-sm font-normal" />
          </label>
          <label className="flex min-w-60 flex-1 flex-col gap-1 text-xs font-semibold">Audit-Grund (Pflicht)
            <input aria-label="Audit-Grund Steuerexport" value={taxReason} onChange={(event) => setTaxReason(event.target.value)} disabled={taxBusy} className="rounded-lg border border-border px-2 py-2 text-sm font-normal" />
          </label>
          <Button type="button" variant="secondary" onClick={() => void prepareTax()} disabled={taxBusy || !dataAdapter?.prepareTaxExport} aria-busy={taxBusy}>{taxBusy ? 'Bereite vor…' : 'Vorbereitung erstellen'}</Button>
        </div>
        {taxError ? <p className="text-sm text-error" role="alert">{taxError}</p> : null}
        {preparedArtifact ? <div className="flex flex-wrap items-center gap-2"><p className="text-sm text-success" role="status">{preparedArtifact.kind.toUpperCase()} vorbereitet ({preparedArtifact.status}) – keine offizielle Übermittlung.</p>{preparedArtifact.id && dataAdapter?.exportTaxArtifact ? <Button type="button" size="sm" variant="secondary" onClick={() => void exportTax()} disabled={exportBusy} aria-busy={exportBusy}>{exportBusy ? 'Export läuft…' : 'Vorbereitungs-Export'}</Button> : null}</div> : null}
        <div className="grid gap-2 sm:grid-cols-2">
          <p className="rounded-lg border border-border-subtle bg-surface-muted p-3 text-sm text-muted"><strong>E-Bilanz:</strong> Vorbereitung möglich, offizieller Provider nicht verfügbar.</p>
          <p className="rounded-lg border border-border-subtle bg-surface-muted p-3 text-sm text-muted"><strong>Unternehmensregister:</strong> Vorbereitung möglich, offizieller Provider nicht verfügbar.</p>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-4" aria-labelledby="source-run-history-heading">
        <h2 id="source-run-history-heading" className="text-sm font-bold">Source-Run-Historie</h2>
        {history.length === 0 ? <p className="mt-2 text-sm text-muted">Noch keine Läufe.</p> : <ul className="mt-2 space-y-2">{history.map((run) => <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-subtle bg-surface-muted p-2 text-sm"><span>{run.sourceType} · {run.sourceId} · {run.status}</span>{run.journalEntryId ? <a className="text-accent underline" href={`#/accounting/journal/${encodeURIComponent(run.journalEntryId)}`}>Journal {run.journalEntryId}</a> : null}</li>)}</ul>}
      </section>
    </div>
  );
}
