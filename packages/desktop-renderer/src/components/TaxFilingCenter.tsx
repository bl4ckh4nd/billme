import React from 'react';
import { Button, Card, EmptyState, ErrorState, PageHeader, Select } from '@billme/ui';
import { Spinner } from '../ui/components/Spinner';
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

  const header = <PageHeader title="Steuer" description="Nur eingefrorene Steuerberichte können lokal validiert oder exportiert werden." />;

  if (isLoading) {
    return <div className="max-w-3xl">
      {header}
      <Card>
        <div className="flex flex-col items-center justify-center gap-3 py-10 text-muted">
          <Spinner size="md" />
          <p role="status" className="text-control font-medium">Filing-Status wird geladen …</p>
        </div>
      </Card>
    </div>;
  }

  if (loadError) {
    return <div className="max-w-3xl">
      {header}
      <Card>
        <ErrorState title="Filing-Status konnte nicht geladen werden" description={loadError} onRetry={() => void refresh()} />
      </Card>
    </div>;
  }

  return <div className="max-w-3xl">
    {header}
    <div className="flex flex-col gap-3.5">
      <Card className="space-y-3">
        <p role="status" className="text-control">Provider: <span className="font-medium">{provider}</span></p>
        <div>
          <h2 className="text-section">Zertifikate</h2>
          {certificates.length
            ? <ul className="mt-1 text-control">{certificates.map((certificate) => <li key={certificate.id}>{certificate.id} · {certificate.fingerprint} · gültig bis {certificate.expiresAt}</li>)}</ul>
            : <p className="mt-1 text-control text-muted">Keine Zertifikate registriert. Geheimnisse bleiben im Hauptprozess.</p>}
        </div>
      </Card>
      <Card className="space-y-3">
        {records.length ? <>
          <Select
            id="tax-filing-record"
            label="Eingefrorener Bericht"
            hint={<span className="break-all">Snapshot: {selected?.sourceHash}</span>}
            fullWidth
            value={selectedId}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {records.map((record) => <option key={record.id} value={record.id}>{kindLabel[record.kind]} · {record.periodStart} – {record.periodEnd} · {record.status}</option>)}
          </Select>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" disabled={busy || !selected} onClick={() => void run('validate')}>Validieren</Button>
            <Button type="button" variant="secondary" disabled={busy || !selected} onClick={() => void run('export')}>Exportieren</Button>
          </div>
        </> : <EmptyState title="Keine eingefrorenen Berichte" description="Sobald ein Steuerbericht eingefroren ist, erscheint er hier zur Validierung und zum Export." />}
        {message && <p role="alert" className="rounded-control border border-info-border bg-info-bg px-3 py-2.5 text-control text-info-text">{message}</p>}
      </Card>
      <Card className="space-y-3">
        <div>
          <h2 className="text-section">Übermittlung</h2>
          <p className="mt-1 text-control text-muted">Deaktiviert: Ein serverseitiger Vier-Augen-Grant ist in dieser Desktop-Installation nicht verfügbar. Es wird keine lokale Übermittlung simuliert.</p>
        </div>
        <Button type="button" variant="secondary" disabled>Übermitteln (Server-Freigabe erforderlich)</Button>
      </Card>
    </div>
  </div>;
};
