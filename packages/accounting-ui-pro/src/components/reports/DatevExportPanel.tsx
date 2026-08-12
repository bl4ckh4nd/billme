import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { FileDown, LockKeyhole } from 'lucide-react';
import { Button, Input } from '@billme/ui';
import type { DatevExportResult, ProAccountingDataAdapter } from '../../services/mockBookingStore';
import { permissionContextForRole } from '../../mocks/users';
import type { UserRole } from '../../types';

type DatevEncoding = 'cp1252' | 'utf8-bom';

interface DatevExportValues {
  from: string;
  to: string;
  consultantNumber: string;
  clientNumber: string;
  fiscalYearStart: string;
  accountLength: string;
  encoding: DatevEncoding;
}

interface DatevExportPanelProps {
  dataAdapter?: ProAccountingDataAdapter;
  chartFramework?: 'SKR03' | 'SKR04';
  role?: UserRole;
}

function pad(value: number) {
  return String(value).padStart(2, '0');
}

function defaultValues(): DatevExportValues {
  const now = new Date();
  const year = now.getFullYear();
  const month = pad(now.getMonth() + 1);
  const date = `${year}-${month}-${pad(now.getDate())}`;
  return {
    from: `${year}-${month}-01`,
    to: date,
    consultantNumber: '',
    clientNumber: '',
    fiscalYearStart: `${year}-01-01`,
    accountLength: '4',
    encoding: 'cp1252',
  };
}

function validate(values: DatevExportValues) {
  if (!values.from || !values.to || !values.fiscalYearStart) return 'Zeitraum und Wirtschaftsjahresbeginn sind erforderlich.';
  if (values.from > values.to) return 'Der DATEV-Zeitraum ist umgekehrt.';
  if (values.from.slice(0, 7) !== values.to.slice(0, 7)) return 'Ein Buchungsstapel darf nur einen Kalendermonat enthalten.';
  if (values.fiscalYearStart > values.from) return 'Der Zeitraum liegt vor dem Wirtschaftsjahresbeginn.';
  if (!/^(?:\d{4,6}|\d{7})$/.test(values.consultantNumber) || Number(values.consultantNumber) < 1001) return 'Die Beraternummer muss gültig sein.';
  if (!/^\d{1,5}$/.test(values.clientNumber) || Number(values.clientNumber) < 1) return 'Die Mandantennummer muss gültig sein.';
  const accountLength = Number(values.accountLength);
  if (!Number.isInteger(accountLength) || accountLength < 4 || accountLength > 8) return 'Die Sachkontenlänge muss zwischen 4 und 8 liegen.';
  return null;
}

function formatDate(value?: string) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('de-DE').format(new Date(`${value}T00:00:00`));
}

function formatCreatedAt(value: string) {
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

function exportLabel(exportItem: DatevExportResult) {
  const period = exportItem.fromDate && exportItem.toDate
    ? `${formatDate(exportItem.fromDate)} – ${formatDate(exportItem.toDate)}`
    : 'Zeitraum unbekannt';
  return `${period}, ${exportItem.recordCount} Buchungen`;
}

export default function DatevExportPanel({ dataAdapter, chartFramework = 'SKR03', role = 'admin' }: DatevExportPanelProps) {
  const [values, setValues] = useState<DatevExportValues>(defaultValues);
  const [history, setHistory] = useState<DatevExportResult[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<DatevExportResult | null>(null);

  const canExport = permissionContextForRole(role).canMutate && Boolean(dataAdapter?.exportDatevBuchungsstapel);
  const canListHistory = Boolean(dataAdapter?.listDatevExports);

  const loadHistory = useCallback(async () => {
    if (!dataAdapter?.listDatevExports) return;
    setLoadingHistory(true);
    try {
      setHistory(await dataAdapter.listDatevExports(20));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'DATEV-Exportverlauf konnte nicht geladen werden.');
    } finally {
      setLoadingHistory(false);
    }
  }, [dataAdapter]);

  useEffect(() => {
    setError(null);
    setSuccess(null);
    void loadHistory();
  }, [loadHistory]);

  const validationError = useMemo(() => validate(values), [values]);
  const update = <K extends keyof DatevExportValues>(key: K, value: DatevExportValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    setError(null);
    setSuccess(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    const exportDatev = dataAdapter?.exportDatevBuchungsstapel;
    if (!exportDatev) {
      setError('DATEV-Export ist in dieser Ansicht schreibgeschützt. Bitte Pro Desktop verwenden.');
      return;
    }
    const validation = validate(values);
    if (validation) {
      setError(validation);
      return;
    }

    setExporting(true);
    try {
      const result = await exportDatev({
        from: values.from,
        to: values.to,
        consultantNumber: values.consultantNumber,
        clientNumber: values.clientNumber,
        fiscalYearStart: values.fiscalYearStart,
        accountLength: Number(values.accountLength),
        encoding: values.encoding,
      });
      setSuccess(result);
      await loadHistory();
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : 'DATEV-Export konnte nicht erstellt werden.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-surface p-4" aria-labelledby="datev-export-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-dark-base text-accent">
            <FileDown size={15} aria-hidden="true" />
          </span>
          <div>
            <h2 id="datev-export-title" className="text-sm font-black text-foreground">DATEV Buchungsstapel</h2>
            <p className="mt-0.5 text-xs text-muted">Unveränderlicher Export aus dem aktiven Journal ({chartFramework}).</p>
          </div>
        </div>
        {!canExport ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-muted px-2 py-1 text-xs font-semibold text-muted">
            <LockKeyhole size={12} aria-hidden="true" /> Nur Lesen
          </span>
        ) : null}
      </div>

      <form className="mt-4 space-y-4" onSubmit={handleSubmit} noValidate>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Input label="Von" type="date" value={values.from} onChange={(event) => update('from', event.target.value)} required fullWidth />
          <Input label="Bis" type="date" value={values.to} onChange={(event) => update('to', event.target.value)} required fullWidth />
          <Input label="Wirtschaftsjahresbeginn" type="date" value={values.fiscalYearStart} onChange={(event) => update('fiscalYearStart', event.target.value)} required fullWidth />
          <Input label="Kontenlänge" type="number" min={4} max={8} step={1} value={values.accountLength} onChange={(event) => update('accountLength', event.target.value)} required fullWidth />
          <Input label="Beraternummer" inputMode="numeric" type="text" value={values.consultantNumber} onChange={(event) => update('consultantNumber', event.target.value)} required fullWidth />
          <Input label="Mandantennummer" inputMode="numeric" type="text" value={values.clientNumber} onChange={(event) => update('clientNumber', event.target.value)} required fullWidth />
          <label className="block text-sm font-medium text-foreground">
            Zeichensatz
            <select
              value={values.encoding}
              onChange={(event) => update('encoding', event.target.value as DatevEncoding)}
              className="mt-2 block w-full rounded-xl border border-border bg-surface-muted px-4 py-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent"
            >
              <option value="cp1252">CP1252 (DATEV)</option>
              <option value="utf8-bom">UTF-8 mit BOM</option>
            </select>
          </label>
        </div>

        {validationError && canExport ? <p className="text-xs text-muted">{validationError}</p> : null}
        {error ? <div className="rounded-xl border border-error-border bg-error-bg px-3 py-2 text-sm text-error" role="alert" aria-live="assertive">{error}</div> : null}
        {success ? (
          <div className="rounded-xl border border-success-border bg-success-bg px-3 py-2 text-sm text-success" role="status" aria-live="polite">
            Export erstellt: {success.recordCount} Buchungen. Datei: <span className="break-all font-mono text-xs">{success.filePath}</span>
            {success.sha256 ? <span className="mt-1 block break-all font-mono text-xs">SHA-256: {success.sha256}</span> : null}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {!canExport ? <p className="text-xs text-muted">Der Browserzugriff kann keine Datei schreiben oder exportieren.</p> : <span />}
          <Button type="submit" size="sm" disabled={exporting || !canExport} aria-busy={exporting}>
            {exporting ? 'Export läuft…' : 'Buchungsstapel exportieren'}
          </Button>
        </div>
      </form>

      <div className="mt-5 border-t border-border pt-4" aria-label="Unveränderlicher DATEV-Exportverlauf">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-black uppercase tracking-wide text-muted">Exportverlauf</h3>
          {loadingHistory ? <span className="text-xs text-muted" aria-live="polite">Lade Verlauf…</span> : null}
        </div>
        {!canListHistory ? (
          <p className="mt-2 text-xs text-muted">Der unveränderliche Exportverlauf ist nur im Pro Desktop verfügbar.</p>
        ) : history.length === 0 && !loadingHistory ? (
          <p className="mt-2 text-xs text-muted">Noch keine DATEV-Exporte vorhanden.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
            {history.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
                <span><strong>{exportLabel(item)}</strong><span className="ml-2 text-muted">{formatCreatedAt(item.createdAt)}</span></span>
                <span className="text-muted">Unveränderlich{item.sha256 ? ` · SHA-256 ${item.sha256.slice(0, 12)}…` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
