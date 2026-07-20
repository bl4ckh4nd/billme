import React, { useState } from 'react';
import { X, Plus, Trash2, Settings2 } from 'lucide-react';
import { Button } from '@billme/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { v4 as uuidv4 } from 'uuid';
import { ipc } from '../ipc/client';

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

export const EurRulesModal: React.FC<EurRulesModalProps> = ({ taxYear, onClose, onRulesChanged }) => {
  const queryClient = useQueryClient();

  const { data: rules = [], isLoading } = useQuery({
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-surface rounded-3xl shadow-2xl w-[700px] max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border">
          <div>
            <h3 className="text-lg font-bold text-foreground">Klassifizierungsregeln</h3>
            <p className="text-xs text-muted">Automatische Zuordnung nach Stichworten für {taxYear}</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-canvas rounded-lg transition-colors ease-out">
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6">
          {/* Add/Edit Form */}
          {isAdding ? (
            <div className="rounded-lg border border-border bg-surface-muted p-4 mb-4">
              <h4 className="text-sm font-bold text-foreground mb-3">
                {editId ? 'Regel bearbeiten' : 'Neue Regel'}
              </h4>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1">Feld</label>
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
                  <label className="block text-xs font-semibold text-foreground mb-1">Bedingung</label>
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
                <label className="block text-xs font-semibold text-foreground mb-1">Wert</label>
                <input
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="z.B. Telekom, Miete, Hosting..."
                  className="w-full rounded-lg border border-border px-3 py-2 text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="block text-xs font-semibold text-foreground mb-1">Ziel-Kennziffer</label>
                  <select
                    value={targetLineId}
                    onChange={(e) => setTargetLineId(e.target.value)}
                    className="w-full rounded-lg border border-border px-3 py-2 text-sm"
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
                  <label className="block text-xs font-semibold text-foreground mb-1">Priorität</label>
                  <input
                    type="number"
                    value={priority}
                    onChange={(e) => setPriority(Number(e.target.value))}
                    min={0}
                    className="w-full tabular-nums rounded-lg border border-border px-3 py-2 text-sm"
                  />
                  <p className="text-[10px] text-muted mt-1">Niedrigere Zahl = höhere Priorität</p>
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
          {isLoading ? (
            <p className="text-sm text-muted text-center py-8">Lade Regeln...</p>
          ) : rules.length === 0 ? (
            <div className="text-center py-8 text-muted">
              <Settings2 size={40} className="mx-auto mb-3 opacity-40" />
              <p className="text-sm font-medium">Keine Regeln vorhanden</p>
              <p className="text-xs mt-1">Erstellen Sie Regeln, um Buchungen automatisch zuzuordnen.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {rules.map((rule) => (
                <div
                  key={rule.id}
                  className={`rounded-xl border p-3 transition-colors ease-out ${
                    rule.active ? 'border-border bg-surface' : 'border-border-subtle bg-surface-muted opacity-60'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="tabular-nums text-xs text-muted">#{rule.priority}</span>
                        <span className="font-semibold text-foreground">
                          {FIELD_LABELS[rule.field as RuleField]}
                        </span>
                        <span className="text-muted">
                          {OPERATOR_LABELS[rule.operator as RuleOperator]}
                        </span>
                        <span className="font-mono text-foreground bg-canvas px-2 py-0.5 rounded text-xs">
                          „{rule.value}"
                        </span>
                      </div>
                      <div className="text-xs text-muted mt-1">
                        → {getLineLabel(rule.targetEurLineId)}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
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
                        className={`px-2 py-1 rounded-lg text-xs font-medium transition-colors ease-out ${
                          rule.active
                            ? 'bg-success-bg text-success hover:bg-success/10'
                            : 'bg-canvas text-muted hover:bg-border'
                        }`}
                      >
                        {rule.active ? 'Aktiv' : 'Inaktiv'}
                      </button>
                      <button
                        onClick={() => startEdit(rule)}
                        className="p-1.5 rounded-lg text-muted hover:text-foreground hover:bg-canvas transition-colors ease-out text-xs"
                      >
                        Bearbeiten
                      </button>
                      <button
                        onClick={() => deleteRule.mutate(rule.id)}
                        className="p-1.5 rounded-lg text-muted hover:text-error hover:bg-error-bg transition-colors ease-out"
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
        <div className="flex items-center justify-end gap-3 p-6 border-t border-border">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Schließen
          </Button>
        </div>
      </div>
    </div>
  );
};
