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
      <div className="bg-white rounded-3xl shadow-2xl w-[700px] max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div>
            <h3 className="text-lg font-bold text-gray-900">Klassifizierungsregeln</h3>
            <p className="text-xs text-gray-500">Automatische Zuordnung nach Stichworten für {taxYear}</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6">
          {/* Add/Edit Form */}
          {isAdding ? (
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 mb-4">
              <h4 className="text-sm font-bold text-gray-900 mb-3">
                {editId ? 'Regel bearbeiten' : 'Neue Regel'}
              </h4>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Feld</label>
                  <select
                    value={field}
                    onChange={(e) => setField(e.target.value as RuleField)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  >
                    {(Object.entries(FIELD_LABELS) as [RuleField, string][]).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Bedingung</label>
                  <select
                    value={operator}
                    onChange={(e) => setOperator(e.target.value as RuleOperator)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  >
                    {(Object.entries(OPERATOR_LABELS) as [RuleOperator, string][]).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="mb-3">
                <label className="block text-xs font-semibold text-gray-700 mb-1">Wert</label>
                <input
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="z.B. Telekom, Miete, Hosting..."
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Ziel-Kennziffer</label>
                  <select
                    value={targetLineId}
                    onChange={(e) => setTargetLineId(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
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
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Priorität</label>
                  <input
                    type="number"
                    value={priority}
                    onChange={(e) => setPriority(Number(e.target.value))}
                    min={0}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                  <p className="text-[10px] text-gray-400 mt-1">Niedrigere Zahl = höhere Priorität</p>
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
            <p className="text-sm text-gray-500 text-center py-8">Lade Regeln...</p>
          ) : rules.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <Settings2 size={40} className="mx-auto mb-3 opacity-40" />
              <p className="text-sm font-medium">Keine Regeln vorhanden</p>
              <p className="text-xs mt-1">Erstellen Sie Regeln, um Buchungen automatisch zuzuordnen.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {rules.map((rule) => (
                <div
                  key={rule.id}
                  className={`rounded-xl border p-3 transition-colors ${
                    rule.active ? 'border-gray-200 bg-white' : 'border-gray-100 bg-gray-50 opacity-60'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-mono text-xs text-gray-400">#{rule.priority}</span>
                        <span className="font-semibold text-gray-900">
                          {FIELD_LABELS[rule.field as RuleField]}
                        </span>
                        <span className="text-gray-500">
                          {OPERATOR_LABELS[rule.operator as RuleOperator]}
                        </span>
                        <span className="font-mono text-purple-700 bg-purple-50 px-2 py-0.5 rounded text-xs">
                          „{rule.value}"
                        </span>
                      </div>
                      <div className="text-xs text-gray-500 mt-1">
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
                        className={`px-2 py-1 rounded-lg text-xs font-medium transition-colors ${
                          rule.active
                            ? 'bg-green-100 text-green-700 hover:bg-green-200'
                            : 'bg-gray-200 text-gray-500 hover:bg-gray-300'
                        }`}
                      >
                        {rule.active ? 'Aktiv' : 'Inaktiv'}
                      </button>
                      <button
                        onClick={() => startEdit(rule)}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors text-xs"
                      >
                        Bearbeiten
                      </button>
                      <button
                        onClick={() => deleteRule.mutate(rule.id)}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
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
        <div className="flex items-center justify-end gap-3 p-6 border-t border-gray-200">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Schließen
          </Button>
        </div>
      </div>
    </div>
  );
};
