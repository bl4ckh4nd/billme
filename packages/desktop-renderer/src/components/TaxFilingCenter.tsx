import React from 'react';
import { Button, Card, EmptyState, ErrorState } from '@billme/ui';
import { Spinner } from '@billme/desktop-ui/components/Spinner';
import { getRendererApi } from '../runtime-api';

type RecordMetadata = { id: string; kind: 'euer' | 'e_bilanz' | 'unternehmensregister'; periodStart: string; periodEnd: string; sourceHash: string; status: 'frozen' | 'approved' | 'queued' };
const kindLabel: Record<RecordMetadata['kind'], string> = { euer: 'EÜR 2025', e_bilanz: 'E-Bilanz (Taxonomie 6.9)', unternehmensregister: 'Unternehmensregister' };
const unavailableMessage = 'Das Steuer-Filing-Center ist in dieser Umgebung nicht verfügbar.';
const actionFailedMessage = 'Die Aktion ist fehlgeschlagen. Bitte versuche es erneut.';
const providerUnavailableMessage = 'In dieser Umgebung ist kein ELSTER-/Filing-Provider installiert. Validierung und Export sind nicht verfügbar.';
const unavailableProviderLabel = (errorCode?: string): string =>
  errorCode && errorCode !== 'PROVIDER_UNAVAILABLE'
    ? `${providerUnavailableMessage} Fehlercode: ${errorCode}`
    : providerUnavailableMessage;
// The renderer is sandboxed and cannot reach the fs-backed desktop logger in the
// main process; the shell pipes renderer console output into the app log instead.
const logTechnicalError = (context: string, error: unknown): void => {
  console.error(`[TaxFilingCenter] ${context}`, error);
};

export const TaxFilingCenter: React.FC = () => {
  const ipc = getRendererApi('pro');
  const [provider, setProvider] = React.useState<string | null>(null);
  const [certificates, setCertificates] = React.useState<Awaited<ReturnType<typeof ipc.taxFiling.getStatus>>['certificates']>([]);
  const [records, setRecords] = React.useState<RecordMetadata[]>([]);
  const [selectedId, setSelectedId] = React.useState('');
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const filing = ipc.taxFiling;
    if (!filing) { setLoadError(unavailableMessage); setIsLoading(false); return; }
    setIsLoading(true);
    setLoadError(null);
    try {
      const [status, availableRecords] = await Promise.all([filing.getStatus(), filing.listRecords()]);
      setProvider(status.provider.available ? `${status.provider.provider} ${status.provider.version ?? ''}` : unavailableProviderLabel(status.provider.errorCode));
      setCertificates(status.certificates);
      setRecords(availableRecords);
      setSelectedId((current) => current && availableRecords.some((record) => record.id === current) ? current : availableRecords[0]?.id ?? '');
    } catch (error) { logTechnicalError('Statusabfrage fehlgeschlagen', error); setLoadError(unavailableMessage); }
    finally { setIsLoading(false); }
  }, [ipc]);
  React.useEffect(() => { void refresh(); }, [refresh]);

  const selected = records.find((record) => record.id === selectedId);
  const run = async (operation: 'validate' | 'export') => {
    const filing = ipc.taxFiling;
    if (!filing || !selected) return;
    setBusy(true); setMessage(null);
    try {
      const result = operation === 'validate' ? await filing.validate({ record: selected }) : await filing.export({ record: selected });
      setMessage(`${result.status}${result.outputPath ? `: ${result.outputPath}` : ''}${result.issues.length ? ` (${result.issues.map((issue) => issue.message).join('; ')})` : ''}`);
    } catch (error) { logTechnicalError(operation === 'validate' ? 'Validierung fehlgeschlagen' : 'Export fehlgeschlagen', error); setMessage(actionFailedMessage); }
    finally { setBusy(false); }
  };

  if (isLoading) {
    return <Card className="max-w-3xl space-y-4">
      <div><h1 className="text-title">Steuer-Filing-Center</h1><p className="text-muted">Nur eingefrorene Steuerberichte können lokal validiert oder exportiert werden.</p></div>
      <div className="flex flex-col items-center justify-center gap-3 py-10 text-muted">
        <Spinner size="md" />
        <p role="status" className="text-sm font-medium">Filing-Status wird geladen …</p>
      </div>
    </Card>;
  }

  if (loadError) {
    return <Card className="max-w-3xl space-y-4">
      <div><h1 className="text-title">Steuer-Filing-Center</h1><p className="text-muted">Nur eingefrorene Steuerberichte können lokal validiert oder exportiert werden.</p></div>
      <ErrorState title="Filing-Status konnte nicht geladen werden" description={loadError} onRetry={() => void refresh()} />
    </Card>;
  }

  return <Card className="max-w-3xl space-y-4">
    <div><h1 className="text-title">Steuer-Filing-Center</h1><p className="text-muted">Nur eingefrorene Steuerberichte können lokal validiert oder exportiert werden.</p></div>
    <p role="status">Provider: <span className="font-medium">{provider}</span></p>
    <div><h2 className="font-medium">Zertifikate</h2>{certificates.length ? <ul>{certificates.map((certificate) => <li key={certificate.id}>{certificate.id} · {certificate.fingerprint} · gültig bis {certificate.expiresAt}</li>)}</ul> : <p className="text-muted">Keine Zertifikate registriert. Geheimnisse bleiben im Hauptprozess.</p>}</div>
    {records.length ? <div className="space-y-2"><label className="block font-medium" htmlFor="tax-filing-record">Eingefrorener Bericht</label><select id="tax-filing-record" className="px-2.5 h-8 hover:border-ink-500 text-sm w-full rounded-control border border-control-border bg-surface" value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>{records.map((record) => <option key={record.id} value={record.id}>{kindLabel[record.kind]} · {record.periodStart} – {record.periodEnd} · {record.status}</option>)}</select><p className="text-xs text-muted">Snapshot: {selected?.sourceHash}</p><div className="flex gap-2"><Button type="button" disabled={busy || !selected} onClick={() => void run('validate')}>Validieren</Button><Button type="button" disabled={busy || !selected} onClick={() => void run('export')}>Exportieren</Button></div></div> : <EmptyState title="Keine eingefrorenen Berichte" description="Sobald ein Steuerbericht eingefroren ist, erscheint er hier zur Validierung und zum Export." />}
    <div className="rounded-md border border-border p-3"><h2 className="font-medium">Übermittlung</h2><p className="text-muted">Deaktiviert: Ein serverseitiger Vier-Augen-Grant ist in dieser Desktop-Installation nicht verfügbar. Es wird keine lokale Übermittlung simuliert.</p><Button type="button" disabled>Übermitteln (Server-Freigabe erforderlich)</Button></div>
    {message && <p role="alert">{message}</p>}
  </Card>;
};
