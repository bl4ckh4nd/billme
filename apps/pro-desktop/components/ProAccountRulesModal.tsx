import React from 'react';
import { X, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, EmptyState, ErrorState, IconButton, Input, Modal, Select } from '@billme/ui';
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
      className="flex max-h-[84vh] max-w-3xl flex-col"
    >
      <div className="flex items-start gap-3 px-4.5 pb-2.5 pt-4">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-title text-foreground">Kontierungsvorschlag-Regeln</h2>
          <p id={descriptionId} className="text-caption text-muted">Regeln für {chartFramework}</p>
        </div>
        <IconButton aria-label="Dialog schließen" tooltip={false} onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </IconButton>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4.5 pb-4 pt-1">
        {isAdding ? (
          <div className="rounded-card border border-border bg-surface-muted p-3.5">
            <h3 className="mb-3 text-sm font-semibold text-foreground">{editId ? 'Regel bearbeiten' : 'Neue Regel'}</h3>
            <div className="mb-3 grid grid-cols-2 gap-3">
              <Select id="rule-field" label="Feld" fullWidth value={field} onChange={(e) => setField(e.target.value as RuleField)}>
                {(Object.entries(FIELD_LABELS) as [RuleField, string][]).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
              <Select id="rule-operator" label="Bedingung" fullWidth value={operator} onChange={(e) => setOperator(e.target.value as RuleOperator)}>
                {(Object.entries(OPERATOR_LABELS) as [RuleOperator, string][]).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            </div>

            <div className="mb-3">
              <Input
                id="rule-value"
                label="Wert"
                fullWidth
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="z.B. telefon, telekom, aws"
              />
            </div>

            <div className="mb-3 grid grid-cols-3 gap-3">
              <Select
                id="rule-target"
                label="Zielkonto"
                fullWidth
                value={targetAccountNumber}
                onChange={(e) => setTargetAccountNumber(e.target.value)}
                error={accountsError ? 'Konten konnten nicht geladen werden. Ohne sie lässt sich keine Regel anlegen.' : undefined}
              >
                <option value="">Bitte wählen ...</option>
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.accountNumber}>
                    {acc.accountNumber} - {acc.name}
                  </option>
                ))}
              </Select>
              <Select id="rule-flow" label="Art" fullWidth value={flowType} onChange={(e) => setFlowType(e.target.value as RuleFlow)}>
                {(Object.entries(FLOW_LABELS) as [RuleFlow, string][]).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
              <Input
                id="rule-priority"
                label="Priorität"
                type="number"
                min={0}
                fullWidth
                className="tabular-nums"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
              />
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
          <div>
            <Button size="sm" variant="secondary" onClick={() => setIsAdding(true)}>
              <Plus size={14} aria-hidden="true" />
              Neue Regel
            </Button>
          </div>
        )}

        {rulesLoading ? (
          <p className="py-8 text-center text-control text-muted">Lade Regeln...</p>
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
          <div className="divide-y divide-border rounded-card border border-border">
            {rules.map((rule) => (
              <div key={rule.id} className={`flex items-center justify-between gap-3 px-3 py-2.25 ${rule.active ? '' : 'bg-surface-muted'}`}>
                <div className={`min-w-0 flex-1 ${rule.active ? '' : 'opacity-60'}`}>
                  <div className="flex flex-wrap items-center gap-2 text-control">
                    <span className="font-mono text-caption text-muted tabular-nums">#{rule.priority}</span>
                    <span className="font-semibold text-foreground">{FIELD_LABELS[rule.field as RuleField]}</span>
                    <span className="text-muted">{OPERATOR_LABELS[rule.operator as RuleOperator]}</span>
                    <Badge tone="info">"{rule.value}"</Badge>
                    <span className="text-caption text-muted">[{FLOW_LABELS[rule.flowType as RuleFlow]}]</span>
                  </div>
                  <div className="mt-0.5 text-caption text-muted">
                    -&gt; Konto {rule.targetAccountNumber}
                    <span data-rule-hits className="ml-2 tabular-nums">
                      · {rule.hitCount ? `${rule.hitCount} Treffer, zuletzt ${new Date(rule.lastHitAt ?? '').toLocaleDateString('de-DE')}` : 'noch kein Treffer'}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-pressed={rule.active}
                    onClick={() => toggleActive(rule)}
                    className={rule.active ? 'border-success-border bg-success-bg text-success-text' : 'text-muted'}
                  >
                    {rule.active ? 'Aktiv' : 'Inaktiv'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => startEdit(rule)}>
                    Bearbeiten
                  </Button>
                  <IconButton size="sm" aria-label="Regel löschen" tooltip={false} onClick={() => deleteRule.mutate(rule.id)}>
                    <Trash2 size={14} aria-hidden="true" />
                  </IconButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4.5 py-3">
        <Button variant="secondary" onClick={onClose}>
          Schließen
        </Button>
      </div>
    </Modal>
  );
};
