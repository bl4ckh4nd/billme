import React from 'react';
import { X, Plus, Trash2 } from 'lucide-react';
import { Button, EmptyState, ErrorState, Modal } from '@billme/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../ipc/client';

type RuleField = 'counterparty' | 'purpose' | 'any';
type RuleOperator = 'contains' | 'equals' | 'startsWith';
type RuleFlow = 'income' | 'expense' | 'any';

const FIELD_LABELS: Record<RuleField, string> = {
  counterparty: 'Gegenpartei',
  purpose: 'Verwendungszweck',
  any: 'Beides',
};

const OPERATOR_LABELS: Record<RuleOperator, string> = {
  contains: 'enthaelt',
  equals: 'ist gleich',
  startsWith: 'beginnt mit',
};

const FLOW_LABELS: Record<RuleFlow, string> = {
  income: 'Einnahme',
  expense: 'Ausgabe',
  any: 'Alle',
};

interface ProAccountRulesModalProps {
  chartFramework: 'SKR03' | 'SKR04';
  onClose: () => void;
  onRulesChanged: () => void;
}

export const ProAccountRulesModal: React.FC<ProAccountRulesModalProps> = ({
  chartFramework,
  onClose,
  onRulesChanged,
}) => {
  const queryClient = useQueryClient();
  const titleId = React.useId();
  const descriptionId = React.useId();
  const [isAdding, setIsAdding] = React.useState(false);
  const [editId, setEditId] = React.useState<string | null>(null);
  const [priority, setPriority] = React.useState(10);
  const [field, setField] = React.useState<RuleField>('counterparty');
  const [operator, setOperator] = React.useState<RuleOperator>('contains');
  const [value, setValue] = React.useState('');
  const [targetAccountNumber, setTargetAccountNumber] = React.useState('');
  const [flowType, setFlowType] = React.useState<RuleFlow>('any');

  const {
    data: rules = [],
    isLoading: rulesLoading,
    isError: rulesError,
    refetch: refetchRules,
  } = useQuery({
    queryKey: ['pro', 'accountSuggestionRules', chartFramework],
    queryFn: () => ipc.pro.listAccountSuggestionRules({ chart: chartFramework }),
  });

  const { data: accounts = [], isError: accountsError } = useQuery({
    queryKey: ['pro', 'ledger', 'accounts', chartFramework],
    queryFn: () => ipc.pro.listLedgerAccounts({ chart: chartFramework, limit: 5000 }),
  });

  const resetForm = () => {
    setEditId(null);
    setPriority(10);
    setField('counterparty');
    setOperator('contains');
    setValue('');
    setTargetAccountNumber('');
    setFlowType('any');
    setIsAdding(false);
  };

  const invalidateRules = async () => {
    await queryClient.invalidateQueries({ queryKey: ['pro', 'accountSuggestionRules', chartFramework] });
    onRulesChanged();
  };

  const upsertRule = useMutation({
    mutationFn: (args: Parameters<typeof ipc.pro.upsertAccountSuggestionRule>[0]) =>
      ipc.pro.upsertAccountSuggestionRule(args),
    onSuccess: async () => {
      await invalidateRules();
      resetForm();
    },
  });

  const deleteRule = useMutation({
    mutationFn: (id: string) => ipc.pro.deleteAccountSuggestionRule({ id }),
    onSuccess: async () => {
      await invalidateRules();
    },
  });

  const save = () => {
    if (!value.trim() || !targetAccountNumber.trim()) return;
    upsertRule.mutate({
      id: editId ?? undefined,
      chart: chartFramework,
      priority,
      field,
      operator,
      value: value.trim(),
      targetAccountNumber: targetAccountNumber.trim(),
      flowType,
      active: true,
    });
  };

  const startEdit = (rule: (typeof rules)[number]) => {
    setEditId(rule.id);
    setPriority(rule.priority);
    setField(rule.field as RuleField);
    setOperator(rule.operator as RuleOperator);
    setValue(rule.value);
    setTargetAccountNumber(rule.targetAccountNumber);
    setFlowType(rule.flowType as RuleFlow);
    setIsAdding(true);
  };

  const toggleActive = (rule: (typeof rules)[number]) => {
    upsertRule.mutate({
      id: rule.id,
      chart: rule.chart,
      priority: rule.priority,
      field: rule.field,
      operator: rule.operator,
      value: rule.value,
      targetAccountNumber: rule.targetAccountNumber,
      flowType: rule.flowType,
      active: !rule.active,
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      titleId={titleId}
      descriptionId={descriptionId}
      className="flex max-h-[92vh] max-w-3xl flex-col"
    >
      <div className="flex items-center justify-between border-b border-border p-6">
        <div>
          <h2 id={titleId} className="text-lg font-bold text-foreground">Kontierungsvorschlag-Regeln</h2>
          <p id={descriptionId} className="text-xs text-muted">Regeln für {chartFramework}</p>
        </div>
        <button
          type="button"
          aria-label="Dialog schließen"
          onClick={onClose}
          className="p-2 rounded-lg text-muted hover:bg-surface-muted transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          <X size={20} aria-hidden="true" />
        </button>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {isAdding ? (
          <div className="rounded-xl border border-border bg-surface-muted p-4 mb-4">
            <h3 className="mb-3 text-sm font-bold text-foreground">{editId ? 'Regel bearbeiten' : 'Neue Regel'}</h3>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label htmlFor="rule-field" className="block text-xs font-semibold text-foreground mb-1">Feld</label>
                <select
                  id="rule-field"
                  value={field}
                  onChange={(e) => setField(e.target.value as RuleField)}
                  className="w-full rounded-xl border border-control-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                >
                  {(Object.entries(FIELD_LABELS) as [RuleField, string][]).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="rule-operator" className="block text-xs font-semibold text-foreground mb-1">Bedingung</label>
                <select
                  id="rule-operator"
                  value={operator}
                  onChange={(e) => setOperator(e.target.value as RuleOperator)}
                  className="w-full rounded-xl border border-control-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                >
                  {(Object.entries(OPERATOR_LABELS) as [RuleOperator, string][]).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mb-3">
              <label htmlFor="rule-value" className="block text-xs font-semibold text-foreground mb-1">Wert</label>
              <input
                id="rule-value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="z.B. telefon, telekom, aws"
                className="w-full rounded-xl border border-control-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              />
            </div>

            <div className="grid grid-cols-3 gap-3 mb-3">
              <div>
                <label htmlFor="rule-target" className="block text-xs font-semibold text-foreground mb-1">Zielkonto</label>
                <select
                  id="rule-target"
                  value={targetAccountNumber}
                  onChange={(e) => setTargetAccountNumber(e.target.value)}
                  className="w-full rounded-xl border border-control-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                >
                  <option value="">Bitte wählen ...</option>
                  {accounts.map((acc) => (
                    <option key={acc.id} value={acc.accountNumber}>
                      {acc.accountNumber} - {acc.name}
                    </option>
                  ))}
                </select>
                {accountsError ? (
                  <p className="mt-1 text-xs text-error-text">
                    Konten konnten nicht geladen werden. Ohne sie lässt sich keine Regel anlegen.
                  </p>
                ) : null}
              </div>
              <div>
                <label htmlFor="rule-flow" className="block text-xs font-semibold text-foreground mb-1">Art</label>
                <select
                  id="rule-flow"
                  value={flowType}
                  onChange={(e) => setFlowType(e.target.value as RuleFlow)}
                  className="w-full rounded-xl border border-control-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                >
                  {(Object.entries(FLOW_LABELS) as [RuleFlow, string][]).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="rule-priority" className="block text-xs font-semibold text-foreground mb-1">Priorität</label>
                <input
                  id="rule-priority"
                  type="number"
                  min={0}
                  value={priority}
                  onChange={(e) => setPriority(Number(e.target.value))}
                  className="w-full rounded-xl border border-control-border bg-surface px-3 py-2 text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button size="sm" onClick={save} disabled={!value.trim() || !targetAccountNumber || upsertRule.isPending}>
                {upsertRule.isPending ? 'Speichern...' : editId ? 'Aktualisieren' : 'Regel erstellen'}
              </Button>
              <Button size="sm" variant="secondary" onClick={resetForm}>
                Abbrechen
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setIsAdding(true)} className="mb-4">
            <Plus size={14} aria-hidden="true" />
            Neue Regel
          </Button>
        )}

        {rulesLoading ? (
          <p className="text-sm text-muted text-center py-8">Lade Regeln...</p>
        ) : rulesError ? (
          <ErrorState
            title="Regeln konnten nicht geladen werden"
            description="Die Liste ist deshalb leer, nicht weil keine Regeln vorhanden sind."
            onRetry={() => void refetchRules()}
          />
        ) : rules.length === 0 ? (
          <EmptyState
            title="Keine Regeln vorhanden"
            description="Erstellen Sie Regeln für automatische Kontovorschläge."
          />
        ) : (
          <div className="space-y-2">
            {rules.map((rule) => (
              <div key={rule.id} className={`rounded-xl border p-3 ${rule.active ? 'border-border bg-surface' : 'border-border-subtle bg-surface-muted opacity-60'}`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-xs text-muted tabular-nums">#{rule.priority}</span>
                      <span className="font-semibold text-foreground">{FIELD_LABELS[rule.field as RuleField]}</span>
                      <span className="text-muted">{OPERATOR_LABELS[rule.operator as RuleOperator]}</span>
                      <span className="bg-info-bg px-2 py-0.5 rounded-sm text-xs text-info-text">"{rule.value}"</span>
                      <span className="text-xs text-muted">[{FLOW_LABELS[rule.flowType as RuleFlow]}]</span>
                    </div>
                    <div className="text-xs text-muted mt-1">-&gt; Konto {rule.targetAccountNumber}</div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      aria-pressed={rule.active}
                      onClick={() => toggleActive(rule)}
                      className={`px-2 py-1 rounded-lg text-xs font-medium border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${rule.active ? 'border-success-border bg-success-bg text-success-text' : 'border-border bg-surface-muted text-muted'}`}
                    >
                      {rule.active ? 'Aktiv' : 'Inaktiv'}
                    </button>
                    <button
                      type="button"
                      onClick={() => startEdit(rule)}
                      className="p-1.5 rounded-lg text-xs text-muted hover:text-foreground hover:bg-surface-muted transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                    >
                      Bearbeiten
                    </button>
                    <button
                      type="button"
                      aria-label="Regel löschen"
                      onClick={() => deleteRule.mutate(rule.id)}
                      className="p-1.5 rounded-lg text-muted hover:text-error-text hover:bg-error-bg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-border p-6 flex justify-end">
        <Button size="sm" variant="secondary" onClick={onClose}>
          Schließen
        </Button>
      </div>
    </Modal>
  );
};
