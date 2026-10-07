import React, { useState } from 'react';
import { X, Plus, Trash2, Settings2, AlertCircle } from 'lucide-react';
import { Badge, Button, EmptyState, ErrorState, IconButton, Input, Modal, Select } from '@billme/ui';
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
      className="flex max-h-[84vh] max-w-2xl flex-col overflow-hidden"
    >
      <div className="flex items-start gap-3 px-4.5 pt-4 pb-2.5">
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="text-title text-foreground">Klassifizierungsregeln</h3>
          <p className="text-caption text-muted">Automatische Zuordnung nach Stichworten für {taxYear}</p>
        </div>
        <IconButton onClick={onClose} aria-label="Klassifizierungsregeln schließen" tooltip={false}>
          <X size={16} aria-hidden="true" />
        </IconButton>
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-auto px-4.5 pt-1 pb-4">
        {isAdding ? (
          <div className="flex flex-col gap-3 rounded-card border border-border bg-surface-muted p-3.5">
            <h4 className="text-section text-foreground">
              {editId ? 'Regel bearbeiten' : 'Neue Regel'}
            </h4>
            <div className="grid grid-cols-2 gap-3">
              <Select
                id="eur-rule-field"
                label="Feld"
                value={field}
                onChange={(e) => setField(e.target.value as RuleField)}
                fullWidth
              >
                {(Object.entries(FIELD_LABELS) as [RuleField, string][]).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
              <Select
                id="eur-rule-operator"
                label="Bedingung"
                value={operator}
                onChange={(e) => setOperator(e.target.value as RuleOperator)}
                fullWidth
              >
                {(Object.entries(OPERATOR_LABELS) as [RuleOperator, string][]).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            </div>
            <Input
              id="eur-rule-value"
              label="Wert"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="z.B. Telekom, Miete, Hosting..."
              fullWidth
            />
            <div className="grid grid-cols-2 gap-3">
              <Select
                id="eur-rule-target"
                label="Ziel-Kennziffer"
                value={targetLineId}
                onChange={(e) => setTargetLineId(e.target.value)}
                fullWidth
              >
                <option value="">Bitte wählen...</option>
                {lineOptions.map((line) => (
                  <option key={line.lineId} value={line.lineId}>
                    {line.kennziffer ? `${line.kennziffer} - ` : ''}{line.label}
                  </option>
                ))}
              </Select>
              <Input
                id="eur-rule-priority"
                label="Priorität"
                type="number"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                min={0}
                hint="Niedrigere Zahl = höhere Priorität"
                fullWidth
              />
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
          <div>
            <Button size="sm" variant="secondary" onClick={() => setIsAdding(true)}>
              <Plus size={14} aria-hidden="true" />
              Neue Regel
            </Button>
          </div>
        )}

        {rulesIsError ? (
          <ErrorState
            title="Regeln konnten nicht geladen werden"
            description={queryErrorDetail(rulesQueryError)}
            onRetry={() => void refetchRules()}
          />
        ) : isLoading ? (
          <p className="py-8 text-center text-control text-muted">Lade Regeln …</p>
        ) : rules.length === 0 ? (
          <EmptyState
            title="Keine Regeln vorhanden"
            description="Regeln ordnen Buchungen anhand von Stichworten automatisch einer Kennziffer zu."
            action={(
              <span className="flex items-center gap-2 text-caption text-muted">
                <Settings2 size={16} aria-hidden="true" />
                Beginne mit einer Regel für wiederkehrende Zahlungen.
              </span>
            )}
          />
        ) : (
          <div className="shrink-0 overflow-hidden rounded-card border border-border">
            {rules.map((rule) => (
              <div
                key={rule.id}
                className={`flex items-center justify-between gap-3 border-b border-border px-3 py-2.5 last:border-b-0 ${
                  rule.active ? '' : 'bg-surface-muted'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-control">
                    <span className="text-caption tabular-nums text-muted">#{rule.priority}</span>
                    <span className="font-semibold text-foreground">
                      {FIELD_LABELS[rule.field as RuleField]}
                    </span>
                    <span className="text-muted">
                      {OPERATOR_LABELS[rule.operator as RuleOperator]}
                    </span>
                    <Badge tone="neutral">„{rule.value}"</Badge>
                  </div>
                  <div className="mt-0.5 text-caption text-muted">
                    Ziel: {getLineLabel(rule.targetEurLineId)}
                  </div>
                  {!rule.active && (
                    <div className="mt-0.5 flex items-center gap-1 text-caption text-muted">
                      <AlertCircle size={12} aria-hidden="true" />
                      Inaktiv, wird beim Zuordnen nicht angewendet.
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    aria-pressed={rule.active}
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
                    className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                  >
                    <Badge tone={rule.active ? 'success' : 'neutral'}>{rule.active ? 'Aktiv' : 'Inaktiv'}</Badge>
                  </button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => startEdit(rule)}
                    aria-label={`Regel ${rule.value} bearbeiten`}
                  >
                    Bearbeiten
                  </Button>
                  <IconButton
                    size="sm"
                    onClick={() => deleteRule.mutate(rule.id)}
                    aria-label={`Regel ${rule.value} löschen`}
                    tooltip="Löschen"
                  >
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
