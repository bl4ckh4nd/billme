import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { Badge, Button, IconButton, Input, Select, SegmentedControl, Switch } from '@billme/ui';
import { bookingRuleMatches, parseRuleAmount, ruleRegexError, type BookingRule, type RuleCondition } from '@billme/finance-intelligence';
import { SettingsCard } from '@billme/desktop-renderer/components/SettingsView';
import type { IpcArgs, IpcResult } from '@billme/desktop-contracts-pro/contract';
import { ipc } from '../ipc/client';
import { useProActiveChart } from '../hooks/useProLedger';

type Rule = IpcResult<'pro:listAccountSuggestionRules'>[number];
type Preview = IpcResult<'pro:previewRuleApplication'>;

const FIELD_LABELS: Record<RuleCondition['field'], string> = {
  counterparty: 'Gegenpartei', purpose: 'Verwendungszweck', any: 'Gegenpartei oder Zweck', iban: 'Gegen-IBAN', amount: 'Betrag', account: 'Finanzkonto',
};
const TEXT_OPERATORS: Array<[RuleCondition['operator'], string]> = [['contains', 'enthält'], ['equals', 'ist gleich'], ['startsWith', 'beginnt mit'], ['regex', 'Regex']];
const AMOUNT_OPERATORS: Array<[RuleCondition['operator'], string]> = [['equals', 'ist genau'], ['gte', 'ab'], ['lte', 'bis'], ['between', 'zwischen']];
const SIGN_LABELS = { expense: 'Ausgang', income: 'Eingang', any: 'Beide' } as const;
const KIND_LABELS: Record<Preview['rows'][number]['kind'], string> = { new: 'neu', update: 'wird geändert', protected: 'geschützt', posted: 'gebucht, nur Hinweis' };

interface Draft {
  id?: string;
  name: string;
  stage: 'base' | 'override';
  logic: 'and' | 'or';
  flowType: 'income' | 'expense' | 'any';
  priority: number;
  conditions: RuleCondition[];
  accountNumber: string;
  taxCaseKey: string;
  deductiblePercent: string;
  memo: string;
  autoPost: boolean;
  stop: boolean;
  active: boolean;
}

const emptyDraft = (priority: number): Draft => ({
  name: '', stage: 'base', logic: 'and', flowType: 'expense', priority, conditions: [{ field: 'counterparty', operator: 'contains', value: '' }],
  accountNumber: '', taxCaseKey: '', deductiblePercent: '', memo: '', autoPost: false, stop: false, active: true,
});

const fromRule = (rule: Rule): Draft => ({
  id: rule.id, name: rule.name ?? rule.value, stage: rule.stage ?? 'base', logic: rule.logic ?? 'and', flowType: rule.flowType, priority: rule.priority,
  conditions: rule.conditions?.length ? rule.conditions : [{ field: rule.field, operator: rule.operator, value: rule.value }],
  accountNumber: rule.actions?.accountNumber ?? rule.targetAccountNumber, taxCaseKey: rule.actions?.taxCaseKey ?? '',
  deductiblePercent: rule.actions?.deductiblePercent === undefined ? '' : String(rule.actions.deductiblePercent), memo: rule.actions?.memo ?? '',
  autoPost: Boolean(rule.autoPost), stop: Boolean(rule.stop), active: rule.active,
});

const toEngineRule = (draft: Draft): BookingRule => ({
  priority: draft.priority, stage: draft.stage, logic: draft.logic, flowType: draft.flowType, active: true,
  conditions: draft.conditions.filter((condition) => condition.value.trim()),
});

const money = (value: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);

/** Problems the server would reject, said before saving. */
const draftProblems = (draft: Draft): string[] => {
  const problems: string[] = [];
  if (!draft.name.trim()) problems.push('Name fehlt.');
  if (!draft.conditions.some((condition) => condition.value.trim())) problems.push('Mindestens eine Bedingung braucht einen Wert.');
  for (const condition of draft.conditions) {
    if (condition.operator === 'regex' && condition.value) {
      const error = ruleRegexError(condition.value);
      if (error) problems.push(`Regex: ${error}`);
    }
    if (condition.field === 'amount' && condition.value && Number.isNaN(parseRuleAmount(condition.value))) problems.push('Betrag ist keine Zahl.');
  }
  if (draft.stage === 'base' && !draft.accountNumber.trim()) problems.push('Eine Basisregel braucht ein Konto.');
  if (draft.stage === 'override' && !draft.accountNumber && !draft.taxCaseKey && !draft.deductiblePercent && !draft.memo) problems.push('Ein Override muss mindestens ein Feld setzen.');
  const pct = Number(draft.deductiblePercent);
  if (draft.deductiblePercent && !(pct >= 0 && pct <= 100)) problems.push('Abzugsfähig muss zwischen 0 und 100 % liegen.');
  return problems;
};

const ruleFromTransactionId = () => new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('ruleFrom');

/** Einstellungen › Buchhaltung › Buchungsregeln: list, editor with live test, and "Auf Bestand anwenden". */
export const ProBookingRulesSettings: React.FC = () => {
  const queryClient = useQueryClient();
  const chart = useProActiveChart();
  const rulesQuery = useQuery({ queryKey: ['pro', 'accountSuggestionRules', chart], queryFn: () => ipc.pro.listAccountSuggestionRules({ chart }) });
  const { data: ledger = [] } = useQuery({ queryKey: ['pro', 'ledger', 'accounts', { chart, limit: 5000 }], queryFn: () => ipc.pro.listLedgerAccounts({ chart, limit: 5000 }) });
  const { data: taxCases = [] } = useQuery({ queryKey: ['pro', 'taxCases'], queryFn: () => ipc.pro.listTaxCases({}) });
  const { data: transactions = [] } = useQuery({ queryKey: ['pro', 'bankTransactions', 'rules'], queryFn: () => ipc.pro.listBankTransactions() });
  const { data: financialAccounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: () => ipc.accounts.list() });
  const rules = rulesQuery.data ?? [];

  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [status, setStatus] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const accountListId = React.useId();

  // "Regel aus diesem Umsatz": the Bankabgleich links here with the line's id.
  const prefillId = React.useRef(ruleFromTransactionId());
  React.useEffect(() => {
    const source = prefillId.current ? transactions.find((tx) => tx.id === prefillId.current) : undefined;
    if (!source || !rulesQuery.data) return;
    prefillId.current = null;
    setDraft({
      ...emptyDraft(nextPriority(rulesQuery.data)), name: source.counterparty, flowType: source.amount < 0 ? 'expense' : 'income',
      conditions: [{ field: 'counterparty', operator: 'contains', value: source.counterparty }], accountNumber: source.suggestedAccountNumber ?? '',
    });
  }, [transactions, rulesQuery.data]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['pro', 'accountSuggestionRules'] });
    // Bankabgleich and Buchen cache transactions and drafts under this prefix.
    void queryClient.invalidateQueries({ queryKey: ['pro-accounting'] });
  };

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Speichern fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  };

  const save = (value: Draft) => run(async () => {
    const actions = {
      ...(value.accountNumber.trim() ? { accountNumber: value.accountNumber.trim() } : {}),
      ...(value.taxCaseKey ? { taxCaseKey: value.taxCaseKey } : {}),
      ...(value.deductiblePercent ? { deductiblePercent: Number(value.deductiblePercent) } : {}),
      ...(value.memo.trim() ? { memo: value.memo.trim() } : {}),
    };
    const args: IpcArgs<'pro:upsertAccountSuggestionRule'> = {
      id: value.id, chart, priority: value.priority, field: 'any', operator: 'contains', value: '', targetAccountNumber: '',
      flowType: value.flowType, active: value.active, name: value.name.trim(), stage: value.stage, logic: value.logic,
      conditions: value.conditions.filter((condition) => condition.value.trim()), actions, autoPost: value.autoPost, stop: value.stop,
    };
    await ipc.pro.upsertAccountSuggestionRule(args);
    setDraft(null);
    setPreview(null);
    await refresh();
  });

  const remove = (rule: Rule) => run(async () => {
    await ipc.pro.deleteAccountSuggestionRule({ id: rule.id });
    setPreview(null);
    await refresh();
  });

  const toggle = (rule: Rule) => save({ ...fromRule(rule), active: !rule.active });

  const startPreview = () => run(async () => {
    setStatus(null);
    setPreview(await ipc.pro.previewRuleApplication());
  });

  const apply = () => run(async () => {
    if (!preview) return;
    const result = await ipc.pro.applyRules({ previewHash: preview.hash });
    setStatus(`${result.updated} ${result.updated === 1 ? 'Entwurf' : 'Entwürfe'} neu vorgeschlagen.`);
    setPreview(null);
    await refresh();
  });

  return (
    <div className="col-span-full flex flex-col gap-3.5">
      <datalist id={accountListId}>
        {ledger.map((account) => <option key={account.accountNumber} value={account.accountNumber}>{account.name}</option>)}
      </datalist>

      <SettingsCard
        title="Buchungsregeln"
        subtitle="Basisregeln schlagen den ganzen Buchungssatz vor. Overrides ändern danach einzelne Felder, in Reihenfolge der Priorität. Gemerkte Gegenparteien und KI-Vorschläge greifen nur, wenn keine Basisregel passt."
        actions={!draft && <Button size="sm" onClick={() => setDraft(emptyDraft(nextPriority(rules)))}><Plus size={14} aria-hidden="true" /> Neue Regel</Button>}
        flush
      >
        {error && <p className="mx-3.5 mt-3 rounded-control border border-error-border bg-error-bg px-3 py-2.5 text-control text-error-text" role="alert">{error}</p>}
        {draft && (
          <RuleEditor
            draft={draft}
            onChange={setDraft}
            onCancel={() => setDraft(null)}
            onSave={() => void save(draft)}
            busy={busy}
            accountListId={accountListId}
            taxCases={taxCases}
            financialAccounts={financialAccounts}
            transactions={transactions}
            ledger={ledger}
          />
        )}
        {rulesQuery.isLoading ? (
          <p className="px-3.5 py-3 text-control text-muted" role="status">Regeln werden geladen…</p>
        ) : rules.length === 0 ? (
          <p className="px-3.5 py-3 text-control text-muted">Noch keine Regeln. Am schnellsten geht es im Bankabgleich mit „Regel aus diesem Umsatz“.</p>
        ) : (
          <ul aria-label="Regeln">
            {rules.map((rule) => (
              <li key={rule.id} className="flex flex-wrap items-center gap-2.5 border-t border-border px-3.5 py-2.5">
                <span className="w-10 shrink-0 font-mono text-caption tabular-nums text-muted">{rule.priority}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-label text-foreground">{rule.name ?? rule.value}</span>
                    <Badge tone={(rule.stage ?? 'base') === 'base' ? 'neutral' : 'info'}>{(rule.stage ?? 'base') === 'base' ? 'Basis' : 'Override'}</Badge>
                    {rule.autoPost && <Badge tone="accent">bucht automatisch</Badge>}
                    {rule.stop && <Badge tone="neutral">stoppt</Badge>}
                    {!rule.active && <Badge tone="warning">deaktiviert</Badge>}
                  </span>
                  <span className="block truncate text-caption text-muted">
                    Wenn {conditionText(rule)} · dann {resultText(rule)}
                  </span>
                  <span className="block text-caption tabular-nums text-muted">
                    {rule.hitCount ? `${rule.hitCount} Treffer, zuletzt ${rule.lastHitAt ? new Date(rule.lastHitAt).toLocaleDateString('de-DE') : 'unbekannt'}` : 'noch nie gebucht'}
                  </span>
                </span>
                <Switch checked={rule.active} onCheckedChange={() => void toggle(rule)} aria-label={`${rule.name ?? rule.value} aktiv`} disabled={busy} />
                <Button variant="secondary" size="sm" onClick={() => setDraft(fromRule(rule))} disabled={busy}>Bearbeiten</Button>
                <IconButton variant="ghost" size="sm" aria-label={`${rule.name ?? rule.value} löschen`} onClick={() => void remove(rule)} disabled={busy}><Trash2 size={14} aria-hidden="true" /></IconButton>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>

      <SettingsCard
        title="Auf Bestand anwenden"
        subtitle="Der Probelauf zeigt, welche offenen Entwürfe die Regeln heute anders vorschlagen würden. Von Hand geänderte oder freigegebene Entwürfe bleiben unverändert. Gebuchtes ändert sich nur per Storno und neuer Buchung."
        actions={<Button variant="secondary" size="sm" onClick={() => void startPreview()} loading={busy && !preview}>Probelauf starten</Button>}
        flush
      >
        {status && <p className="px-3.5 py-3 text-control text-success-text" role="status">{status}</p>}
        {preview && (preview.rows.length === 0 ? (
          <p className="px-3.5 py-3 text-control text-muted" role="status">Keine Änderungen. Alle Entwürfe entsprechen den Regeln.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5 px-3.5 py-2.5" role="status">
              {(Object.keys(KIND_LABELS) as Array<keyof typeof KIND_LABELS>).map((kind) => preview.counts[kind] > 0 && (
                <Badge key={kind} tone={kind === 'protected' ? 'warning' : kind === 'posted' ? 'neutral' : 'info'}>{preview.counts[kind]} {KIND_LABELS[kind]}</Badge>
              ))}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-control" aria-label="Probelauf">
                <thead>
                  <tr className="text-caption text-muted">
                    <th scope="col" className="px-3.5 py-1.5 text-left font-medium">Umsatz</th>
                    <th scope="col" className="px-3.5 py-1.5 text-right font-medium">Betrag</th>
                    <th scope="col" className="px-3.5 py-1.5 text-left font-medium">Bisher</th>
                    <th scope="col" className="px-3.5 py-1.5 text-left font-medium">Neu</th>
                    <th scope="col" className="px-3.5 py-1.5 text-left font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.transactionId} className="border-t border-border align-top">
                      <td className="px-3.5 py-1.5"><span className="text-foreground">{row.counterparty}</span><span className="block text-caption text-muted">{new Date(row.date).toLocaleDateString('de-DE')}</span></td>
                      <td className="px-3.5 py-1.5 text-right font-mono tabular-nums">{money(row.amount)}</td>
                      <td className="px-3.5 py-1.5 font-mono tabular-nums text-muted">{row.before.accountNumber ?? '–'}{row.before.taxCaseKey ? ` · ${row.before.taxCaseKey}` : ''}</td>
                      <td className="px-3.5 py-1.5"><span className="font-mono tabular-nums text-foreground">{row.after.accountNumber ?? '–'}{row.after.taxCaseKey ? ` · ${row.after.taxCaseKey}` : ''}</span>{row.after.ruleNames && <span className="block text-caption text-muted">{row.after.ruleNames.join(' + ')}</span>}</td>
                      <td className="px-3.5 py-1.5"><Badge tone={row.kind === 'protected' ? 'warning' : row.kind === 'posted' ? 'neutral' : 'info'}>{KIND_LABELS[row.kind]}</Badge>{row.note && <span className="block text-caption text-muted">{row.note}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-border px-3.5 py-2.5">
              <Button size="sm" onClick={() => void apply()} disabled={busy || preview.counts.new + preview.counts.update === 0}>
                {preview.counts.new + preview.counts.update} {preview.counts.new + preview.counts.update === 1 ? 'Entwurf' : 'Entwürfe'} neu vorschlagen
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setPreview(null)}>Verwerfen</Button>
            </div>
          </>
        ))}
      </SettingsCard>
    </div>
  );
};

const nextPriority = (rules: Rule[]) => (rules.length ? Math.max(...rules.map((rule) => rule.priority)) + 10 : 10);

const conditionText = (rule: Rule) => {
  const conditions = rule.conditions?.length ? rule.conditions : [{ field: rule.field, operator: rule.operator, value: rule.value }];
  const text = conditions.map((condition) => `${FIELD_LABELS[condition.field]} ${[...TEXT_OPERATORS, ...AMOUNT_OPERATORS].find(([op]) => op === condition.operator)?.[1] ?? condition.operator} „${condition.value}${condition.valueTo ? `–${condition.valueTo}` : ''}“`);
  return `${SIGN_LABELS[rule.flowType]}: ${text.join(rule.logic === 'or' ? ' oder ' : ' und ')}`;
};

const resultText = (rule: Rule) => {
  const actions = rule.actions ?? { accountNumber: rule.targetAccountNumber };
  return [actions.accountNumber && `Konto ${actions.accountNumber}`, actions.taxCaseKey, actions.deductiblePercent !== undefined && `${actions.deductiblePercent} % abzugsfähig`, actions.memo && `Text „${actions.memo}“`].filter(Boolean).join(', ') || '–';
};

function RuleEditor({ draft, onChange, onCancel, onSave, busy, accountListId, taxCases, financialAccounts, transactions, ledger }: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  onCancel: () => void;
  onSave: () => void;
  busy: boolean;
  accountListId: string;
  taxCases: IpcResult<'pro:listTaxCases'>;
  financialAccounts: Array<{ id: string; name: string }>;
  transactions: IpcResult<'pro:listBankTransactions'>;
  ledger: IpcResult<'pro:listLedgerAccounts'>;
}) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const setCondition = (index: number, patch: Partial<RuleCondition>) => set({ conditions: draft.conditions.map((condition, i) => (i === index ? { ...condition, ...patch } : condition)) });
  const problems = draftProblems(draft);
  const engineRule = toEngineRule(draft);
  const hits = engineRule.conditions?.length
    ? transactions.filter((tx) => bookingRuleMatches(engineRule, { flowType: tx.amount < 0 ? 'expense' : 'income', counterparty: tx.counterparty, purpose: tx.purpose, amount: tx.amount, accountId: tx.accountId, counterpartyIban: tx.counterpartyIban }))
    : [];
  const sample = hits[0];
  const taxCase = taxCases.find((entry) => entry.key === draft.taxCaseKey);
  const accountName = ledger.find((account) => account.accountNumber === draft.accountNumber)?.name;

  return (
    <div className="grid gap-3.5 border-t border-border p-3.5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,0.9fr)]">
      <fieldset className="flex min-w-0 flex-col gap-2.5">
        <legend className="mb-1 text-eyebrow uppercase text-muted">Wenn</legend>
        <Input label="Name" value={draft.name} onChange={(event) => set({ name: event.target.value })} fullWidth />
        <div className="flex flex-wrap gap-2">
          <SegmentedControl
            aria-label="Stufe"
            value={draft.stage}
            onChange={(stage) => set({ stage: stage as Draft['stage'] })}
            options={[{ value: 'base', label: 'Basis' }, { value: 'override', label: 'Override' }]}
          />
          <SegmentedControl
            aria-label="Vorzeichen"
            value={draft.flowType}
            onChange={(flowType) => set({ flowType: flowType as Draft['flowType'] })}
            options={(['expense', 'income', 'any'] as const).map((value) => ({ value, label: SIGN_LABELS[value] }))}
          />
          <SegmentedControl
            aria-label="Verknüpfung"
            value={draft.logic}
            onChange={(logic) => set({ logic: logic as Draft['logic'] })}
            options={[{ value: 'and', label: 'alle (UND)' }, { value: 'or', label: 'eine (ODER)' }]}
          />
        </div>
        {draft.conditions.map((condition, index) => {
          const operators = condition.field === 'amount' ? AMOUNT_OPERATORS : condition.field === 'account' || condition.field === 'iban' ? [['equals', 'ist'] as [RuleCondition['operator'], string]] : TEXT_OPERATORS;
          return (
            <div key={index} className="flex flex-wrap items-end gap-1.5 rounded-control border border-border p-2">
              <Select aria-label="Feld" value={condition.field} onChange={(event) => {
                const field = event.target.value as RuleCondition['field'];
                setCondition(index, { field, operator: field === 'amount' ? 'gte' : field === 'account' || field === 'iban' ? 'equals' : 'contains', value: '' });
              }}>
                {(Object.keys(FIELD_LABELS) as Array<RuleCondition['field']>).map((field) => <option key={field} value={field}>{FIELD_LABELS[field]}</option>)}
              </Select>
              <Select aria-label="Vergleich" value={condition.operator} onChange={(event) => setCondition(index, { operator: event.target.value as RuleCondition['operator'] })}>
                {operators.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </Select>
              {condition.field === 'account' ? (
                <Select aria-label="Finanzkonto" value={condition.value} onChange={(event) => setCondition(index, { value: event.target.value })}>
                  <option value="">Konto wählen</option>
                  {financialAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
                </Select>
              ) : (
                <div className="min-w-32 flex-1">
                  <Input aria-label="Wert" value={condition.value} onChange={(event) => setCondition(index, { value: event.target.value })} placeholder={condition.field === 'amount' ? '800,00' : condition.operator === 'regex' ? '^(telekom|vodafone)' : ''} fullWidth />
                </div>
              )}
              {condition.operator === 'between' && (
                <div className="w-28"><Input aria-label="bis" value={condition.valueTo ?? ''} onChange={(event) => setCondition(index, { valueTo: event.target.value })} placeholder="1.500,00" fullWidth /></div>
              )}
              <IconButton variant="ghost" size="sm" aria-label="Bedingung entfernen" onClick={() => set({ conditions: draft.conditions.filter((_, i) => i !== index) })} disabled={draft.conditions.length === 1}>
                <Trash2 size={14} aria-hidden="true" />
              </IconButton>
            </div>
          );
        })}
        <Button variant="ghost" size="sm" className="self-start" onClick={() => set({ conditions: [...draft.conditions, { field: 'purpose', operator: 'contains', value: '' }] })}>
          <Plus size={14} aria-hidden="true" /> Bedingung
        </Button>
        <Input label="Priorität" type="number" value={String(draft.priority)} onChange={(event) => set({ priority: Number(event.target.value) || 0 })} hint="Kleinere Zahl läuft zuerst." />
      </fieldset>

      <fieldset className="flex min-w-0 flex-col gap-2.5">
        <legend className="mb-1 text-eyebrow uppercase text-muted">Dann</legend>
        <Input label="Konto" list={accountListId} value={draft.accountNumber} onChange={(event) => set({ accountNumber: event.target.value })} hint={accountName ?? (draft.stage === 'override' ? 'Leer lassen, um das Konto nicht zu ändern.' : undefined)} fullWidth />
        <Select label="Steuerfall" value={draft.taxCaseKey} onChange={(event) => set({ taxCaseKey: event.target.value })} fullWidth>
          <option value="">{draft.stage === 'override' ? 'nicht ändern' : 'ohne Steuer'}</option>
          {taxCases.filter((entry) => entry.active).map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}
        </Select>
        <Input label="Vorsteuer abzugsfähig (%)" type="number" min={0} max={100} value={draft.deductiblePercent} onChange={(event) => set({ deductiblePercent: event.target.value })} placeholder="100" hint="Der Rest bleibt auf dem Aufwandskonto, etwa bei gemischt genutztem Telefon." fullWidth />
        <Input label="Buchungstext" value={draft.memo} onChange={(event) => set({ memo: event.target.value })} placeholder="{Gegenpartei} – {Verwendungszweck}" fullWidth />
        <Switch checked={draft.autoPost} onCheckedChange={(autoPost) => set({ autoPost })} label="Automatisch buchen" description="Treffer werden beim Import gleich gebucht. Nie in festgeschriebenen Monaten." />
        <Switch checked={draft.stop} onCheckedChange={(stop) => set({ stop })} label="Danach keine weiteren Regeln" />
        <BookingPreview sample={sample} accountNumber={draft.accountNumber || '…'} rate={taxCase?.mechanism === 'standard_vat' ? taxCase.defaultRate : 0} deductible={draft.deductiblePercent ? Number(draft.deductiblePercent) : 100} />
      </fieldset>

      <div className="flex min-w-0 flex-col gap-2">
        <div className="text-eyebrow uppercase text-muted">Live-Test</div>
        <p className="text-control text-foreground" role="status">{hits.length} von {transactions.length} Umsätzen passen.</p>
        <ul className="flex flex-col divide-y divide-border rounded-control border border-border">
          {hits.slice(0, 8).map((tx) => (
            <li key={tx.id} className="flex justify-between gap-2 px-2.5 py-1.5 text-caption">
              <span className="min-w-0 truncate text-foreground">{tx.counterparty}</span>
              <span className="shrink-0 font-mono tabular-nums">{money(tx.amount)}</span>
            </li>
          ))}
          {hits.length === 0 && <li className="px-2.5 py-1.5 text-caption text-muted">Kein Umsatz passt.</li>}
        </ul>
        {problems.length > 0 && <ul className="text-caption text-warning-text" aria-label="Noch offen">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
        <div className="mt-auto flex flex-wrap gap-2">
          <Button size="sm" onClick={onSave} disabled={busy || problems.length > 0}>Regel speichern</Button>
          <Button variant="ghost" size="sm" onClick={onCancel}>Abbrechen</Button>
        </div>
      </div>
    </div>
  );
}

/** The Buchungssatz the rule would write for the first matching line (or 119 € as an example). */
function BookingPreview({ sample, accountNumber, rate, deductible }: { sample?: { amount: number; counterparty: string }; accountNumber: string; rate: number; deductible: number }) {
  const gross = Math.abs(sample?.amount ?? -119);
  const moneyIn = (sample?.amount ?? -119) > 0;
  const net = Math.round((gross / (1 + rate / 100)) * 100) / 100;
  const tax = Math.round((gross - net) * 100) / 100;
  const vst = moneyIn ? tax : Math.round(tax * deductible) / 100;
  const rows: Array<[string, string, number]> = [[accountNumber, moneyIn ? 'Haben' : 'Soll', Math.round((gross - vst) * 100) / 100]];
  if (vst > 0) rows.push([moneyIn ? 'Umsatzsteuer' : 'Vorsteuer', moneyIn ? 'Haben' : 'Soll', vst]);
  rows.push(['Bank', moneyIn ? 'Soll' : 'Haben', gross]);
  return (
    <div className="flex flex-col gap-1">
      <div className="text-caption text-muted">Buchungssatz{sample ? ` für ${sample.counterparty}` : ' (Beispiel 119 €)'}</div>
      <div className="divide-y divide-border rounded-control border border-border">
        {rows.map(([account, side, amount]) => (
          <div key={`${account}-${side}`} className="flex justify-between gap-2 px-2.5 py-1.5 text-caption">
            <span className="font-mono tabular-nums text-foreground">{account}</span>
            <span className="font-mono tabular-nums text-foreground">{side} {money(amount)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
