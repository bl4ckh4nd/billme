import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Select } from '@billme/ui';
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
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const loadRequestId = useRef(0);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    const requestId = ++loadRequestId.current;
    if (!enabled || !dataAdapter?.getReportMappingHealth || !dataAdapter.listReportMappingPositions) return;
    setLoading(true);
    setError(null);
    setNotice(null);
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

  const mutationDisabled = !canMutate || loading || Boolean(saving) || !reason.trim();

  const save = async (entry: ReportMappingMissingAccount) => {
    if (!dataAdapter?.upsertReportMappingOverride) return;
    const id = rowId(entry);
    const selected = selections[id];
    const position = selected && positions[selected.statement]?.find((item) => item.key === selected.position);
    if (!selected || !position) {
      setError('Bitte wählen Sie eine erlaubte Report-Position aus dem Katalog.');
      return;
    }
    if (!reason.trim()) {
      setError('Bitte geben Sie einen Audit-Grund für das Mapping an.');
      return;
    }
    setSaving(id);
    setError(null);
    setNotice(null);
    const input: ReportMappingOverrideInput = {
      chart,
      asOfDate: validFrom,
      accountNumber: entry.accountNumber,
      statement: selected.statement,
      position: position.key,
      label: position.label,
      ...(position.side ? { side: position.side } : {}),
      reason: reason.trim(),
    };
    try {
      await dataAdapter.upsertReportMappingOverride(input);
      setNotice(`Mapping für Konto ${entry.accountNumber} gespeichert.`);
      setReason('');
      onMappingChanged?.();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Mapping konnte nicht gespeichert werden.');
    } finally {
      setSaving(null);
    }
  };

  const missingRows = useMemo(() => health?.unmapped ?? [], [health]);
  if (!enabled) return null;

  const checkButton = (
    <Button type="button" size="sm" variant="secondary" onClick={() => void load()} disabled={loading || Boolean(saving)} aria-busy={loading}>
      {loading ? 'Prüfe Mapping…' : 'Mapping prüfen'}
    </Button>
  );

  if (health && missingRows.length === 0 && !activeReportMapping?.blocked && !error && !notice) {
    return (
      <section className="flex flex-wrap items-center gap-3 rounded-control border border-success-border bg-success-bg px-3 py-2 text-control text-success-text" aria-labelledby="report-mapping-title">
        <h2 id="report-mapping-title" className="sr-only">Report-Konten einrichten</h2>
        <p className="min-w-0 flex-1" role="status">Alle Konten sind report-spezifisch zugeordnet.</p>
        {checkButton}
      </section>
    );
  }

  return (
    <section className="rounded-card border border-border bg-surface" aria-labelledby="report-mapping-title">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-3.5 py-3">
        <div className="min-w-48 flex-1">
          <h2 id="report-mapping-title" className="text-section text-foreground">Report-Konten einrichten</h2>
          <p className="mt-0.5 text-caption text-muted">Fehlende Konten werden je Report-Katalog eingerichtet. Positionen stammen ausschließlich aus dem erlaubten Katalog.</p>
        </div>
        {checkButton}
      </div>

      <div className="space-y-3 p-3.5">
        {activeReportMapping?.blocked ? (
          <div className="rounded-control border border-error-border bg-error-bg px-3 py-2.5 text-control text-error-text" role="alert">
            <div className="font-semibold">Mapping unvollständig für {activeReportMapping.label}</div>
            <p className="mt-1">Export und Abschluss dieses Reports bleiben gesperrt, bis alle Konten zugeordnet sind.</p>
            {health && missingRows.length === 0 ? (
              <p className="mt-1 text-caption">Die übrigen Report-Kataloge sind vollständig zugeordnet.</p>
            ) : null}
          </div>
        ) : health && missingRows.length === 0 ? (
          <p className="rounded-control border border-success-border bg-success-bg px-3 py-2.5 text-control text-success-text" role="status">Alle Konten sind report-spezifisch zugeordnet.</p>
        ) : null}
        {loading && !health ? <p className="text-control text-muted" role="status" aria-live="polite">Lade fehlende Report-Konten…</p> : null}
        {error ? <div className="rounded-control border border-error-border bg-error-bg px-3 py-2.5 text-control text-error-text" role="alert" aria-live="assertive">{error}</div> : null}
        {notice ? <div className="rounded-control border border-success-border bg-success-bg px-3 py-2.5 text-control text-success-text" role="status" aria-live="polite">{notice}</div> : null}

        {missingRows.length > 0 ? (
          <>
            <div className="max-w-xl">
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
            </div>
            <div className="divide-y divide-border border-y border-border">
              {missingRows.map((entry) => {
                const id = rowId(entry);
                const selected = selections[id] ?? { statement: entry.statement, position: '' };
                const allowedPositions = positions[selected.statement] ?? [];
                const selectedPosition = allowedPositions.find((position) => position.key === selected.position);
                return (
                  <div key={id} className="grid gap-2 py-3 lg:grid-cols-[6rem_12rem_minmax(0,1fr)_auto] lg:items-start">
                    <div>
                      <div className="mb-1 text-caption font-medium text-foreground-secondary">Konto</div>
                      <div className="flex min-h-8.5 items-center font-mono text-control font-semibold text-foreground">{entry.accountNumber}</div>
                    </div>
                    <div>
                      <div className="mb-1 text-caption font-medium text-foreground-secondary">Report</div>
                      <div className="flex min-h-8.5 items-center text-control text-foreground">{reportMappingStatementLabel(entry.statement)}</div>
                    </div>
                    <Select
                      id={`report-mapping-position-${id}`}
                      label="Erlaubte Position"
                      value={selected.position}
                      disabled={!canMutate || Boolean(saving) || allowedPositions.length === 0}
                      onChange={(event) => setSelections((current) => ({ ...current, [id]: { ...selected, position: event.target.value } }))}
                      hint={selectedPosition?.side ? `Seite aus Katalog: ${selectedPosition.side === 'asset' ? 'Aktiva' : 'Passiva'}` : undefined}
                      fullWidth
                    >
                      <option value="">Position auswählen…</option>
                      {allowedPositions.map((position) => <option key={position.key} value={position.key}>{position.label}{position.side ? ` · ${position.side === 'asset' ? 'Aktiva' : 'Passiva'}` : ''}</option>)}
                    </Select>
                    <Button type="button" variant="secondary" className="lg:mt-5" onClick={() => void save(entry)} disabled={mutationDisabled || !selectedPosition || saving === id} aria-busy={saving === id}>
                      {saving === id ? 'Speichere…' : 'Zuordnen'}
                    </Button>
                  </div>
                );
              })}
            </div>
            {!canMutate ? <p className="text-caption text-muted" role="status">Ihre Rolle darf Report-Mappings nur lesen.</p> : null}
          </>
        ) : null}

        <div className="space-y-1 text-caption text-muted">
          <p><strong>BWA-Katalog:</strong> Die öffentliche Positionsstruktur ist mit verifizierter Provenienz hinterlegt.</p>
          <p><strong>DATEV:</strong> Der lizenzierte Konten-/Positionsinhalt wird nicht eingebettet. Verwenden Sie den externen DATEV-Import-Gate.</p>
        </div>
      </div>
    </section>
  );
}
