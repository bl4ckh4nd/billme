import React, { useState } from 'react';
import { X, Plus, Trash2, Settings2, AlertCircle } from 'lucide-react';
import { Button, EmptyState, ErrorState, Modal } from '@billme/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { v4 as uuidv4 } from 'uuid';
import { ipc } from '../runtime-api';

type RuleField = 'counterparty' | 'purpose' | 'any';
type RuleOperator = 'contains' | 'equals' | 'startsWith';

interface EurRulesModalProps {
  taxYear: number;
  onClose: () => void;
  onRulesChanged: () => void;
}

const FIELD_LABELS: Record<RuleField, string> = {
  counterparty: 'Gegenpartei',
  purpose: 'Verwendungszweck',
  any: 'Beides',
};

const OPERATOR_LABELS: Record<RuleOperator, string> = {
  contains: 'enthält',
  equals: 'ist gleich',
  startsWith: 'beginnt mit',
};

const controlClass = 'w-full rounded-lg border border-control-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

const queryErrorDetail = (error: unknown): string =>
  error instanceof Error && error.message.trim().length > 0
    ? error.message
    : 'Unbekannter Fehler beim Laden.';

export const EurRulesModal: React.FC<EurRulesModalProps> = ({ taxYear, onClose, onRulesChanged }) => {
  const queryClient = useQueryClient();
  const titleId = React.useId();

  const {
    data: rules = [],
    isLoading,
    isError: rulesIsError,
    error: rulesQueryError,
    refetch: refetchRules,
  } = useQuery({
    queryKey: ['eur', 'rules', taxYear],
    queryFn: () => ipc.eur.listRules({ taxYear }),
  });

  const { data: report } = useQuery({
    queryKey: ['eur', 'report', taxYear],
    queryFn: () => ipc.eur.getReport({ taxYear }),
  });

  const lineOptions = React.useMemo(
    () => (report?.rows ?? []).filter((line) => line.kind === 'income' || line.kind === 'expense'),
    [report],
  );

  const [isAdding, setIsAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [field, setField] = useState<RuleField>('counterparty');
  const [operator, setOperator] = useState<RuleOperator>('contains');
  const [value, setValue] = useState('');
  const [targetLineId, setTargetLineId] = useState('');
  const [priority, setPriority] = useState(10);

  const resetForm = () => {
    setField('counterparty');
    setOperator('contains');
    setValue('');
    setTargetLineId('');
    setPriority(10);
    setEditId(null);
    setIsAdding(false);
  };

  const upsertRule = useMutation({
    mutationFn: (args: Parameters<typeof ipc.eur.upsertRule>[0]) => ipc.eur.upsertRule(args),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['eur', 'rules', taxYear] });
      onRulesChanged();
      resetForm();
    },
  });

  const deleteRule = useMutation({
    mutationFn: (id: string) => ipc.eur.deleteRule({ id }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['eur', 'rules', taxYear] });
      onRulesChanged();
    },
  });

  const toggleActive = useMutation({
    mutationFn: (rule: { id: string; active: boolean; taxYear: number; priority: number; field: RuleField; operator: RuleOperator; value: string; targetEurLineId: string }) =>
      ipc.eur.upsertRule({ ...rule, active: !rule.active }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['eur', 'rules', taxYear] });
      onRulesChanged();
    },
  });

  const handleSave = () => {
    if (!value.trim() || !targetLineId) return;
    upsertRule.mutate({
      id: editId ?? uuidv4(),
      taxYear,
      priority,
      field,
      operator,
      value: value.trim(),
      targetEurLineId: targetLineId,
      active: true,
    });
  };

  const startEdit = (rule: typeof rules[number]) => {
    setEditId(rule.id);
    setField(rule.field as RuleField);
    setOperator(rule.operator as RuleOperator);
    setValue(rule.value);
    setTargetLineId(rule.targetEurLineId);
    setPriority(rule.priority);
    setIsAdding(true);
  };

  const getLineLabel = (lineId: string): string => {
    const line = lineOptions.find((l) => l.lineId === lineId);
    if (!line) return lineId;
    return line.kennziffer ? `KZ ${line.kennziffer}` : line.label;
  };

  return (
    <Modal
      open
      onClose={onClose}
      titleId={titleId}
      className="flex max-h-[90vh] max-w-2xl flex-col overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border p-6">
        <div>
          <h3 id={titleId} className="text-lg font-semibold text-foreground">Klassifizierungsregeln</h3>
          <p className="text-xs text-muted">Automatische Zuordnung nach Stichworten für {taxYear}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Klassifizierungsregeln schließen"
          className="rounded-lg p-2 text-muted transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          <X size={20} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        {/* Add/Edit Form */}
        {isAdding ? (
          <div className="mb-4 rounded-xl border border-border bg-surface-muted p-4">
            <h4 className="mb-3 text-sm font-semibold text-foreground">
              {editId ? 'Regel bearbeiten' : 'Neue Regel'}
            </h4>
            <div className="mb-3 grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-foreground" htmlFor="eur-rule-field">Feld</label>
                <select
                  id="eur-rule-field"
                  value={field}
                  onChange={(e) => setField(e.target.value as RuleField)}
                  className={controlClass}
                >
                  {(Object.entries(FIELD_LABELS) as [RuleField, string][]).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-foreground" htmlFor="eur-rule-operator">Bedingung</label>
                <select
                  id="eur-rule-operator"
                  value={operator}
                  onChange={(e) => setOperator(e.target.value as RuleOperator)}
                  className={controlClass}
                >
                  {(Object.entries(OPERATOR_LABELS) as [RuleOperator, string][]).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="mb-3">
              <label className="mb-1 block text-xs font-semibold text-foreground" htmlFor="eur-rule-value">Wert</label>
              <input
                id="eur-rule-value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="z.B. Telekom, Miete, Hosting..."
                className={controlClass}
              />
            </div>
            <div className="mb-3 grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-foreground" htmlFor="eur-rule-target">Ziel-Kennziffer</label>
                <select
                  id="eur-rule-target"
                  value={targetLineId}
                  onChange={(e) => setTargetLineId(e.target.value)}
                  className={controlClass}
                >
                  <option value="">Bitte wählen...</option>
                  {lineOptions.map((line) => (
                    <option key={line.lineId} value={line.lineId}>
                      {line.kennziffer ? `${line.kennziffer} - ` : ''}{line.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-foreground" htmlFor="eur-rule-priority">Priorität</label>
                <input
                  id="eur-rule-priority"
                  type="number"
                  value={priority}
                  onChange={(e) => setPriority(Number(e.target.value))}
                  min={0}
                  className={controlClass}
                />
                <p className="mt-1 text-xs text-muted">Niedrigere Zahl = höhere Priorität</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={handleSave} disabled={!value.trim() || !targetLineId || upsertRule.isPending}>
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

        {/* Rules Table */}
        {rulesIsError ? (
          <ErrorState
            title="Regeln konnten nicht geladen werden"
            description={queryErrorDetail(rulesQueryError)}
            onRetry={() => void refetchRules()}
          />
        ) : isLoading ? (
          <p className="py-8 text-center text-sm text-muted">Lade Regeln …</p>
        ) : rules.length === 0 ? (
          <EmptyState
            title="Keine Regeln vorhanden"
            description="Regeln ordnen Buchungen anhand von Stichworten automatisch einer Kennziffer zu."
            action={(
              <span className="flex items-center gap-2 text-xs text-muted">
                <Settings2 size={16} aria-hidden="true" />
                Beginne mit einer Regel für wiederkehrende Zahlungen.
              </span>
            )}
          />
        ) : (
          <div className="space-y-2">
            {rules.map((rule) => (
              <div
                key={rule.id}
                className={`rounded-xl border p-3 transition-colors ${
                  rule.active ? 'border-border bg-surface' : 'border-border-subtle bg-surface-muted'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="tabular-nums text-xs text-muted">#{rule.priority}</span>
                      <span className="font-semibold text-foreground">
                        {FIELD_LABELS[rule.field as RuleField]}
                      </span>
                      <span className="text-muted">
                        {OPERATOR_LABELS[rule.operator as RuleOperator]}
                      </span>
                      <span className="rounded-sm border border-border-subtle bg-surface-muted px-2 py-0.5 text-xs text-foreground">
                        „{rule.value}"
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-muted">
                      Ziel: {getLineLabel(rule.targetEurLineId)}
                    </div>
                    {!rule.active && (
                      <div className="mt-1 flex items-center gap-1 text-xs text-muted">
                        <AlertCircle size={12} aria-hidden="true" />
                        Inaktiv, wird beim Zuordnen nicht angewendet.
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => toggleActive.mutate({
                        id: rule.id,
                        active: rule.active,
                        taxYear: rule.taxYear,
                        priority: rule.priority,
                        field: rule.field as RuleField,
                        operator: rule.operator as RuleOperator,
                        value: rule.value,
                        targetEurLineId: rule.targetEurLineId,
                      })}
                      className={`rounded-lg px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
                        rule.active
                          ? 'border border-success-border bg-success-bg text-success-text hover:bg-success-bg/70'
                          : 'border border-border bg-surface-muted text-muted hover:bg-border-subtle'
                      }`}
                    >
                      {rule.active ? 'Aktiv' : 'Inaktiv'}
                    </button>
                    <button
                      type="button"
                      onClick={() => startEdit(rule)}
                      aria-label={`Regel ${rule.value} bearbeiten`}
                      className="rounded-lg p-1.5 text-xs text-muted transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                    >
                      Bearbeiten
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteRule.mutate(rule.id)}
                      aria-label={`Regel ${rule.value} löschen`}
                      className="rounded-lg p-1.5 text-muted transition-colors hover:bg-error-bg hover:text-error-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
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

      {/* Footer */}
      <div className="flex items-center justify-end gap-3 border-t border-border p-6">
        <Button variant="secondary" size="sm" onClick={onClose}>
          Schließen
        </Button>
      </div>
    </Modal>
  );
};
