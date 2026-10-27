import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button, HelpHint, IconButton, Input, Modal, Select, cn, useActionFeedback } from '@billme/ui';
import type { ProAccountingDataAdapter } from '../../services/accountingDataAdapter';
import { permissionContextForRole } from '../../domain/permissions';
import type { UserRole } from '../../types';
import {
  REPORT_MAPPING_STATEMENTS,
  reportMappingStatementLabel,
  type ReportMappingHealth,
  type ReportMappingMissingAccount,
  type ReportMappingOverrideInput,
  type ReportMappingPosition,
  type ReportMappingStatement,
} from '../../domain/reportMapping';

interface ReportMappingSetupProps {
  dataAdapter?: ProAccountingDataAdapter;
  chart: 'SKR03' | 'SKR04';
  role: UserRole;
  statements?: ReportMappingStatement[];
  asOfDate: string;
  validFrom: string;
  refreshKey?: number;
  onMappingChanged?: () => void;
  /**
   * Mapping-Zustand des aktiven Report-Tabs. Der Katalog-Check oben deckt nur die
   * Positions-Reports ab; ohne diesen Bezug würde er einen Report als vollständig
   * ausweisen, dessen Mapping der Exportbereich als unvollständig meldet.
   */
  activeReportMapping?: { label: string; blocked: boolean };
}

type PositionMap = Partial<Record<ReportMappingStatement, ReportMappingPosition[]>>;
const DEFAULT_REPORT_MAPPING_STATEMENTS = REPORT_MAPPING_STATEMENTS.map((entry) => entry.value);

const rowId = (entry: ReportMappingMissingAccount): string => `${entry.accountNumber}:${entry.statement}`;

const normalizeHealth = (value: ReportMappingHealth): ReportMappingHealth => ({
  chart: value.chart,
  unmapped: [...new Map(value.unmapped
    .filter((entry) => entry.accountNumber.trim() && REPORT_MAPPING_STATEMENTS.some((item) => item.value === entry.statement))
    .map((entry) => [rowId(entry), entry] as const)).values()],
});

export default function ReportMappingSetup({ dataAdapter, chart, role, statements = DEFAULT_REPORT_MAPPING_STATEMENTS, asOfDate, validFrom, refreshKey = 0, onMappingChanged, activeReportMapping }: ReportMappingSetupProps) {
  const canMutate = permissionContextForRole(role).canMutate;
  const enabled = Boolean(dataAdapter?.getReportMappingHealth && dataAdapter.listReportMappingPositions && dataAdapter.upsertReportMappingOverride);
  const [health, setHealth] = useState<ReportMappingHealth | null>(null);
  const [positions, setPositions] = useState<PositionMap>({});
  const [selections, setSelections] = useState<Record<string, { statement: ReportMappingStatement; position: string }>>({});
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const { notify } = useActionFeedback('report-mapping');
  const loadRequestId = useRef(0);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    const requestId = ++loadRequestId.current;
    if (!enabled || !dataAdapter?.getReportMappingHealth || !dataAdapter.listReportMappingPositions) return;
    setLoading(true);
    setError(null);
    try {
      const healths = await Promise.all(statements.map((statement) => dataAdapter.getReportMappingHealth!({ chart, statement, asOfDate })));
      const nextHealth = normalizeHealth({
        chart,
        unmapped: healths.flatMap((value) => value.unmapped),
      });
      const loaded = await Promise.all([...new Set(nextHealth.unmapped.map((entry) => entry.statement))].map(async (statement) => [
        statement,
        await dataAdapter.listReportMappingPositions!({ statement, asOfDate }),
      ] as const));
      if (!mounted.current || requestId !== loadRequestId.current) return;
      setHealth(nextHealth);
      setPositions(Object.fromEntries(loaded));
      setSelections((current) => Object.fromEntries(nextHealth.unmapped.map((entry) => {
        const id = rowId(entry);
        const old = current[id];
        return [id, old?.statement === entry.statement ? old : { statement: entry.statement, position: '' }];
      })));
    } catch (loadError) {
      if (!mounted.current || requestId !== loadRequestId.current) return;
      setHealth(null);
      setPositions({});
      setError(loadError instanceof Error ? loadError.message : 'Mapping-Health konnte nicht geladen werden.');
    } finally {
      if (mounted.current && requestId === loadRequestId.current) setLoading(false);
    }
  }, [asOfDate, chart, dataAdapter, enabled, statements]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadRequestId.current += 1;
    };
  }, []);

  const missingRows = useMemo(() => health?.unmapped ?? [], [health]);
  const groups = useMemo(() => {
    const byStatement = new Map<ReportMappingStatement, ReportMappingMissingAccount[]>();
    for (const entry of missingRows) byStatement.set(entry.statement, [...(byStatement.get(entry.statement) ?? []), entry]);
    return [...byStatement];
  }, [missingRows]);
  const chosen = missingRows.flatMap((entry) => {
    const selected = selections[rowId(entry)];
    const position = selected && positions[selected.statement]?.find((item) => item.key === selected.position);
    return position ? [{ entry, statement: selected.statement, position }] : [];
  });

  // Sequential on purpose: each override is its own audited mutation, and a failure stops the rest.
  const saveAll = async () => {
    if (!dataAdapter?.upsertReportMappingOverride || !chosen.length) return;
    if (!reason.trim()) {
      setError('Bitte geben Sie einen Audit-Grund für das Mapping an.');
      return;
    }
    setSaving(true);
    setError(null);
    let saved = 0;
    try {
      for (const { entry, statement, position } of chosen) {
        const input: ReportMappingOverrideInput = {
          chart,
          asOfDate: validFrom,
          accountNumber: entry.accountNumber,
          statement,
          position: position.key,
          label: position.label,
          ...(position.side ? { side: position.side } : {}),
          reason: reason.trim(),
        };
        await dataAdapter.upsertReportMappingOverride(input);
        saved += 1;
      }
      setReason('');
      if (saved === missingRows.length) setOpen(false);
      notify('success', saved === 1 ? `Konto ${chosen[0]!.entry.accountNumber} zugeordnet.` : `${saved} Konten zugeordnet.`);
    } catch (saveError) {
      const failed = chosen[saved]!.entry.accountNumber;
      setError(`Konto ${failed}: ${saveError instanceof Error ? saveError.message : 'Mapping konnte nicht gespeichert werden.'}${saved ? ` ${saved} davor gespeichert.` : ''}`);
    } finally {
      setSaving(false);
      if (saved) {
        onMappingChanged?.();
        void load();
      }
    }
  };

  if (!enabled) return null;
  const blocked = Boolean(activeReportMapping?.blocked);
  // Nothing to do: the report status badge already says the mapping is fine.
  if (!error && (!health || (missingRows.length === 0 && !blocked))) return null;

  const statementLabels = [...new Set(missingRows.map((entry) => reportMappingStatementLabel(entry.statement)))].join(', ');
  const preview = missingRows.slice(0, 3).map((entry) => entry.accountNumber).join(' · ');
  const title = blocked ? 'Export gesperrt' : missingRows.length === 1 ? '1 Konto ohne Position' : `${missingRows.length} Konten ohne Position`;
  const detail = !health
    ? error
    : missingRows.length === 0
      ? `Mapping unvollständig für ${activeReportMapping?.label}`
      : blocked
        ? `${missingRows.length === 1 ? '1 Konto' : `${missingRows.length} Konten`} ohne Position in ${statementLabels}`
        : `in ${statementLabels}`;
  const validFromLabel = validFrom.split('-').reverse().join('.');

  return (
    <>
      <section
        className={cn(
          'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control border py-1.5 pl-3 pr-1.5',
          blocked || !health ? 'border-error-border bg-error-bg' : 'border-warning-border bg-warning-bg',
        )}
        aria-labelledby="report-mapping-title"
      >
        <h2 id="report-mapping-title" className={cn('text-control font-semibold', blocked || !health ? 'text-error-text' : 'text-warning-text')}>
          {health ? title : 'Mapping-Prüfung fehlgeschlagen'}
        </h2>
        <p className="min-w-0 flex-1 truncate text-caption text-foreground-secondary" role="status">
          {detail}
          {health && missingRows.length ? <> · <span className="font-mono">{preview}</span>{missingRows.length > 3 ? ` +${missingRows.length - 3}` : ''}</> : null}
        </p>
        {health && missingRows.length ? (
          <Button type="button" size="sm" variant={canMutate ? 'primary' : 'secondary'} onClick={() => { setError(null); setOpen(true); }}>
            {canMutate ? 'Zuordnen' : 'Ansehen'}
          </Button>
        ) : (
          <Button type="button" size="sm" variant="secondary" onClick={() => void load()} disabled={loading} aria-busy={loading}>
            {loading ? 'Prüfe…' : 'Erneut prüfen'}
          </Button>
        )}
      </section>

      <Modal open={open} onClose={() => { if (!saving) setOpen(false); }} placement="right" titleId="report-mapping-sheet-title" descriptionId="report-mapping-sheet-description" ariaBusy={saving}>
        <div className="flex items-start gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="report-mapping-sheet-title" className="text-section text-foreground">Report-Konten zuordnen</h2>
            <p id="report-mapping-sheet-description" className="mt-0.5 text-caption text-muted">
              {chart} · gültig ab {validFromLabel} · {chosen.length} von {missingRows.length} gewählt
            </p>
          </div>
          <IconButton aria-label="Schließen" size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
            <X size={16} aria-hidden="true" />
          </IconButton>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
          {error ? <div className="mt-3 rounded-control border border-error-border bg-error-bg px-3 py-2.5 text-control text-error-text" role="alert" aria-live="assertive">{error}</div> : null}
          {groups.map(([statement, entries]) => (
            <section key={statement} aria-labelledby={`report-mapping-group-${statement}`}>
              <h3 id={`report-mapping-group-${statement}`} className="mt-4 mb-1 text-caption font-semibold text-muted">
                {reportMappingStatementLabel(statement)} · {entries.length}
              </h3>
              <ul className="divide-y divide-border border-y border-border">
                {entries.map((entry) => {
                  const id = rowId(entry);
                  const selected = selections[id] ?? { statement: entry.statement, position: '' };
                  const allowedPositions = positions[selected.statement] ?? [];
                  return (
                    <li key={id} className="grid grid-cols-[3.5rem_minmax(0,1fr)_minmax(0,14rem)] items-center gap-2 py-1.5">
                      <span className="font-mono text-control font-semibold text-foreground">{entry.accountNumber}</span>
                      <span className="truncate text-control text-foreground-secondary" title={entry.accountName}>{entry.accountName ?? 'Ohne Bezeichnung'}</span>
                      <Select
                        id={`report-mapping-position-${id}`}
                        aria-label={`Position für Konto ${entry.accountNumber}`}
                        value={selected.position}
                        disabled={!canMutate || saving || allowedPositions.length === 0}
                        onChange={(event) => setSelections((current) => ({ ...current, [id]: { ...selected, position: event.target.value } }))}
                        className={selected.position ? 'border-accent' : undefined}
                        fullWidth
                      >
                        <option value="">Position …</option>
                        {allowedPositions.map((position) => <option key={position.key} value={position.key}>{position.label}{position.side ? ` · ${position.side === 'asset' ? 'Aktiva' : 'Passiva'}` : ''}</option>)}
                      </Select>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>

        <div className="space-y-2 border-t border-border bg-surface-sunken px-4 py-3">
          {canMutate ? (
            <Input
              id="report-mapping-reason"
              label="Audit-Grund für Mapping-Änderungen"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="z. B. Kontenabstimmung Monatsabschluss"
              maxLength={500}
              required
              fullWidth
            />
          ) : <p className="text-caption text-muted" role="status">Ihre Rolle darf Report-Mappings nur lesen.</p>}
          <div className="flex items-center gap-2">
            <span className="flex min-w-0 flex-1 items-center gap-1 text-caption text-muted">
              Positionen nur aus dem erlaubten Katalog
              <HelpHint label="Herkunft der Kataloge">
                <p><strong>BWA-Katalog:</strong> Die öffentliche Positionsstruktur ist mit verifizierter Provenienz hinterlegt.</p>
                <p className="mt-1"><strong>DATEV:</strong> Der lizenzierte Konten-/Positionsinhalt wird nicht eingebettet. Verwenden Sie den externen DATEV-Import-Gate.</p>
              </HelpHint>
            </span>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={saving}>Abbrechen</Button>
            {canMutate ? (
              <Button type="button" onClick={() => void saveAll()} disabled={saving || loading || !chosen.length || !reason.trim()} aria-busy={saving}>
                {saving ? 'Speichere…' : chosen.length ? `${chosen.length} zuordnen` : 'Zuordnen'}
              </Button>
            ) : null}
          </div>
        </div>
      </Modal>
    </>
  );
}
