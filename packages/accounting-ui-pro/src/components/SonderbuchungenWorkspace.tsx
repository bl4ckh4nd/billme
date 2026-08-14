import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@billme/ui';
import JournalEntryDetail from './JournalEntryDetail';
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

type WorkflowOption = { value: AccountingCommandKind; label: string; group: string; description: string };

const workflows: WorkflowOption[] = [
  { value: 'correction', label: 'Korrektur / Gutschrift', group: 'Belege & Zahlungen', description: 'Einen gebuchten Beleg nachvollziehbar berichtigen.' },
  { value: 'skonto', label: 'Skonto', group: 'Belege & Zahlungen', description: 'Zahlungsabzug und Umsatzsteuer anteilig korrigieren.' },
  { value: 'bad_debt', label: 'Forderungsausfall', group: 'Belege & Zahlungen', description: 'Uneinbringliche Forderung mit Nachweis ausbuchen.' },
  { value: 'advance_settlement', label: 'Vorauszahlung / Verrechnung', group: 'Belege & Zahlungen', description: 'Geleistete oder erhaltene Anzahlungen verrechnen.' },
  { value: 'fiscal_close', label: 'Geschäftsjahresabschluss', group: 'Abschluss', description: 'Erfolgskonten zum Stichtag abschließen.' },
  { value: 'carry_forward', label: 'Vortrag', group: 'Abschluss', description: 'Bestandskonten ins neue Geschäftsjahr vortragen.' },
  { value: 'provision', label: 'Rückstellung', group: 'Abschluss', description: 'Rückstellung bilden, anpassen oder auflösen.' },
  { value: 'accrual', label: 'Abgrenzung', group: 'Abschluss', description: 'Aufwand oder Ertrag periodengerecht abgrenzen.' },
  { value: 'inventory_closing', label: 'Inventurabschluss', group: 'Abschluss', description: 'Bewertete Inventurbestände zum Stichtag buchen.' },
  { value: 'fx_valuation', label: 'Fremdwährungsbewertung', group: 'Weitere Buchungen', description: 'Offene Fremdwährungsposition zum Stichtag bewerten.' },
  { value: 'loan_schedule', label: 'Darlehen', group: 'Weitere Buchungen', description: 'Tilgung und Zins aus einem Darlehensplan buchen.' },
  { value: 'payroll_batch', label: 'Lohnlauf', group: 'Weitere Buchungen', description: 'Freigegebenen Lohnlauf gesammelt verbuchen.' },
  { value: 'shareholder_flow', label: 'Gesellschaftervorgang', group: 'Weitere Buchungen', description: 'Einlage, Entnahme oder Ausschüttung dokumentieren.' },
];

const workflowGroups = [...new Set(workflows.map((workflow) => workflow.group))];
const runStatusLabel: Record<AccountingSourceRun['status'], string> = {
  posted: 'Gebucht',
  rejected: 'Abgelehnt',
  noop: 'Keine Änderung',
  prepared: 'Vorbereitet',
};

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
const SUPPORTED_TAX_YEAR = 2025;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const synchronizeDomainFacts = (
  kind: AccountingCommandKind,
  sourceId: string,
  date: string,
  facts: Record<string, unknown>,
  previousSourceId?: string,
): AccountingDomainFacts => {
  const source = sourceId.trim();
  const previousSource = previousSourceId?.trim();
  const synced: AccountingDomainFacts = { ...facts, sourceId: source, date, period: periodOf(date), fiscalYear: yearOf(date) };
  switch (kind) {
    case 'correction':
      if (previousSource && synced.id === `${previousSource}-correction`) synced.id = `${source}-correction`;
      if (previousSource && synced.idempotencyKey === `${previousSource}:correction:1`) synced.idempotencyKey = `${source}:correction:1`;
      synced.correctionDate = date;
      synced.taxEffectiveDate = date;
      break;
    case 'bad_debt':
      if (isRecord(synced.facts)) synced.facts = { ...synced.facts, adjustmentDate: date };
      break;
    case 'fiscal_close':
      synced.closingDate = date;
      break;
    case 'carry_forward':
    case 'provision':
    case 'inventory_closing':
    case 'fx_valuation':
    case 'payroll_batch':
      synced.effectiveDate = date;
      if (previousSource && synced.batchId === previousSource) synced.batchId = source;
      break;
    case 'accrual':
    case 'loan_schedule':
      synced.startDate = date;
      break;
    case 'shareholder_flow':
      if (previousSource && synced.flowId === previousSource) synced.flowId = source;
      break;
    default:
      break;
  }
  return synced;
};

const synchronizeDomainFactsText = (kind: AccountingCommandKind, sourceId: string, date: string, text: string, previousSourceId?: string): string => {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? JSON.stringify(synchronizeDomainFacts(kind, sourceId, date, parsed, previousSourceId), null, 2) : text;
  } catch {
    return text;
  }
};

const domainTemplate = (kind: AccountingCommandKind, sourceId: string, date: string): AccountingDomainFacts => {
  const period = periodOf(date);
  const fiscalYear = yearOf(date);
  const taxBreakdown = [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }];
  const template: Record<string, unknown> = (() => {
    switch (kind) {
    case 'correction':
      return { id: `${sourceId}-correction`, idempotencyKey: `${sourceId}:correction:1`, correctionDate: date, taxEffectiveDate: date, documentType: 'outgoing_invoice', original: { documentId: 'invoice-id', documentNumber: 'RE-0001', revision: 'revision-1', snapshotHash: 'snapshot-sha256', taxEffectiveDate: date, taxBreakdown }, deltas: [{ rate: 19, grossAmount: 11.9 }] };
    case 'skonto':
      return { taxBreakdown, skontoAmount: 11.9 };
    case 'bad_debt':
      return { taxBreakdown, writeOffGrossAmount: 119, badDebtExpenseAccount: '2400', facts: { legalBasis: '§17 UStG', reason: 'bad_debt', originalDocumentId: 'invoice-id', originalDocumentNumber: 'RE-0001', originalTaxEffectiveDate: date, adjustmentDate: date, evidenceReference: 'evidence-reference' } };
    case 'advance_settlement':
      return { finalInvoice: { grossAmount: 119, taxBreakdown }, advances: [{ id: 'advance-id', kind: 'advance', grossAmount: 59.5 }], advanceClearingReceivable: '1593', advanceClearingPayable: '1518' };
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
  })();
  return synchronizeDomainFacts(kind, sourceId, date, template);
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

const domainErrorMessage = (error: { code: string; message: string; field?: string }): string => {
  if (error.code === 'ACCOUNTING_SOURCE_RUN_CONFLICT') {
    return `${error.message || 'Quelllauf-Konflikt.'} Bitte Quellbeleg und Revision prüfen oder den bestehenden Lauf in der Historie öffnen.`;
  }
  return `${error.message}${error.field ? ` (${error.field})` : ''}`;
};

const caughtDomainErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('ACCOUNTING_SOURCE_RUN_CONFLICT')) {
    return 'Konflikt beim Quelllauf. Bitte Quellbeleg und Revision prüfen oder den bestehenden Lauf in der Historie öffnen.';
  }
  return message;
};

const has = (facts: AccountingDomainFacts, key: string): boolean => Object.prototype.hasOwnProperty.call(facts, key) && facts[key] !== undefined && facts[key] !== null;
const requiredFactKeys: Partial<Record<AccountingCommandKind, readonly string[]>> = {
  correction: ['id', 'idempotencyKey', 'correctionDate', 'original', 'deltas'],
  skonto: ['taxBreakdown'],
  bad_debt: ['taxBreakdown', 'writeOffGrossAmount', 'badDebtExpenseAccount', 'facts'],
  advance_settlement: ['finalInvoice', 'advanceClearingReceivable', 'advanceClearingPayable'],
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
  const facts = synchronizeDomainFacts(form.kind, form.sourceId, form.date, parsed);
  const missing = (requiredFactKeys[form.kind] ?? []).filter((key) => !has(facts, key));
  if (missing.length) return { errors: [`Domain-Fakten fehlen: ${missing.join(', ')}.`] };
  const invalidArrays = (arrayFactKeys[form.kind] ?? []).filter((key) => !Array.isArray(facts[key]));
  if (invalidArrays.length) return { errors: [`Domain-Fakten müssen Arrays enthalten: ${invalidArrays.join(', ')}.`] };
  if (form.kind === 'correction' && (!isRecord(facts.original) || !Array.isArray(facts.deltas))) return { errors: ['Korrektur benötigt original als Objekt und deltas als Array.'] };
  if (form.kind === 'bad_debt' && !isRecord(facts.facts)) return { errors: ['Forderungsausfall benötigt facts als Objekt.'] };
  if (form.kind === 'advance_settlement' && (!isRecord(facts.finalInvoice) || !Array.isArray(facts.finalInvoice.taxBreakdown))) return { errors: ['Vorauszahlung benötigt finalInvoice.taxBreakdown als Array.'] };
  return { facts, errors: [] };
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
  const [selectedJournalEntryId, setSelectedJournalEntryId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [taxKind, setTaxKind] = useState<TaxPreparationKind>('ustva');
  const [taxPeriod, setTaxPeriod] = useState(`${SUPPORTED_TAX_YEAR}-01`);
  const [taxReason, setTaxReason] = useState('');
  const [taxBusy, setTaxBusy] = useState(false);
  const [taxError, setTaxError] = useState<string | null>(null);
  const [preparedArtifact, setPreparedArtifact] = useState<{ kind: TaxPreparationKind; id?: string; status: string; rowCount?: number } | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const canMutate = permissionContextForRole(role).canMutate;
  const selectedWorkflow = workflows.find((workflow) => workflow.value === form.kind) ?? workflows[0];

  const preview = useMemo(() => (form.domainFacts || form.date || form.reason ? validateForm(form) : []), [form]);
  const parsedFacts = useMemo(() => parseDomainFacts(form).facts, [form]);
  const fieldErrors = useMemo(() => ({
    sourceId: form.sourceId.trim() ? null : 'Quellbeleg ist erforderlich.',
    date: validDate(form.date) ? null : 'Buchungsdatum muss ein gültiges Datum sein.',
    reason: form.reason.trim() ? null : 'Audit-Grund ist erforderlich.',
  }), [form.date, form.reason, form.sourceId]);
  const taxReasonError = taxReason.trim() ? null : 'Audit-Grund ist erforderlich.';
  const taxPeriodError = /^\d{4}-(0[1-9]|1[0-2])$/.test(taxPeriod) ? null : 'Zeitraum muss YYYY-MM sein.';

  const refetchHistory = async () => {
    if (!dataAdapter?.listAccountingSourceRuns) return;
    setHistoryError(null);
    try {
      const next = await dataAdapter.listAccountingSourceRuns();
      setHistory(next);
    } catch (error) {
      setHistoryError(caughtDomainErrorMessage(error));
    }
  };

  useEffect(() => {
    void refetchHistory();
  }, [dataAdapter]);

  const update = (key: keyof FormState, value: string) => setForm((current) => {
    const next = { ...current, [key]: value };
    if (key === 'sourceId' || key === 'date' || key === 'domainFacts') {
      next.domainFacts = synchronizeDomainFactsText(next.kind, next.sourceId, next.date, next.domainFacts, key === 'sourceId' ? current.sourceId : undefined);
    }
    return next;
  });
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
      const resultErrors = result.errors.map(domainErrorMessage);
      if (result.status === 'rejected' && resultErrors.length === 0) resultErrors.push('Buchung abgelehnt: Der Fachworkflow hat keinen buchbaren Vorgang zurückgegeben. Bitte Eingaben und Belegbezug prüfen.');
      if (result.status === 'noop') resultErrors.push('Keine Buchung vorgenommen: Der Fachworkflow erzeugt keine Journalzeilen. Bitte Beträge, Zeitraum und Belegbezug prüfen.');
      if (result.status === 'posted' && !result.sourceRun?.journalEntryId) resultErrors.push('Buchung nicht bestätigt: Es wurde keine Journal-ID erzeugt. Bitte den Quelllauf prüfen und erneut versuchen.');
      if (result.errors.length || result.status === 'rejected' || result.status === 'noop' || (result.status === 'posted' && !result.sourceRun?.journalEntryId)) {
        setErrors(resultErrors);
        return;
      }
      setNotice(result.status === 'duplicate' ? 'Diese Quelle wurde bereits gebucht. Der bestehende Lauf bleibt maßgeblich.' : 'Sonderbuchung wurde erfolgreich gebucht.');
      setForm(initialForm());
      await refetchHistory();
    } catch (error) {
      setErrors([caughtDomainErrorMessage(error) || 'Sonderbuchung konnte nicht gespeichert werden.']);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const prepareTax = async () => {
    if (taxBusy || !dataAdapter?.prepareTaxExport) return;
    setPreparedArtifact(null);
    const reason = taxReason.trim();
    if (!reason) {
      setTaxError(taxReasonError ?? 'Audit-Grund ist erforderlich.');
      return;
    }
    if (taxPeriodError) {
      setTaxError(taxPeriodError);
      return;
    }
    setTaxBusy(true);
    setTaxError(null);
    try {
      const result = await dataAdapter.prepareTaxExport({ kind: taxKind, period: taxPeriod, reason, idempotencyKey: `tax:${taxKind}:${taxPeriod}` });
      const rows = result.artifact.rows;
      setPreparedArtifact({ kind: result.artifact.kind, id: result.run?.id, status: result.artifact.status, rowCount: Array.isArray(rows) ? rows.length : undefined });
      await refetchHistory();
    } catch (error) {
      setPreparedArtifact(null);
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
    <div className="h-full overflow-y-auto p-4 sm:p-6 space-y-5" data-testid="sonderbuchungen-workspace">
      <header className="max-w-3xl">
        <p className="text-xs font-bold uppercase tracking-wide text-muted">Buchhaltung</p>
        <h1 className="mt-1 text-xl font-black text-foreground text-balance">Sonderbuchungen &amp; Abschluss</h1>
        <p className="mt-1 text-sm text-muted text-pretty">Vorgang auswählen, Angaben prüfen und erst danach verbindlich buchen. Die Buchungszeilen erzeugt der geprüfte Fachworkflow.</p>
      </header>

      <ol className="grid max-w-3xl grid-cols-3 gap-2" aria-label="Buchungsablauf">
        {['Vorgang', 'Angaben', 'Prüfen & buchen'].map((step, index) => <li key={step} className="flex min-h-10 items-center gap-2 rounded-xl border border-border-subtle bg-surface-muted px-3 text-xs font-bold text-foreground"><span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-dark-base text-[11px] text-dark-foreground">{index + 1}</span><span className="hidden sm:inline">{step}</span></li>)}
      </ol>

      {!dataAdapter?.postAccountingCommand ? <p className="rounded-xl border border-border bg-surface-muted p-3 text-sm text-muted" role="status">Sonderbuchungen sind in dieser Verbindung nur lesbar.</p> : null}
      {!canMutate ? <p className="rounded-lg border border-border bg-surface-muted p-3 text-sm text-muted" role="status">Diese Rolle darf Sonderbuchungen nur lesen.</p> : null}
      <section className="rounded-xl border border-border bg-surface p-4 space-y-3" aria-labelledby="special-entry-form-heading">
        <div>
          <h2 id="special-entry-form-heading" className="text-base font-black">1. Vorgang und Angaben</h2>
          <p className="mt-1 text-sm text-muted">{selectedWorkflow.description}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs font-semibold">Workflow
            <select aria-label="Workflow" value={form.kind} onChange={(event) => selectWorkflow(event.target.value as AccountingCommandKind)} disabled={!canMutate || busy} className="min-h-10 rounded-xl border border-border bg-surface px-3 py-2 text-sm font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              {workflowGroups.map((group) => <optgroup key={group} label={group}>{workflows.filter((workflow) => workflow.group === group).map((workflow) => <option key={workflow.value} value={workflow.value}>{workflow.label}</option>)}</optgroup>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold">Quellbeleg
            <input id="source-id" aria-label="Quellbeleg" required aria-invalid={Boolean(fieldErrors.sourceId)} aria-describedby={fieldErrors.sourceId ? 'source-id-error' : undefined} value={form.sourceId} onChange={(event) => update('sourceId', event.target.value)} disabled={!canMutate || busy} className="min-h-10 rounded-xl border border-border px-3 py-2 text-sm font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
            {fieldErrors.sourceId ? <span id="source-id-error" className="text-xs font-normal text-error">{fieldErrors.sourceId}</span> : null}
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold">Buchungsdatum
            <input id="booking-date" aria-label="Buchungsdatum" type="date" required aria-invalid={Boolean(fieldErrors.date)} aria-describedby={fieldErrors.date ? 'booking-date-error' : undefined} value={form.date} onChange={(event) => update('date', event.target.value)} disabled={!canMutate || busy} className="min-h-10 rounded-xl border border-border px-3 py-2 text-sm font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
            {fieldErrors.date ? <span id="booking-date-error" className="text-xs font-normal text-error">{fieldErrors.date}</span> : null}
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold sm:col-span-2 lg:col-span-1">Audit-Grund (Pflicht)
            <input id="audit-reason" aria-label="Audit-Grund" required aria-invalid={Boolean(fieldErrors.reason)} aria-describedby={fieldErrors.reason ? 'audit-reason-error' : undefined} value={form.reason} onChange={(event) => update('reason', event.target.value)} disabled={!canMutate || busy} placeholder="Warum wird diese Buchung vorgenommen?" className="min-h-10 rounded-xl border border-border px-3 py-2 text-sm font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
            {fieldErrors.reason ? <span id="audit-reason-error" className="text-xs font-normal text-error">{fieldErrors.reason}</span> : null}
          </label>
        </div>
        <details className="rounded-xl border border-border-subtle bg-surface-muted p-3">
          <summary className="min-h-10 cursor-pointer select-none py-2 text-sm font-bold text-foreground">Fachdaten für Experten bearbeiten</summary>
          <label className="mt-2 flex flex-col gap-1 text-xs font-semibold">Fachdaten (JSON)
            <textarea id="domain-facts" aria-label="Domain-Fakten (JSON)" required aria-invalid={preview.length > 0} aria-describedby="domain-facts-help" value={form.domainFacts} onChange={(event) => update('domainFacts', event.target.value)} disabled={!canMutate || busy} rows={12} spellCheck={false} className="rounded-xl border border-border bg-surface px-3 py-3 font-mono text-xs font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
            <span id="domain-facts-help" className="font-normal text-muted">Nur für fachkundige Bearbeitung. Konten und Beträge werden vor der Buchung erneut validiert.</span>
          </label>
        </details>
        <div className={`rounded-xl border p-3 ${preview.length ? 'border-error-border bg-error-bg' : 'border-success-border bg-success-bg'}`} role={preview.length ? 'alert' : 'status'}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className={`text-sm font-black ${preview.length ? 'text-error' : 'text-success'}`}>2. {preview.length ? 'Angaben noch unvollständig' : 'Angaben vollständig'}</h3>
            {parsedFacts ? <span className="text-xs tabular-nums text-muted">Periode {String(parsedFacts.period ?? periodOf(form.date))}</span> : null}
          </div>
          {preview.length ? <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-error">{preview.map((error) => <li key={error}>{error}</li>)}</ul> : <p className="mt-1 text-sm text-success">{selectedWorkflow.label} · {form.sourceId} · {form.date}</p>}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border-subtle pt-3">
          <Button type="button" onClick={() => void submit()} disabled={busy || preview.length > 0 || !canMutate || !dataAdapter?.postAccountingCommand} aria-busy={busy}>{busy ? 'Buchung läuft…' : 'Prüfen & verbindlich buchen'}</Button>
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
            <select aria-label="Steuervorbereitung" value={taxKind} onChange={(event) => { setPreparedArtifact(null); setTaxError(null); setTaxKind(event.target.value as TaxPreparationKind); }} disabled={taxBusy} className="rounded-lg border border-border px-2 py-2 text-sm font-normal">
              {taxPreparations.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold">Zeitraum
            <input id="tax-period" aria-label="Steuerzeitraum" type="month" required aria-invalid={Boolean(taxPeriodError)} aria-describedby={taxPeriodError ? 'tax-period-error' : undefined} value={taxPeriod} onChange={(event) => { setPreparedArtifact(null); setTaxError(null); setTaxPeriod(event.target.value); }} disabled={taxBusy} className="rounded-lg border border-border px-2 py-2 text-sm font-normal" />
            {taxPeriodError ? <span id="tax-period-error" className="text-xs font-normal text-error">{taxPeriodError}</span> : null}
          </label>
          <label className="flex min-w-60 flex-1 flex-col gap-1 text-xs font-semibold">Audit-Grund (Pflicht)
            <input id="tax-audit-reason" aria-label="Audit-Grund Steuerexport" required aria-invalid={Boolean(taxReasonError)} aria-describedby={taxReasonError ? 'tax-audit-reason-error' : undefined} value={taxReason} onChange={(event) => setTaxReason(event.target.value)} disabled={taxBusy} className="rounded-lg border border-border px-2 py-2 text-sm font-normal" />
            {taxReasonError ? <span id="tax-audit-reason-error" className="text-xs font-normal text-error">{taxReasonError}</span> : null}
          </label>
          <Button type="button" variant="secondary" onClick={() => void prepareTax()} disabled={taxBusy || !dataAdapter?.prepareTaxExport} aria-busy={taxBusy}>{taxBusy ? 'Bereite vor…' : 'Vorbereitung erstellen'}</Button>
        </div>
        {taxError ? <p className="text-sm text-error" role="alert">{taxError}</p> : null}
        {preparedArtifact ? <div className="flex flex-wrap items-center gap-2"><p className={`text-sm ${preparedArtifact.rowCount === 0 ? 'text-muted' : 'text-success'}`} role="status">{preparedArtifact.rowCount === 0 ? `${taxPreparations.find((item) => item.value === preparedArtifact.kind)?.label ?? preparedArtifact.kind}: Keine meldepflichtigen Vorgänge (keine meldepflichtigen Zeilen).` : `${taxPreparations.find((item) => item.value === preparedArtifact.kind)?.label ?? preparedArtifact.kind} vorbereitet (${preparedArtifact.status}) – keine offizielle Übermittlung.`}</p>{preparedArtifact.id && dataAdapter?.exportTaxArtifact ? <Button type="button" size="sm" variant="secondary" onClick={() => void exportTax()} disabled={exportBusy} aria-busy={exportBusy}>{exportBusy ? 'Export läuft…' : 'Vorbereitungs-Export'}</Button> : null}</div> : null}
        <div className="grid gap-2 sm:grid-cols-2">
          <p className="rounded-lg border border-border-subtle bg-surface-muted p-3 text-sm text-muted"><strong>E-Bilanz:</strong> Vorbereitung möglich, offizieller Provider nicht verfügbar.</p>
          <p className="rounded-lg border border-border-subtle bg-surface-muted p-3 text-sm text-muted"><strong>Unternehmensregister:</strong> Vorbereitung möglich, offizieller Provider nicht verfügbar.</p>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-4" aria-labelledby="source-run-history-heading">
        <h2 id="source-run-history-heading" className="text-base font-black">Letzte Buchungsläufe</h2>
        {historyError ? <div className="mt-2 flex flex-wrap items-center gap-2" role="alert"><p className="text-sm text-error">Buchungshistorie konnte nicht geladen werden: {historyError}</p><Button type="button" size="sm" variant="secondary" onClick={() => void refetchHistory().catch(() => undefined)}>Erneut versuchen</Button></div> : history.length === 0 ? <p className="mt-2 text-sm text-muted">Noch keine Sonderbuchung vorhanden.</p> : <ul className="mt-3 space-y-2">{history.map((run) => <li key={run.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-subtle bg-surface-muted p-3 text-sm"><span className="min-w-0"><strong className="block truncate text-foreground">{run.sourceId}</strong><span className="text-xs text-muted">{runStatusLabel[run.status]} · {new Date(run.createdAt).toLocaleString('de-DE')}</span></span>{run.journalEntryId ? <button type="button" className="min-h-10 rounded-lg px-3 py-2 font-bold text-accent underline underline-offset-2" onClick={() => setSelectedJournalEntryId(run.journalEntryId ?? null)}>Journal öffnen</button> : null}</li>)}</ul>}
      </section>
      {selectedJournalEntryId ? <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-dark-base/40 p-4 sm:p-8" role="presentation">
        <div className="w-full max-w-3xl rounded-2xl border border-border bg-surface p-4 shadow-xl sm:p-6" role="dialog" aria-modal="true" aria-labelledby="journal-entry-dialog-heading">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 id="journal-entry-dialog-heading" className="text-lg font-black text-foreground">Journalbuchung</h2>
            <button type="button" className="min-h-10 rounded-lg border border-border px-3 py-2 text-sm font-bold text-foreground hover:bg-surface-muted" aria-label="Journalansicht schließen" onClick={() => setSelectedJournalEntryId(null)}>Schließen</button>
          </div>
          <JournalEntryDetail entryId={selectedJournalEntryId} dataAdapter={dataAdapter} />
        </div>
      </div> : null}
    </div>
  );
}
