import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@billme/ui';
import type { ProAccountingDataAdapter } from '../../services/mockBookingStore';
import { permissionContextForRole } from '../../mocks/users';
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
  refreshKey?: number;
  onMappingChanged?: () => void;
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

export default function ReportMappingSetup({ dataAdapter, chart, role, statements = DEFAULT_REPORT_MAPPING_STATEMENTS, asOfDate, refreshKey = 0, onMappingChanged }: ReportMappingSetupProps) {
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
      asOfDate,
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

  return (
    <section className="rounded-2xl border border-border bg-surface p-4" aria-labelledby="report-mapping-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="report-mapping-title" className="text-sm font-black text-foreground">Report-Konten einrichten</h2>
          <p className="mt-1 text-xs text-muted">Fehlende Konten werden je Report-Katalog eingerichtet. Positionen stammen ausschließlich aus dem erlaubten Katalog.</p>
        </div>
        <Button type="button" size="sm" variant="secondary" onClick={() => void load()} disabled={loading || Boolean(saving)} aria-busy={loading}>
          {loading ? 'Prüfe Mapping…' : 'Mapping prüfen'}
        </Button>
      </div>

      {health && missingRows.length === 0 ? <p className="mt-3 rounded-xl border border-success-border bg-success-bg px-3 py-2 text-sm text-success" role="status">Alle Konten sind report-spezifisch zugeordnet.</p> : null}
      {loading && !health ? <p className="mt-3 text-sm text-muted" role="status" aria-live="polite">Lade fehlende Report-Konten…</p> : null}
      {error ? <div className="mt-3 rounded-xl border border-error-border bg-error-bg px-3 py-2 text-sm text-error" role="alert" aria-live="assertive">{error}</div> : null}
      {notice ? <div className="mt-3 rounded-xl border border-success-border bg-success-bg px-3 py-2 text-sm text-success" role="status" aria-live="polite">{notice}</div> : null}

      {missingRows.length > 0 ? (
        <>
          <label className="mt-3 block max-w-xl text-xs font-semibold text-foreground" htmlFor="report-mapping-reason">
            Audit-Grund für Mapping-Änderungen
            <input
              id="report-mapping-reason"
              className="mt-1 block w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm font-normal outline-none focus:border-accent focus:ring-2 focus:ring-accent"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="z. B. Kontenabstimmung Monatsabschluss"
              maxLength={500}
              required
            />
          </label>
          <div className="mt-3 space-y-2">
            {missingRows.map((entry) => {
              const id = rowId(entry);
              const selected = selections[id] ?? { statement: entry.statement, position: '' };
              const allowedPositions = positions[selected.statement] ?? [];
              const selectedPosition = allowedPositions.find((position) => position.key === selected.position);
              return (
                <div key={id} className="grid gap-2 rounded-xl border border-border bg-surface-muted p-3 lg:grid-cols-[auto_12rem_minmax(0,1fr)_auto] lg:items-end">
                  <div className="min-w-24">
                    <div className="text-[10px] font-bold uppercase tracking-wide text-muted">Konto</div>
                    <div className="font-mono text-sm font-bold text-foreground">{entry.accountNumber}</div>
                  </div>
                  <div className="min-w-36 text-xs font-semibold text-foreground">
                    <div>Report</div>
                    <div className="mt-1 rounded-lg border border-border bg-surface px-2 py-2 text-sm font-normal">{reportMappingStatementLabel(entry.statement)}</div>
                  </div>
                  <label className="text-xs font-semibold text-foreground" htmlFor={`report-mapping-position-${id}`}>
                    Erlaubte Position
                    <select
                      id={`report-mapping-position-${id}`}
                      value={selected.position}
                      disabled={!canMutate || Boolean(saving) || allowedPositions.length === 0}
                      onChange={(event) => setSelections((current) => ({ ...current, [id]: { ...selected, position: event.target.value } }))}
                      className="mt-1 block w-full rounded-lg border border-border bg-surface px-2 py-2 text-sm font-normal outline-none focus:border-accent focus:ring-2 focus:ring-accent"
                    >
                      <option value="">Position auswählen…</option>
                      {allowedPositions.map((position) => <option key={position.key} value={position.key}>{position.label}{position.side ? ` · ${position.side === 'asset' ? 'Aktiva' : 'Passiva'}` : ''}</option>)}
                    </select>
                    {selectedPosition?.side ? <span className="mt-1 block text-[11px] text-muted">Seite aus Katalog: {selectedPosition.side === 'asset' ? 'Aktiva' : 'Passiva'}</span> : null}
                  </label>
                  <Button type="button" size="sm" variant="secondary" onClick={() => void save(entry)} disabled={mutationDisabled || !selectedPosition || saving === id} aria-busy={saving === id}>
                    {saving === id ? 'Speichere…' : 'Zuordnen'}
                  </Button>
                </div>
              );
            })}
          </div>
          {!canMutate ? <p className="mt-2 text-xs text-muted" role="status">Ihre Rolle darf Report-Mappings nur lesen.</p> : null}
        </>
      ) : null}

      <div className="mt-3 space-y-1 text-xs text-muted">
        <p><strong>BWA-Katalog:</strong> Die öffentliche Positionsstruktur ist mit verifizierter Provenienz hinterlegt.</p>
        <p><strong>DATEV:</strong> Der lizenzierte Konten-/Positionsinhalt wird nicht eingebettet. Verwenden Sie den externen DATEV-Import-Gate.</p>
      </div>
    </section>
  );
}
