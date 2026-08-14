import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@billme/ui';
import type { UserRole } from '../types';
import { permissionContextForRole } from '../mocks/users';
import type { ProAccountingDataAdapter } from '../services/mockBookingStore';
import type {
  AccountingCommandInput,
  AccountingCommandKind,
  AccountingDomainFacts,
  DomainAccountingSourceFact,
  AccountingSourceRun,
  TaxPreparationKind,
} from '../sourceRuns';

void React;

type WorkflowOption = { value: AccountingCommandKind; label: string };

const workflows: WorkflowOption[] = [
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
  domainFacts: string;
  reason: string;
};

const periodOf = (date: string): string => date.slice(0, 7);
const yearOf = (date: string): number => Number(date.slice(0, 4));

const domainTemplate = (kind: AccountingCommandKind, sourceId: string, date: string): AccountingDomainFacts => {
  const period = periodOf(date);
  const fiscalYear = yearOf(date);
  const taxBreakdown = [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }];
  switch (kind) {
    case 'correction':
      return { id: `${sourceId}-correction`, idempotencyKey: `${sourceId}:correction:1`, correctionDate: date, taxEffectiveDate: date, documentType: 'outgoing_invoice', original: { documentId: 'invoice-id', documentNumber: 'RE-0001', revision: 'revision-1', snapshotHash: 'snapshot-sha256', taxEffectiveDate: date, taxBreakdown }, deltas: [{ rate: 19, grossAmount: 11.9 }] };
    case 'skonto':
      return { taxBreakdown, skontoAmount: 11.9 };
    case 'bad_debt':
      return { taxBreakdown, writeOffGrossAmount: 119, facts: { legalBasis: '§17 UStG', reason: 'bad_debt', originalDocumentId: 'invoice-id', originalDocumentNumber: 'RE-0001', originalTaxEffectiveDate: date, adjustmentDate: date, evidenceReference: 'evidence-reference' } };
    case 'advance_settlement':
      return { finalInvoice: { grossAmount: 119, taxBreakdown }, advances: [{ id: 'advance-id', kind: 'advance', grossAmount: 59.5 }] };
    case 'fiscal_close':
      return { sourceId, sourceRevision: '1', fiscalYear, period, closingDate: date, currency: 'EUR', revenueAccounts: ['8400'], expenseAccounts: ['4900'], retainedEarningsAccount: '9000', balances: [{ accountNumber: '8400', openingBalance: 0, debitTurnover: 0, creditTurnover: 119, closingBalance: -119 }, { accountNumber: '4900', openingBalance: 0, debitTurnover: 100, creditTurnover: 0, closingBalance: 100 }] };
    case 'carry_forward':
      return { sourceId, sourceRevision: '1', effectiveDate: date, period, fiscalYear, currency: 'EUR', balanceSheetAccounts: ['1200'], openingBalanceAccount: '9000', balances: [{ accountNumber: '1200', openingBalance: 0, debitTurnover: 100, creditTurnover: 0, closingBalance: 100 }] };
    case 'provision':
      return { sourceId, sourceRevision: '1', effectiveDate: date, period, fiscalYear, currency: 'EUR', previousAmount: 0, targetAmount: 100, expenseAccount: '6700', provisionAccount: '3070', bookingText: 'Rückstellung' };
    case 'accrual':
      return { sourceId, sourceRevision: '1', startDate: date, endDate: `${fiscalYear}-12-01`, period, fiscalYear, currency: 'EUR', totalAmount: 100, expenseAccount: '4900', deferralAccount: '2900' };
    case 'inventory_closing':
      return { sourceId, sourceRevision: '1', effectiveDate: date, period, fiscalYear, currency: 'EUR', items: [{ id: 'sku-1', quantity: 2, unitCost: 10, unitMarketValue: 8, inventoryAccount: '1140', expenseAccount: '5880' }] };
    case 'fx_valuation':
      return { sourceId, sourceRevision: '1', effectiveDate: date, period, fiscalYear, foreignCurrency: 'USD', functionalCurrency: 'EUR', foreignAmount: 100, closingRate: 0.95, carryingAmount: 90, position: 'asset', positionAccount: '1200', gainAccount: '4840', lossAccount: '6880' };
    case 'loan_schedule':
      return { sourceId, sourceRevision: '1', startDate: date, period, fiscalYear, currency: 'EUR', principal: 1000, annualInterestRate: 5, termMonths: 12, liabilityAccount: '1700', interestAccount: '2100', cashAccount: '1200' };
    case 'payroll_batch':
      return { batchId: sourceId, sourceRevision: '1', effectiveDate: date, period, fiscalYear, currency: 'EUR', lines: [{ employeeId: 'employee-1', gross: 1000, employeeTaxes: 200, otherDeductions: 50, net: 750, employerContributions: 200 }] };
    case 'shareholder_flow':
      return { flowId: sourceId, shareholderId: 'shareholder-1', companyId: 'company-1', amount: 100, flowType: 'capital_contribution', approved: true, purpose: 'Einlage' };
    default:
      return {};
  }
};

const formatFacts = (kind: AccountingCommandKind, sourceId: string, date: string): string => JSON.stringify(domainTemplate(kind, sourceId, date), null, 2);

const initialForm = (): FormState => {
  const sourceId = `sonderbuchung-${Date.now()}`;
  const date = new Date().toISOString().slice(0, 10);
  return { kind: 'correction', sourceId, date, domainFacts: formatFacts('correction', sourceId, date), reason: '' };
};

const validDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const has = (facts: AccountingDomainFacts, key: string): boolean => Object.prototype.hasOwnProperty.call(facts, key) && facts[key] !== undefined && facts[key] !== null;
const requiredFactKeys: Partial<Record<AccountingCommandKind, readonly string[]>> = {
  correction: ['id', 'idempotencyKey', 'correctionDate', 'original', 'deltas'],
  skonto: ['taxBreakdown'],
  bad_debt: ['taxBreakdown', 'writeOffGrossAmount', 'facts'],
  advance_settlement: ['finalInvoice'],
  fiscal_close: ['closingDate', 'revenueAccounts', 'expenseAccounts', 'retainedEarningsAccount', 'balances'],
  carry_forward: ['effectiveDate', 'balanceSheetAccounts', 'openingBalanceAccount', 'balances'],
  provision: ['effectiveDate', 'previousAmount', 'targetAmount', 'expenseAccount', 'provisionAccount'],
  accrual: ['startDate', 'endDate', 'totalAmount', 'expenseAccount', 'deferralAccount'],
  inventory_closing: ['effectiveDate', 'items'],
  fx_valuation: ['effectiveDate', 'foreignCurrency', 'functionalCurrency', 'foreignAmount', 'closingRate', 'carryingAmount', 'position', 'positionAccount', 'gainAccount', 'lossAccount'],
  loan_schedule: ['startDate', 'principal', 'annualInterestRate', 'termMonths', 'liabilityAccount', 'interestAccount', 'cashAccount'],
  payroll_batch: ['batchId', 'effectiveDate', 'lines'],
  shareholder_flow: ['flowId', 'shareholderId', 'companyId', 'amount', 'flowType'],
};
const arrayFactKeys: Partial<Record<AccountingCommandKind, readonly string[]>> = {
  correction: ['deltas'],
  skonto: ['taxBreakdown'],
  bad_debt: ['taxBreakdown'],
  fiscal_close: ['revenueAccounts', 'expenseAccounts', 'balances'],
  carry_forward: ['balanceSheetAccounts', 'balances'],
  inventory_closing: ['items'],
  payroll_batch: ['lines'],
};

const parseDomainFacts = (form: FormState): { facts?: AccountingDomainFacts; errors: string[] } => {
  let parsed: unknown;
  try { parsed = JSON.parse(form.domainFacts); } catch { return { errors: ['Domain-Fakten müssen gültiges JSON sein.'] }; }
  if (!isRecord(parsed)) return { errors: ['Domain-Fakten müssen ein JSON-Objekt sein.'] };
  const missing = (requiredFactKeys[form.kind] ?? []).filter((key) => !has(parsed, key));
  if (missing.length) return { errors: [`Domain-Fakten fehlen: ${missing.join(', ')}.`] };
  const invalidArrays = (arrayFactKeys[form.kind] ?? []).filter((key) => !Array.isArray(parsed[key]));
  if (invalidArrays.length) return { errors: [`Domain-Fakten müssen Arrays enthalten: ${invalidArrays.join(', ')}.`] };
  if (form.kind === 'correction' && (!isRecord(parsed.original) || !Array.isArray(parsed.deltas))) return { errors: ['Korrektur benötigt original als Objekt und deltas als Array.'] };
  if (form.kind === 'bad_debt' && !isRecord(parsed.facts)) return { errors: ['Forderungsausfall benötigt facts als Objekt.'] };
  if (form.kind === 'advance_settlement' && (!isRecord(parsed.finalInvoice) || !Array.isArray(parsed.finalInvoice.taxBreakdown))) return { errors: ['Vorauszahlung benötigt finalInvoice.taxBreakdown als Array.'] };
  return { facts: parsed, errors: [] };
};

const validateForm = (form: FormState): string[] => {
  const errors: string[] = [];
  if (!validDate(form.date)) errors.push('Datum muss ein gültiges ISO-Datum sein.');
  if (!form.sourceId.trim()) errors.push('Quellbeleg ist erforderlich.');
  if (!form.reason.trim()) errors.push('Audit-Grund ist erforderlich.');
  errors.push(...parseDomainFacts(form).errors);
  return errors;
};

const toSource = (form: FormState): DomainAccountingSourceFact => ({
  sourceType: ['fiscal_close', 'carry_forward', 'provision', 'accrual', 'inventory_closing', 'fx_valuation', 'loan_schedule', 'payroll_batch'].includes(form.kind) ? form.kind as DomainAccountingSourceFact['sourceType'] : 'standalone_source',
  sourceId: form.sourceId.trim(),
  sourceRevision: '1',
  effectiveDate: form.date,
  postingDate: form.date,
  period: periodOf(form.date),
  fiscalYear: yearOf(form.date),
  currency: 'EUR',
  bookingText: workflows.find((workflow) => workflow.value === form.kind)?.label ?? form.kind,
  reference: form.kind,
  // Domain builders own journal lines. Never turn the generic form into a journal.
  lines: [],
});
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

  const preview = useMemo(() => (form.domainFacts || form.date || form.reason ? validateForm(form) : []), [form]);

  const refetchHistory = async () => {
    if (!dataAdapter?.listAccountingSourceRuns) return;
    const next = await dataAdapter.listAccountingSourceRuns();
    setHistory(next);
  };

  useEffect(() => {
    void refetchHistory().catch((error: unknown) => setErrors([error instanceof Error ? error.message : 'Historie konnte nicht geladen werden.']));
  }, [dataAdapter]);

  const update = (key: keyof FormState, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const selectWorkflow = (kind: AccountingCommandKind) => setForm((current) => ({ ...current, kind, domainFacts: formatFacts(kind, current.sourceId, current.date) }));

  const submit = async () => {
    if (busyRef.current || !dataAdapter?.postAccountingCommand || !canMutate) return;
    const validation = validateForm(form);
    setErrors(validation);
    setNotice(null);
    if (validation.length) return;
    const parsed = parseDomainFacts(form);
    if (!parsed.facts) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const input: AccountingCommandInput = {
        kind: form.kind,
        source: toSource(form),
        domainFacts: parsed.facts,
        reason: form.reason.trim(),
      };
      const result = await dataAdapter.postAccountingCommand(input);
      if (result.errors.length || result.status === 'rejected') {
        setErrors(result.errors.map((error) => error.message));
        return;
      }
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
        <p className="text-sm text-muted">Domain-Fakten werden geprüft; die Buchungszeilen erzeugt ausschließlich der gewählte Workflow.</p>
      </header>

      {!dataAdapter?.postAccountingCommand ? <p className="rounded-lg border border-border bg-surface-muted p-3 text-sm text-muted" role="status">Source-Run-Adapter nicht verfügbar.</p> : null}
      {!canMutate ? <p className="rounded-lg border border-border bg-surface-muted p-3 text-sm text-muted" role="status">Diese Rolle darf Sonderbuchungen nur lesen.</p> : null}
      <section className="rounded-xl border border-border bg-surface p-4 space-y-3" aria-labelledby="special-entry-form-heading">
        <h2 id="special-entry-form-heading" className="text-sm font-bold">Domain-Fakten und Buchung</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs font-semibold">Workflow
            <select aria-label="Workflow" value={form.kind} onChange={(event) => selectWorkflow(event.target.value as AccountingCommandKind)} disabled={!canMutate || busy} className="rounded-lg border border-border bg-surface px-2 py-2 text-sm font-normal">
              {workflows.map((workflow) => <option key={workflow.value} value={workflow.value}>{workflow.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold">Quellbeleg
            <input aria-label="Quellbeleg" value={form.sourceId} onChange={(event) => update('sourceId', event.target.value)} disabled={!canMutate || busy} className="rounded-lg border border-border px-2 py-2 text-sm font-normal" />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold">Buchungsdatum
            <input aria-label="Buchungsdatum" type="date" value={form.date} onChange={(event) => update('date', event.target.value)} disabled={!canMutate || busy} className="rounded-lg border border-border px-2 py-2 text-sm font-normal" />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold sm:col-span-2 lg:col-span-3">Domain-Fakten (JSON)
            <textarea aria-label="Domain-Fakten (JSON)" value={form.domainFacts} onChange={(event) => update('domainFacts', event.target.value)} disabled={!canMutate || busy} rows={12} spellCheck={false} className="rounded-lg border border-border bg-surface-muted px-2 py-2 font-mono text-xs font-normal" />
            <span className="font-normal text-muted">Vorlage anpassen. Keine generischen Soll-/Habenzeilen; jeder Workflow validiert seine eigenen Fakten.</span>
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
