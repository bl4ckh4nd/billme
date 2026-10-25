import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, CardHeader, ConfirmDialog, EmptyState, Field, Input, Select, Stepper, Textarea, formatEmptyValue } from '@billme/ui';
import { JournalEntryDetailModal } from './JournalEntryDetail';
import PeriodLockPanel from './PeriodLockPanel';
import ManualEntryPanel from './ManualEntryPanel';
import UstvaPanel from './UstvaPanel';
import FiscalYearClosePanel from './FiscalYearClosePanel';
import type { BusinessReportingProfile } from '../domain/reportTypes';
import { userFacingReference } from '../domain/references';
import type { Account, UserRole } from '../types';
import { permissionContextForRole } from '../domain/permissions';
import { localToday } from '../domain/reportDates';
import type { ProAccountingDataAdapter } from '../services/accountingDataAdapter';
import type {
  AccountingCommandInput,
  AccountingCommandKind,
  AccountingDomainFacts,
  DomainAccountingSourceFact,
  AccountingSourceRun,
  TaxPreparationKind,
} from '../sourceRuns';

void React;

const bannerClass = 'rounded-control border px-3 py-2.5 text-control';
const cardHeadClass = 'border-b border-border px-3.5 py-3';

type WorkflowOption = { value: AccountingCommandKind; label: string; group: string; description: string };

const workflows: WorkflowOption[] = [
  { value: 'correction', label: 'Korrektur / Gutschrift', group: 'Belege & Zahlungen', description: 'Einen gebuchten Beleg nachvollziehbar berichtigen.' },
  { value: 'skonto', label: 'Skonto', group: 'Belege & Zahlungen', description: 'Zahlungsabzug und Umsatzsteuer anteilig korrigieren.' },
  { value: 'bad_debt', label: 'Forderungsausfall', group: 'Belege & Zahlungen', description: 'Uneinbringliche Forderung mit Nachweis ausbuchen.' },
  { value: 'advance_settlement', label: 'Vorauszahlung / Verrechnung', group: 'Belege & Zahlungen', description: 'Geleistete oder erhaltene Anzahlungen verrechnen.' },
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
  /** Mask fields of Skonto, Forderungsausfall and Anzahlung; their facts are built from these, not from JSON. */
  amount?: string;
  advanceNumber?: string;
  evidence?: string;
};

const MASK_KINDS: ReadonlySet<AccountingCommandKind> = new Set(['skonto', 'bad_debt', 'advance_settlement']);
const RECEIVABLE = { SKR03: '1400', SKR04: '1200' } as const;
const PAYABLE = { SKR03: '1600', SKR04: '3300' } as const;
const BAD_DEBT_ACCOUNT = { SKR03: '2400', SKR04: '6930' } as const;
const maskAmount = (value: string | undefined): number | null => {
  const text = (value ?? '').trim();
  const number = Number(text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text);
  return text && Number.isFinite(number) && number > 0 && Math.abs(number * 100 - Math.round(number * 100)) < 1e-6 ? Math.round(number * 100) / 100 : null;
};

/** Facts of a mask workflow. The tax split and the invoice ids come from the posted invoices on the server. */
const maskFacts = (form: FormState, chart: 'SKR03' | 'SKR04'): { facts?: Record<string, unknown>; errors: string[] } => {
  const amount = maskAmount(form.amount);
  const errors: string[] = [];
  if (amount === null) errors.push(form.kind === 'skonto' ? 'Skontobetrag (brutto) fehlt.' : form.kind === 'bad_debt' ? 'Ausfallbetrag (brutto) fehlt.' : 'Verrechneter Betrag (brutto) fehlt.');
  if (form.kind === 'bad_debt' && !form.evidence?.trim()) errors.push('Nachweis des Ausfalls fehlt (z. B. Insolvenzbekanntmachung).');
  if (form.kind === 'advance_settlement' && !form.advanceNumber?.trim()) errors.push('Nummer der Abschlagsrechnung fehlt.');
  if (errors.length) return { errors };
  const base = { sourceId: form.sourceId.trim(), date: form.date, period: periodOf(form.date), fiscalYear: yearOf(form.date) };
  if (form.kind === 'skonto') return { facts: { ...base, skontoAmount: amount }, errors };
  if (form.kind === 'bad_debt') return { facts: { ...base, writeOffGrossAmount: amount, badDebtExpenseAccount: BAD_DEBT_ACCOUNT[chart], facts: { legalBasis: '§17 UStG', reason: 'bad_debt', adjustmentDate: form.date, evidenceReference: form.evidence!.trim() } }, errors };
  return { facts: { ...base, finalInvoice: { number: form.sourceId.trim() }, advances: [{ number: form.advanceNumber!.trim(), kind: 'advance', grossAmount: amount }], advanceClearingReceivable: RECEIVABLE[chart], advanceClearingPayable: PAYABLE[chart] }, errors };
};

const periodOf = (date: string): string => date.slice(0, 7);
const yearOf = (date: string): number => Number(date.slice(0, 4));
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const synchronizeDomainFacts = (
  kind: AccountingCommandKind,
  sourceId: string,
  date: string,
  facts: Record<string, unknown>,
  previousSourceId?: string,
): AccountingDomainFacts => {
  const source = sourceId.trim();
  const hasPreviousSource = previousSourceId !== undefined;
  const previousSource = previousSourceId?.trim() ?? '';
  const synced: AccountingDomainFacts = { ...facts, sourceId: source, date, period: periodOf(date), fiscalYear: yearOf(date) };
  switch (kind) {
    case 'correction':
      if (hasPreviousSource && synced.id === `${previousSource}-correction`) synced.id = `${source}-correction`;
      if (hasPreviousSource && synced.idempotencyKey === `${previousSource}:correction:1`) synced.idempotencyKey = `${source}:correction:1`;
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
      if (hasPreviousSource && synced.batchId === previousSource) synced.batchId = source;
      break;
    case 'accrual':
    case 'loan_schedule':
      synced.startDate = date;
      break;
    case 'shareholder_flow':
      if (hasPreviousSource && synced.flowId === previousSource) synced.flowId = source;
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
      // The original (id, number, invoice date) comes from the Quellbeleg; placeholders here would override it.
      return { taxBreakdown, writeOffGrossAmount: 119, badDebtExpenseAccount: '2400', facts: { legalBasis: '§17 UStG', reason: 'bad_debt', adjustmentDate: date, evidenceReference: 'evidence-reference' } };
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
  // Der Quellbeleg ist die fachliche Belegnummer des Nutzers. Eine generierte
  // technische ID (Präfix + Zeitstempel) gehört nicht ins Belegfeld.
  const sourceId = '';
  const date = localToday();
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

/** Server codes of the settlement checks, in the words of the form. */
const SETTLEMENT_ERROR_TEXT: Record<string, string> = {
  ORIGINAL_DOCUMENT_REQUIRED: 'Bitte als Quellbeleg die Rechnung angeben, auf die sich die Buchung bezieht.',
  ORIGINAL_DOCUMENT_NOT_FOUND: 'Zum Quellbeleg wurde keine Rechnung gefunden.',
  ORIGINAL_CHANGED: 'Quellbeleg und angegebene Rechnungsnummer passen nicht zusammen.',
  DOCUMENT_NOT_POSTED: 'Die Rechnung des Quellbelegs ist noch nicht gebucht.',
  OPEN_ITEM_NOT_FOUND: 'Zur Rechnung des Quellbelegs gibt es keinen offenen Posten.',
  SETTLEMENT_EXCEEDS_OPEN_ITEM: 'Der Betrag ist höher als der noch offene Rest der Rechnung.',
  INVALID_FACTS: 'Die Fachdaten der Buchung sind unvollständig oder passen nicht zusammen',
};

const caughtDomainErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('ACCOUNTING_SOURCE_RUN_CONFLICT')) {
    return 'Konflikt beim Quelllauf. Bitte Quellbeleg und Revision prüfen oder den bestehenden Lauf in der Historie öffnen.';
  }
  const code = Object.keys(SETTLEMENT_ERROR_TEXT).find((candidate) => message.includes(candidate));
  if (code === 'INVALID_FACTS') return `${SETTLEMENT_ERROR_TEXT[code]} (${message.slice(message.indexOf('INVALID_FACTS') + 'INVALID_FACTS:'.length).trim()}).`;
  return code ? SETTLEMENT_ERROR_TEXT[code]! : message;
};

const HISTORY_LOAD_FALLBACK = 'Bitte versuche es erneut.';
const HISTORY_CONFLICT_MESSAGE = 'Konflikt beim Quelllauf. Bitte Quellbeleg und Revision prüfen oder den bestehenden Lauf in der Historie öffnen.';

const historyErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message.trim() : String(error).trim();
  if (message.includes('ACCOUNTING_SOURCE_RUN_CONFLICT')) return HISTORY_CONFLICT_MESSAGE;
  // Keep the already user-facing message used by the adapter boundary. All
  // other transport/schema details remain diagnostic data only.
  if (message === 'Historie vorübergehend nicht verfügbar') return message;
  return HISTORY_LOAD_FALLBACK;
};

const logHistoryError = (error: unknown): void => {
  console.error('[SonderbuchungenWorkspace] Buchungshistorie konnte nicht geladen werden', error);
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

const parseDomainFacts = (form: FormState, chart: 'SKR03' | 'SKR04' = 'SKR03'): { facts?: AccountingDomainFacts; errors: string[] } => {
  if (MASK_KINDS.has(form.kind)) {
    const masked = maskFacts(form, chart);
    return masked.facts ? { facts: masked.facts as AccountingDomainFacts, errors: [] } : { errors: masked.errors };
  }
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

const validateForm = (form: FormState, chart: 'SKR03' | 'SKR04' = 'SKR03'): string[] => {
  const errors: string[] = [];
  if (!validDate(form.date)) errors.push('Datum muss ein gültiges ISO-Datum sein.');
  if (!form.sourceId.trim()) errors.push(MASK_KINDS.has(form.kind) ? 'Rechnungsnummer ist erforderlich.' : 'Quellbeleg ist erforderlich.');
  if (!form.reason.trim()) errors.push('Audit-Grund ist erforderlich.');
  errors.push(...parseDomainFacts(form, chart).errors);
  return errors;
};

const toSource = (form: FormState): DomainAccountingSourceFact => ({
  sourceType: ['fiscal_close', 'carry_forward', 'provision', 'accrual', 'inventory_closing', 'fx_valuation', 'loan_schedule', 'payroll_batch', 'shareholder_flow'].includes(form.kind) ? form.kind as DomainAccountingSourceFact['sourceType'] : 'standalone_source',
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
  accounts?: Account[];
  chart?: 'SKR03' | 'SKR04';
  businessReportingProfile?: BusinessReportingProfile;
  /** "special": Sonderbuchungen und Jahresabschluss; "tax": UStVA, ZM/OSS-Vorbereitung und Perioden (Bereich Steuer). */
  area?: 'special' | 'tax';
  /** Opens the host's ELSTER transmission page (/tax-filing); without it the Steuer area shows no link. */
  onOpenTaxFiling?: () => void;
};

export default function SonderbuchungenWorkspace({ dataAdapter, role = 'admin', accounts = [], chart = 'SKR03', businessReportingProfile, area = 'special', onOpenTaxFiling }: Props) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [history, setHistory] = useState<AccountingSourceRun[]>([]);
  const [selectedJournalEntryId, setSelectedJournalEntryId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [taxKind, setTaxKind] = useState<TaxPreparationKind>('ustva');
  const [taxPeriod, setTaxPeriod] = useState(() => localToday().slice(0, 7));
  const [taxReason, setTaxReason] = useState('');
  const [taxBusy, setTaxBusy] = useState(false);
  const [taxError, setTaxError] = useState<string | null>(null);
  const [preparedArtifact, setPreparedArtifact] = useState<{ kind: TaxPreparationKind; id?: string; status: string; rowCount?: number } | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  // UStVA preparation and the fiscal-year close soft-lock months on the server; reload the month list after both.
  const [periodRefresh, setPeriodRefresh] = useState(0);
  const historyRequestId = useRef(0);
  const mounted = useRef(true);
  const canMutate = permissionContextForRole(role).canMutate;
  const selectedWorkflow = workflows.find((workflow) => workflow.value === form.kind) ?? workflows[0];

  const preview = useMemo(() => (form.domainFacts || form.date || form.reason ? validateForm(form, chart) : []), [form, chart]);
  const parsedFacts = useMemo(() => parseDomainFacts(form, chart).facts, [form, chart]);
  const masked = MASK_KINDS.has(form.kind);
  const fieldErrors = useMemo(() => ({
    sourceId: form.sourceId.trim() ? null : 'Quellbeleg ist erforderlich.',
    date: validDate(form.date) ? null : 'Buchungsdatum muss ein gültiges Datum sein.',
    reason: form.reason.trim() ? null : 'Audit-Grund ist erforderlich.',
  }), [form.date, form.reason, form.sourceId]);
  // Inline errors appear once a field was left or a booking was attempted, not on a fresh form.
  const [touched, setTouched] = useState<Partial<Record<keyof typeof fieldErrors, boolean>>>({});
  const touch = (key: keyof typeof fieldErrors) => setTouched((current) => (current[key] ? current : { ...current, [key]: true }));
  const shownErrors = {
    sourceId: touched.sourceId ? fieldErrors.sourceId : null,
    date: touched.date ? fieldErrors.date : null,
    reason: touched.reason ? fieldErrors.reason : null,
  };
  // The summary box starts neutral and turns into an error once anything was edited or left.
  const [edited, setEdited] = useState(false);
  const pristine = !edited && !touched.sourceId && !touched.date && !touched.reason;
  const taxReasonError = taxReason.trim() ? null : 'Audit-Grund ist erforderlich.';
  const [taxReasonTouched, setTaxReasonTouched] = useState(false);
  const shownTaxReasonError = taxReasonTouched ? taxReasonError : null;
  const taxPeriodError = /^\d{4}-(0[1-9]|1[0-2])$/.test(taxPeriod) ? null : 'Zeitraum muss YYYY-MM sein.';

  const refetchHistory = async () => {
    const requestId = ++historyRequestId.current;
    if (!dataAdapter?.listAccountingSourceRuns) return;
    setHistoryError(null);
    try {
      const next = await dataAdapter.listAccountingSourceRuns();
      if (!mounted.current || requestId !== historyRequestId.current) return;
      setHistory(next);
    } catch (error) {
      if (!mounted.current || requestId !== historyRequestId.current) return;
      logHistoryError(error);
      setHistoryError(historyErrorMessage(error));
    }
  };

  useEffect(() => {
    void refetchHistory();
  }, [dataAdapter]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      historyRequestId.current += 1;
    };
  }, []);

  const update = (key: Exclude<keyof FormState, 'kind'>, value: string) => {
    setEdited(true);
    updateForm(key, value);
  };
  const updateForm = (key: Exclude<keyof FormState, 'kind'>, value: string) => setForm((current) => {
    const next = { ...current, [key]: value };
    if (key === 'sourceId' || key === 'date' || key === 'domainFacts') {
      next.domainFacts = synchronizeDomainFactsText(next.kind, next.sourceId, next.date, next.domainFacts, key === 'sourceId' ? current.sourceId : undefined);
    }
    return next;
  });
  const selectWorkflow = (kind: AccountingCommandKind) => setForm((current) => ({ ...current, kind, amount: '', advanceNumber: '', evidence: '', domainFacts: formatFacts(kind, current.sourceId, current.date) }));

  // A posting is final (only a Storno undoes it): the button first shows what will be booked and asks once.
  const [confirming, setConfirming] = useState(false);
  const requestSubmit = () => {
    if (busyRef.current || !dataAdapter?.postAccountingCommand || !canMutate) return;
    const validation = validateForm(form, chart);
    setFeedback(validation.length ? { kind: 'error', text: validation.join(' ') } : null);
    if (validation.length) {
      setTouched({ sourceId: true, date: true, reason: true });
      return;
    }
    if (parseDomainFacts(form, chart).facts) setConfirming(true);
  };
  const submit = async () => {
    setConfirming(false);
    if (busyRef.current || !dataAdapter?.postAccountingCommand || !canMutate) return;
    const validation = validateForm(form, chart);
    setFeedback(validation.length ? { kind: 'error', text: validation.join(' ') } : null);
    if (validation.length) {
      setTouched({ sourceId: true, date: true, reason: true });
      return;
    }
    const parsed = parseDomainFacts(form, chart);
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
        setFeedback({ kind: 'error', text: resultErrors.join(' ') });
        return;
      }
      setFeedback({ kind: 'success', text: result.status === 'duplicate' ? 'Diese Quelle wurde bereits gebucht. Der bestehende Lauf bleibt maßgeblich.' : 'Sonderbuchung wurde erfolgreich gebucht.' });
      // Stay on the workflow just booked; the next Skonto or Rückstellung starts from its own template.
      setForm((current) => ({ ...initialForm(), kind: current.kind, domainFacts: formatFacts(current.kind, '', localToday()) }));
      await refetchHistory();
      setPeriodRefresh((value) => value + 1);
    } catch (error) {
      setFeedback({ kind: 'error', text: caughtDomainErrorMessage(error) || 'Sonderbuchung konnte nicht gespeichert werden.' });
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
      setTaxReasonTouched(true);
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
      setPeriodRefresh((value) => value + 1);
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
    setTaxError(null);
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
      setPreparedArtifact(null);
      setTaxError(error instanceof Error ? error.message : 'Export konnte nicht erstellt werden.');
    } finally {
      setExportBusy(false);
    }
  };

  return (
    <div className="space-y-3.5" data-testid="sonderbuchungen-workspace">
      <h2 className="sr-only">{area === 'tax' ? 'Steuer' : 'Sonderbuchungen & Abschluss'}</h2>

      {!dataAdapter?.postAccountingCommand ? <p className={`border-border bg-surface-muted text-muted ${bannerClass}`} role="status">Sonderbuchungen sind in dieser Verbindung nur lesbar.</p> : null}
      {!canMutate ? <p className={`border-border bg-surface-muted text-muted ${bannerClass}`} role="status">Diese Rolle darf Sonderbuchungen nur lesen.</p> : null}
      {area === 'special' ? (
        <>
      <ManualEntryPanel dataAdapter={dataAdapter} accounts={accounts} chart={chart} canMutate={canMutate} corporation={businessReportingProfile?.legalForm === 'gmbh' || businessReportingProfile?.legalForm === 'ug'} onPosted={(entryId) => { setSelectedJournalEntryId(entryId); setPeriodRefresh((value) => value + 1); }} />
      <section aria-labelledby="special-entry-form-heading">
        <Card padding="none">
          <CardHeader className={cardHeadClass} title={<span id="special-entry-form-heading">1. Vorgang und Angaben</span>} subtitle={selectedWorkflow.description} />
          <div className="flex flex-col gap-3 p-3.5">
            <p className="max-w-3xl text-caption text-muted text-pretty">Vorgang auswählen, Angaben prüfen und erst danach verbindlich buchen. Die Buchungszeilen erzeugt der geprüfte Fachworkflow.</p>
            <Stepper label="Buchungsablauf" steps={['Vorgang', 'Angaben', 'Prüfen & buchen']} current={preview.length > 0 ? 1 : 2} />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Select label="Workflow" aria-label="Workflow" fullWidth value={form.kind} onChange={(event) => selectWorkflow(event.target.value as AccountingCommandKind)} disabled={!canMutate || busy}>
                {workflowGroups.map((group) => <optgroup key={group} label={group}>{workflows.filter((workflow) => workflow.group === group).map((workflow) => <option key={workflow.value} value={workflow.value}>{workflow.label}</option>)}</optgroup>)}
              </Select>
              <Input id="source-id" label={masked ? (form.kind === 'advance_settlement' ? 'Schlussrechnung (Nummer)' : 'Rechnung (Nummer)') : 'Quellbeleg'} aria-label="Quellbeleg" required fullWidth aria-invalid={Boolean(shownErrors.sourceId)} error={shownErrors.sourceId ?? undefined} value={form.sourceId} onChange={(event) => update('sourceId', event.target.value)} onBlur={() => touch('sourceId')} disabled={!canMutate || busy} placeholder="z. B. RE-2026-10-42" />
              <Input id="booking-date" label="Buchungsdatum" aria-label="Buchungsdatum" type="date" required fullWidth aria-invalid={Boolean(shownErrors.date)} error={shownErrors.date ?? undefined} value={form.date} onChange={(event) => update('date', event.target.value)} onBlur={() => touch('date')} disabled={!canMutate || busy} />
              <Field id="audit-reason" label="Audit-Grund (Pflicht)" className="sm:col-span-2 lg:col-span-3">
                <Input aria-label="Audit-Grund" required fullWidth aria-invalid={Boolean(shownErrors.reason)} error={shownErrors.reason ?? undefined} value={form.reason} onChange={(event) => update('reason', event.target.value)} onBlur={() => touch('reason')} disabled={!canMutate || busy} placeholder="Warum wird diese Buchung vorgenommen?" />
              </Field>
            </div>
            {masked ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="settlement-mask">
                {form.kind === 'advance_settlement' ? <Input id="advance-number" label="Abschlagsrechnung (Nummer)" aria-label="Abschlagsrechnung" fullWidth value={form.advanceNumber ?? ''} onChange={(event) => update('advanceNumber', event.target.value)} disabled={!canMutate || busy} placeholder="z. B. RE-2026-0040" /> : null}
                <Input id="settlement-amount" label={form.kind === 'skonto' ? 'Skontobetrag (brutto)' : form.kind === 'bad_debt' ? 'Ausfallbetrag (brutto)' : 'Verrechneter Betrag (brutto)'} aria-label="Betrag (brutto)" inputMode="decimal" fullWidth value={form.amount ?? ''} onChange={(event) => update('amount', event.target.value)} disabled={!canMutate || busy} placeholder="z. B. 23,80" hint="Die Aufteilung auf die Steuersätze übernimmt billme aus der gebuchten Rechnung." />
                {form.kind === 'bad_debt' ? <Input id="bad-debt-evidence" label="Nachweis des Ausfalls" aria-label="Nachweis des Ausfalls" fullWidth value={form.evidence ?? ''} onChange={(event) => update('evidence', event.target.value)} disabled={!canMutate || busy} placeholder="z. B. Insolvenzbekanntmachung AG Berlin" /> : null}
              </div>
            ) : (
            <details className="border-t border-border pt-1">
              <summary className="cursor-pointer select-none py-2 text-label text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring">Fachdaten für Experten bearbeiten</summary>
              <Textarea id="domain-facts" label="Fachdaten (JSON)" aria-label="Domain-Fakten (JSON)" required fullWidth aria-invalid={preview.length > 0} hint="Nur für fachkundige Bearbeitung. Konten und Beträge werden vor der Buchung erneut validiert." value={form.domainFacts} onChange={(event) => update('domainFacts', event.target.value)} disabled={!canMutate || busy} rows={12} spellCheck={false} className="font-mono" />
            </details>
            )}
            {preview.length && pristine ? (
              <div className={`border-border bg-surface-muted ${bannerClass}`} role="status">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-label text-foreground">2. Angaben ergänzen</h3>
                  {parsedFacts ? <span className="text-caption tabular-nums text-muted">Periode {String(parsedFacts.period ?? periodOf(form.date))}</span> : null}
                </div>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-muted">{preview.map((error) => <li key={error}>{error}</li>)}</ul>
              </div>
            ) : (
              <div className={`${preview.length ? 'border-error-border bg-error-bg' : 'border-success-border bg-success-bg'} ${bannerClass}`} role={preview.length ? 'alert' : 'status'}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className={`text-label ${preview.length ? 'text-error-text' : 'text-success-text'}`}>2. {preview.length ? 'Angaben noch unvollständig' : 'Angaben vollständig'}</h3>
                  {parsedFacts ? <span className="text-caption tabular-nums text-muted">Periode {String(parsedFacts.period ?? periodOf(form.date))}</span> : null}
                </div>
                {preview.length ? <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-error-text">{preview.map((error) => <li key={error}>{error}</li>)}</ul> : <p className="mt-1 text-success-text">{selectedWorkflow.label} · {formatEmptyValue(userFacingReference(form.sourceId))} · {form.date}</p>}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border px-3.5 py-3">
            {feedback ? <p data-testid="sonderbuchungen-feedback" className={`min-w-0 flex-1 text-control ${feedback.kind === 'error' ? 'text-error-text' : 'text-success-text'}`} role={feedback.kind === 'error' ? 'alert' : 'status'} aria-live={feedback.kind === 'error' ? 'assertive' : 'polite'}>{feedback.text}</p> : null}
            <Button type="button" variant="dark" onClick={requestSubmit} disabled={busy || preview.length > 0 || !canMutate || !dataAdapter?.postAccountingCommand} aria-busy={busy}>{busy ? 'Buchung läuft…' : 'Prüfen & verbindlich buchen'}</Button>
          </div>
          <ConfirmDialog
            open={confirming}
            title={`${selectedWorkflow.label} verbindlich buchen?`}
            description="Die Buchung wird ins Journal geschrieben. Ändern lässt sie sich danach nur noch mit einem Storno."
            details={(
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-control" data-testid="special-entry-confirm-summary">
                <dt className="text-muted">Vorgang</dt><dd className="text-foreground">{selectedWorkflow.label}</dd>
                <dt className="text-muted">{masked ? 'Rechnung' : 'Quellbeleg'}</dt><dd className="text-foreground">{formatEmptyValue(userFacingReference(form.sourceId))}</dd>
                {masked && form.amount ? <><dt className="text-muted">Betrag (brutto)</dt><dd className="tabular-nums text-foreground">{form.amount} €</dd></> : null}
                <dt className="text-muted">Buchungsdatum</dt><dd className="tabular-nums text-foreground">{form.date}{parsedFacts ? ` · Periode ${String(parsedFacts.period ?? periodOf(form.date))}` : ''}</dd>
                <dt className="text-muted">Audit-Grund</dt><dd className="text-foreground">{form.reason.trim()}</dd>
              </dl>
            )}
            confirmLabel="Verbindlich buchen"
            busy={busy}
            onConfirm={() => void submit()}
            onCancel={() => setConfirming(false)}
          />
        </Card>
      </section>

      <FiscalYearClosePanel dataAdapter={dataAdapter} accounts={accounts} chart={chart} profile={businessReportingProfile} canMutate={canMutate} onPosted={(entryId) => { setSelectedJournalEntryId(entryId); setPeriodRefresh((value) => value + 1); void refetchHistory(); }} />
        </>
      ) : null}
      {area === 'tax' ? (
        <>
      <UstvaPanel dataAdapter={dataAdapter} initialMonth={localToday().slice(0, 7)} onOpenEntry={setSelectedJournalEntryId} />
      <section aria-labelledby="tax-preparation-heading">
        <Card padding="none">
          <CardHeader className={cardHeadClass} title={<span id="tax-preparation-heading">Steuerliche Vorbereitung / Export</span>} subtitle="Friert die Meldung des Zeitraums als Prüfstand ein (UStVA mit Kennzahlen, ZM je USt-IdNr., OSS) und sperrt die Monate einer UStVA weich. Keine Übermittlung an ELSTER oder das BZSt." />
          <div className="flex flex-col gap-3 p-3.5">
            <div className="flex flex-wrap items-end gap-3">
              <Select label="Meldung" aria-label="Steuervorbereitung" value={taxKind} onChange={(event) => { setPreparedArtifact(null); setTaxError(null); setTaxKind(event.target.value as TaxPreparationKind); }} disabled={taxBusy}>
                {taxPreparations.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </Select>
              <Input id="tax-period" label="Zeitraum" aria-label="Steuerzeitraum" type="month" required aria-invalid={Boolean(taxPeriodError)} error={taxPeriodError ?? undefined} value={taxPeriod} onChange={(event) => { setPreparedArtifact(null); setTaxError(null); setTaxPeriod(event.target.value); }} disabled={taxBusy} />
              <Field id="tax-audit-reason" label="Audit-Grund (Pflicht)" className="min-w-60 flex-1">
                <Input aria-label="Audit-Grund Steuerexport" required fullWidth aria-invalid={Boolean(shownTaxReasonError)} error={shownTaxReasonError ?? undefined} value={taxReason} onBlur={() => setTaxReasonTouched(true)} onChange={(event) => setTaxReason(event.target.value)} disabled={taxBusy} />
              </Field>
              <Button type="button" variant="secondary" onClick={() => void prepareTax()} disabled={taxBusy || !dataAdapter?.prepareTaxExport} aria-busy={taxBusy}>{taxBusy ? 'Bereite vor…' : 'Vorbereitung erstellen'}</Button>
            </div>
            {taxError ? <p className="text-control text-error-text" role="alert" aria-live="assertive">{taxError}</p> : null}
            {preparedArtifact ? <div className="flex flex-wrap items-center gap-2"><p className={`text-control ${preparedArtifact.rowCount === 0 ? 'text-muted' : 'text-success-text'}`} role="status" aria-live="polite">{preparedArtifact.rowCount === 0 ? `${taxPreparations.find((item) => item.value === preparedArtifact.kind)?.label ?? preparedArtifact.kind}: Keine meldepflichtigen Vorgänge (keine meldepflichtigen Zeilen).` : `${taxPreparations.find((item) => item.value === preparedArtifact.kind)?.label ?? preparedArtifact.kind} ${preparedArtifact.status === 'prepared' ? 'vorbereitet und eingefroren' : 'vorbereitet'} – keine offizielle Übermittlung. Die Monate des Zeitraums sind jetzt vorläufig gesperrt.`}</p>{preparedArtifact.id && dataAdapter?.exportTaxArtifact ? <Button type="button" size="sm" variant="secondary" onClick={() => void exportTax()} disabled={exportBusy} aria-busy={exportBusy}>{exportBusy ? 'Export läuft…' : 'Vorbereitungs-Export'}</Button> : null}</div> : null}
          </div>
          <div className="grid gap-x-6 gap-y-1 border-t border-border px-3.5 py-3 text-caption text-muted sm:grid-cols-2">
            <p><strong className="font-semibold text-foreground-secondary">E-Bilanz:</strong> Vorbereitung möglich, offizieller Provider nicht verfügbar.</p>
            <p><strong className="font-semibold text-foreground-secondary">Unternehmensregister:</strong> Vorbereitung möglich, offizieller Provider nicht verfügbar.</p>
            {onOpenTaxFiling ? <p className="flex flex-wrap items-center gap-2 sm:col-span-2"><strong className="font-semibold text-foreground-secondary">ELSTER:</strong> billme übermittelt nicht selbst. Eingefrorene EÜR- und E-Bilanz-Berichte prüfen und exportieren: <Button type="button" size="sm" variant="secondary" onClick={onOpenTaxFiling}>ELSTER-Export öffnen</Button></p> : null}
          </div>
        </Card>
      </section>

        </>
      ) : <p className="text-caption text-muted" data-testid="tax-moved-hint">UStVA, ZM und OSS stehen im Bereich Steuer.</p>}
      <PeriodLockPanel dataAdapter={dataAdapter} canMutate={canMutate} refreshToken={periodRefresh} />
      <section aria-labelledby="source-run-history-heading">
        <Card padding="none" className="overflow-hidden">
          <CardHeader className={cardHeadClass} title={<span id="source-run-history-heading">Letzte Buchungsläufe</span>} />
          {historyError ? (
            <div className="flex flex-wrap items-center gap-2 p-3.5" role="alert"><p className="text-control text-error-text">Buchungshistorie konnte nicht geladen werden: {historyError}</p><Button type="button" size="sm" variant="secondary" onClick={() => void refetchHistory().catch(() => undefined)}>Erneut versuchen</Button></div>
          ) : history.length === 0 ? <EmptyState title="Noch keine Sonderbuchung vorhanden." /> : (
            <ul className="divide-y divide-border">
              {history.map((run) => (
                <li key={run.id} className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5 text-control">
                  <span className="min-w-0"><strong className="block truncate font-semibold text-foreground">{formatEmptyValue(userFacingReference(run.sourceId))}</strong><span className="text-caption text-muted">{runStatusLabel[run.status]} · {new Date(run.createdAt).toLocaleString('de-DE')}</span></span>
                  {run.journalEntryId ? <Button type="button" size="sm" variant="secondary" onClick={() => setSelectedJournalEntryId(run.journalEntryId ?? null)}>Journal öffnen</Button> : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
      <JournalEntryDetailModal entryId={selectedJournalEntryId} dataAdapter={dataAdapter} accounts={accounts} canMutate={canMutate} onClose={() => setSelectedJournalEntryId(null)} />
    </div>
  );
}
