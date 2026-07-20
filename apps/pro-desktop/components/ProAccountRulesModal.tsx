import React from 'react';
import { X, Plus, Trash2, Settings2 } from 'lucide-react';
import { Button } from '@billme/ui';
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
  const [isAdding, setIsAdding] = React.useState(false);
  const [editId, setEditId] = React.useState<string | null>(null);
  const [priority, setPriority] = React.useState(10);
  const [field, setField] = React.useState<RuleField>('counterparty');
  const [operator, setOperator] = React.useState<RuleOperator>('contains');
  const [value, setValue] = React.useState('');
  const [targetAccountNumber, setTargetAccountNumber] = React.useState('');
  const [flowType, setFlowType] = React.useState<RuleFlow>('any');

  const { data: rules = [], isLoading: rulesLoading } = useQuery({
    queryKey: ['pro', 'accountSuggestionRules', chartFramework],
    queryFn: () => ipc.pro.listAccountSuggestionRules({ chart: chartFramework }),
  });

  const { data: accounts = [] } = useQuery({
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/50">
      <div className="w-[760px] max-h-[92vh] rounded-xl bg-surface shadow-2xl flex flex-col">
        <div className="flex items-center justify-between border-b border-border p-6">
          <div>
            <h3 className="text-lg font-bold text-foreground">Kontierungsvorschlag-Regeln</h3>
            <p className="text-xs text-muted">Regeln fuer {chartFramework}</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-canvas transition-colors duration-150 ease-out">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6">
          {isAdding ? (
            <div className="rounded-xl border border-border bg-surface-muted p-4 mb-4">
              <h4 className="mb-3 text-sm font-bold text-foreground">{editId ? 'Regel bearbeiten' : 'Neue Regel'}</h4>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="block text-xs font-semibold text-muted mb-1">Feld</label>
                  <select
                    value={field}
                    onChange={(e) => setField(e.target.value as RuleField)}
                    className="w-full rounded-lg border border-border px-3 py-2 text-sm"
                  >
                    {(Object.entries(FIELD_LABELS) as [RuleField, string][]).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-muted mb-1">Bedingung</label>
                  <select
                    value={operator}
                    onChange={(e) => setOperator(e.target.value as RuleOperator)}
                    className="w-full rounded-lg border border-border px-3 py-2 text-sm"
                  >
                    {(Object.entries(OPERATOR_LABELS) as [RuleOperator, string][]).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="mb-3">
                <label className="block text-xs font-semibold text-muted mb-1">Wert</label>
                <input
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="z.B. telefon, telekom, aws"
                  className="w-full rounded-lg border border-border px-3 py-2 text-sm"
                />
              </div>

              <div className="grid grid-cols-3 gap-3 mb-3">
                <div>
                  <label className="block text-xs font-semibold text-muted mb-1">Zielkonto</label>
                  <select
                    value={targetAccountNumber}
                    onChange={(e) => setTargetAccountNumber(e.target.value)}
                    className="w-full rounded-lg border border-border px-3 py-2 text-sm"
                  >
                    <option value="">Bitte waehlen...</option>
                    {accounts.map((acc) => (
                      <option key={acc.id} value={acc.accountNumber}>
                        {acc.accountNumber} - {acc.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-muted mb-1">Flow</label>
                  <select
                    value={flowType}
                    onChange={(e) => setFlowType(e.target.value as RuleFlow)}
                    className="w-full rounded-lg border border-border px-3 py-2 text-sm"
                  >
                    {(Object.entries(FLOW_LABELS) as [RuleFlow, string][]).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-muted mb-1">Prioritaet</label>
                  <input
                    type="number"
                    min={0}
                    value={priority}
                    onChange={(e) => setPriority(Number(e.target.value))}
                    className="w-full rounded-lg border border-border px-3 py-2 text-sm"
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
              <Plus size={14} />
              Neue Regel
            </Button>
          )}

          {rulesLoading ? (
            <p className="text-sm text-muted text-center py-8">Lade Regeln...</p>
          ) : rules.length === 0 ? (
            <div className="text-center py-8 text-muted">
              <Settings2 size={40} className="mx-auto mb-3 opacity-40" />
              <p className="text-sm font-medium">Keine Regeln vorhanden</p>
              <p className="text-xs mt-1">Erstellen Sie Regeln fuer automatische Konto-Vorschlaege.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {rules.map((rule) => (
                <div key={rule.id} className={`rounded-xl border p-3 ${rule.active ? 'border-border bg-surface' : 'border-border-subtle bg-surface-muted opacity-60'}`}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-mono text-xs text-muted">#{rule.priority}</span>
                        <span className="font-semibold text-foreground">{FIELD_LABELS[rule.field as RuleField]}</span>
                        <span className="text-muted">{OPERATOR_LABELS[rule.operator as RuleOperator]}</span>
                        <span className="font-mono text-info bg-info-bg px-2 py-0.5 rounded text-xs">"{rule.value}"</span>
                        <span className="text-xs text-muted">[{FLOW_LABELS[rule.flowType as RuleFlow]}]</span>
                      </div>
                      <div className="text-xs text-muted mt-1">-&gt; Konto {rule.targetAccountNumber}</div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => toggleActive(rule)}
                        className={`px-2 py-1 rounded-lg text-xs font-medium ${rule.active ? 'bg-success-bg text-success' : 'bg-canvas text-muted'}`}
                      >
                        {rule.active ? 'Aktiv' : 'Inaktiv'}
                      </button>
                      <button
                        onClick={() => startEdit(rule)}
                        className="p-1.5 rounded-lg text-muted hover:text-muted hover:bg-canvas transition-colors duration-150 ease-out text-xs"
                      >
                        Bearbeiten
                      </button>
                      <button
                        onClick={() => deleteRule.mutate(rule.id)}
                        className="p-1.5 rounded-lg text-muted hover:text-error hover:bg-error-bg transition-colors duration-150 ease-out"
                      >
                        <Trash2 size={14} />
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
            Schliessen
          </Button>
        </div>
      </div>
    </div>
  );
};
