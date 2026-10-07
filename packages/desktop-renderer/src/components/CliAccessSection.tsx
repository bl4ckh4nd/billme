import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, ConfirmDialog, Input } from '@billme/ui';
import { ipc } from '../runtime-api';

type CliAccessRequest = NonNullable<Awaited<ReturnType<typeof ipc.cliAccess.pending>>>;
type CliToken = Awaited<ReturnType<typeof ipc.cliAccess.list>>[number];

const tokensKey = ['cliAccess', 'tokens'] as const;

const SCOPE_LABEL: Record<CliToken['scope'], string> = { full: 'Vollzugriff', read: 'Nur lesen' };

const formatDateTime = (value: string): string =>
  new Date(value).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : 'Unbekannter Fehler.');

/**
 * Confirms a `billme login` by the code the terminal shows and lists the
 * tokens issued that way. A token acts as the person who confirmed it, so the
 * request is shown in full before anything is granted.
 */
export const CliAccessSection: React.FC<{ initialCode?: string }> = ({ initialCode }) => {
  const queryClient = useQueryClient();
  const [code, setCode] = useState(initialCode ?? '');
  const [request, setRequest] = useState<CliAccessRequest | null>(null);
  const [status, setStatus] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [revoking, setRevoking] = useState<CliToken | null>(null);

  const tokens = useQuery({ queryKey: tokensKey, queryFn: () => ipc.cliAccess.list() });

  const lookup = useMutation({
    mutationFn: (value: string) => ipc.cliAccess.pending({ code: value }),
    onSuccess: (found) => {
      setRequest(found);
      setStatus(found ? null : { tone: 'error', text: 'Zu diesem Code gibt es keine offene Anmeldung. Codes gelten zehn Minuten.' });
    },
    onError: (error) => setStatus({ tone: 'error', text: `Code konnte nicht geprüft werden: ${messageOf(error)}` }),
  });

  const decide = useMutation({
    mutationFn: (approve: boolean) => ipc.cliAccess.decide({ code: request!.userCode, approve }),
    onSuccess: (_result, approve) => {
      setRequest(null);
      setCode('');
      setStatus({
        tone: 'info',
        text: approve ? 'Zugriff erlaubt. Das Terminal meldet sich in wenigen Sekunden an.' : 'Anmeldung abgelehnt.',
      });
      // The token is created when the CLI next asks for it, a few seconds after the approval.
      if (approve) window.setTimeout(() => void queryClient.invalidateQueries({ queryKey: tokensKey }), 4000);
    },
    onError: (error) => setStatus({ tone: 'error', text: `Entscheidung konnte nicht gespeichert werden: ${messageOf(error)}` }),
  });

  const revoke = useMutation({
    mutationFn: (token: CliToken) => ipc.cliAccess.revoke({ id: token.id }),
    onSuccess: () => {
      setRevoking(null);
      void queryClient.invalidateQueries({ queryKey: tokensKey });
    },
    onError: (error) => {
      setRevoking(null);
      setStatus({ tone: 'error', text: `Zugriff konnte nicht widerrufen werden: ${messageOf(error)}` });
    },
  });

  // A link from the terminal carries the code; show what it asks for without another click.
  const lookupCode = lookup.mutate;
  useEffect(() => {
    if (initialCode) lookupCode(initialCode);
  }, [initialCode, lookupCode]);

  return (
    <Card padding="none">
      <CardHeader
        className="border-b border-border px-3.5 py-3"
        title="CLI-Zugriff"
        subtitle={
          <>
            Mit <code className="font-mono text-foreground">billme login</code> meldet sich ein Terminal an dieser
            Installation an. Es zeigt einen Code, den du hier bestätigst.
          </>
        }
      />
      <div className="flex flex-col gap-3 p-3.5">
        <form
          className="flex flex-col sm:flex-row sm:items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setStatus(null);
            lookup.mutate(code.trim());
          }}
        >
          <div className="flex-1">
            <Input
              label="Code aus dem Terminal"
              fullWidth
              value={code}
              onChange={(event) => {
                setCode(event.target.value.toUpperCase());
                setRequest(null);
              }}
              placeholder="ABCD-EFGH"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </div>
          <Button type="submit" variant="secondary" disabled={!code.trim()} loading={lookup.isPending}>
            Code prüfen
          </Button>
        </form>

        {request && (
          <div className="flex flex-col gap-3 rounded-control border border-border bg-surface-muted p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-label text-foreground">{request.label}</span>
              <Badge tone={request.scope === 'read' ? 'info' : 'warning'}>{SCOPE_LABEL[request.scope]}</Badge>
            </div>
            <p className="text-control text-muted">
              {request.scope === 'read'
                ? 'Dieses Terminal darf alle Daten lesen, aber nichts ändern.'
                : 'Dieses Terminal darf in deinem Namen alles, was du in Billme darfst: Belege anlegen, ändern und versenden.'}
              {' '}Erlaube den Zugriff nur, wenn du die Anmeldung gerade selbst gestartet hast.
            </p>
            <div className="flex gap-2">
              <Button variant="dark" onClick={() => decide.mutate(true)} loading={decide.isPending && decide.variables === true} disabled={decide.isPending}>
                Zugriff erlauben
              </Button>
              <Button variant="secondary" onClick={() => decide.mutate(false)} loading={decide.isPending && decide.variables === false} disabled={decide.isPending}>
                Ablehnen
              </Button>
            </div>
          </div>
        )}

        <div role="status" className={`text-control ${status?.tone === 'error' ? 'text-error-text' : 'text-muted'}`}>
          {status?.text}
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <h3 className="text-label text-foreground">Angemeldete Terminals</h3>
          {tokens.isPending && <p className="text-control text-muted">Wird geladen …</p>}
          {tokens.isError && (
            <div className="flex items-center gap-3 text-control text-error-text">
              <span>Liste konnte nicht geladen werden: {messageOf(tokens.error)}</span>
              <Button variant="ghost" size="sm" onClick={() => void tokens.refetch()}>Erneut versuchen</Button>
            </div>
          )}
          {tokens.data?.length === 0 && (
            <p className="text-control text-muted">Noch kein Terminal angemeldet.</p>
          )}
          {tokens.data && tokens.data.length > 0 && (
            <ul>
              {tokens.data.map((token) => (
                <li key={token.id} className="flex flex-col gap-2 border-b border-dashed border-border py-2.5 last:border-b-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-label text-foreground">{token.label}</span>
                      <Badge tone={token.scope === 'read' ? 'info' : 'neutral'}>{SCOPE_LABEL[token.scope]}</Badge>
                    </div>
                    <p className="text-caption text-muted">
                      Angemeldet am {formatDateTime(token.createdAt)}
                      {token.lastUsedAt ? `, zuletzt benutzt am ${formatDateTime(token.lastUsedAt)}` : ', noch nicht benutzt'}
                    </p>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => setRevoking(token)}>
                    Widerrufen
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={revoking !== null}
        title={`Zugriff für „${revoking?.label ?? ''}“ widerrufen?`}
        description="Das Terminal verliert den Zugriff sofort und muss sich neu anmelden."
        confirmLabel="Widerrufen"
        destructive
        busy={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking)}
        onCancel={() => setRevoking(null)}
      />
    </Card>
  );
};
