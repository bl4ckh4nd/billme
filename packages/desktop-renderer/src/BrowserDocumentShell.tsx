import React from 'react';
import { authUserSchema, authSessionInfoSchema, createServerApiClient, type AuthUser } from '@billme/server-core';
import { AuthScreen, ErrorState, type AuthScreenMode } from '@billme/ui';

type Session = { token: string; user: AuthUser; apiUrl: string };
export type BrowserMountContext = {
  apiUrl: string;
  token: string;
  onLogout: () => void;
  signal: AbortSignal;
};
type Props = {
  product: 'lite' | 'pro';
  defaultApiUrl: string;
  sessionStorageKey: string;
  apiUrlStorageKey: string;
  initialCredentials?: { email: string; password: string; fullName: string };
  mount: (element: HTMLElement, context: BrowserMountContext) => Promise<() => void>;
};

function RendererHost({ session, mount, onLogout, product }: {
  session: Session; mount: Props['mount']; onLogout: () => void; product: Props['product'];
}) {
  const host = React.useRef<HTMLDivElement>(null);
  const [error, setError] = React.useState<string>();
  React.useEffect(() => {
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    setError(undefined);
    void mount(host.current!, { apiUrl: session.apiUrl, token: session.token,
      onLogout: () => { if (!controller.signal.aborted) onLogout(); }, signal: controller.signal })
      .then((cleanup) => { if (controller.signal.aborted) cleanup(); else dispose = cleanup; })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { controller.abort(); dispose?.(); };
  }, [session, mount, onLogout]);
  return error ? <main className="flex min-h-screen items-center justify-center bg-surface-sunken px-6 py-10">
    <div className="w-full max-w-xl"><ErrorState title={`Billme ${product === 'pro' ? 'Pro' : 'Lite'} konnte im Browser nicht gestartet werden`}
      description={error} onRetry={onLogout} retryLabel="Zur Anmeldung" /></div>
  </main> : <div ref={host} className="min-h-screen" />;
}

export function BrowserDocumentShell({ product, defaultApiUrl, sessionStorageKey, apiUrlStorageKey, initialCredentials, mount }: Props) {
  const [apiUrl, setApiUrl] = React.useState(() => localStorage.getItem(apiUrlStorageKey) ?? defaultApiUrl);
  const [mode, setMode] = React.useState<AuthScreenMode>('checking');
  const [session, setSession] = React.useState<Session | null>(null);
  const [notice, setNotice] = React.useState('');
  const [checkRun, setCheckRun] = React.useState(0);
  const generation = React.useRef(0);
  const client = React.useMemo(() => createServerApiClient(apiUrl), [apiUrl]);
  const logout = React.useCallback(() => {
    generation.current++;
    localStorage.removeItem(sessionStorageKey);
    setSession(null);
    setMode('login');
    setNotice('Du wurdest abgemeldet.');
  }, [sessionStorageKey]);

  React.useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    setMode('checking');
    setSession(null);
    void (async () => {
      try {
        let stored: Session | null = null;
        try {
          const value = JSON.parse(localStorage.getItem(sessionStorageKey) ?? 'null');
          const user = authUserSchema.safeParse(value?.user);
          if (user.success && typeof value.token === 'string' && value.token && (!value.apiUrl || value.apiUrl === apiUrl)) {
            stored = { token: value.token, user: user.data, apiUrl };
          }
        } catch { /* Invalid persisted sessions return to login. */ }
        const validate = async () => {
          if (!stored) return null;
          const response = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/v1/${product}/auth/me`, {
            headers: { authorization: `Bearer ${stored.token}` }, signal: controller.signal,
          });
          if (!response.ok) return null;
          const value = authSessionInfoSchema.parse(await response.json());
          if (value.product !== product) return null;
          return { ...stored, user: value.user };
        };
        const [status, validated] = await Promise.all([client.getBootstrapStatusFor(product), validate().catch(() => null)]);
        if (generation.current !== current) return;
        setMode(status.bootstrapped ? 'login' : 'setup');
        setSession(validated);
        if (validated) localStorage.setItem(sessionStorageKey, JSON.stringify(validated));
        else localStorage.removeItem(sessionStorageKey);
      } catch {
        if (generation.current === current) setMode('unreachable');
      }
    })();
    return () => { generation.current++; controller.abort(); };
  }, [apiUrl, client, product, sessionStorageKey, checkRun]);

  const submit = async (input: { email: string; password: string; fullName: string }) => {
    const current = ++generation.current;
    try {
      const result = mode === 'setup' ? await client.bootstrapFor(product, input) : await client.loginFor(product, input);
      if (generation.current !== current) return;
      const next = { token: result.token, user: result.user, apiUrl };
      localStorage.setItem(sessionStorageKey, JSON.stringify(next));
      setSession(next);
      setMode('login');
      setNotice('');
    } catch (error) { if (generation.current === current) throw error; }
  };
  const changeServer = async (nextUrl: string) => {
    const current = ++generation.current;
    try {
      await createServerApiClient(nextUrl).getBootstrapStatusFor(product);
      if (generation.current !== current) return;
      localStorage.removeItem(sessionStorageKey);
      localStorage.setItem(apiUrlStorageKey, nextUrl);
      setSession(null);
      setMode('checking');
      setApiUrl(nextUrl);
      setCheckRun((run) => run + 1);
    } catch (error) { if (generation.current === current) throw error; }
  };
  if (session) return <RendererHost session={session} mount={mount} onLogout={logout} product={product} />;
  return <AuthScreen product={product} mode={mode} serverUrl={apiUrl} defaultServerUrl={defaultApiUrl}
    notice={notice} initialCredentials={initialCredentials} onSubmit={submit} onServerUrlChange={changeServer}
    onRetry={() => { generation.current++; setCheckRun((run) => run + 1); }} />;
}
