import React from 'react';
import { z } from 'zod';
import { createServerApiClient, authUserSchema, serverProductSchema, serverRoleSchema, supportedServerRoles } from '@billme/server-core';
import { QueryClientProvider } from '@tanstack/react-query';
import { createRendererQueryClient, mountDesktopRendererApp, type DesktopRendererRuntime } from '@billme/desktop-renderer';
import { Button, Input } from '@billme/ui';
import { createLiteWebBillmeApi } from './api/createLiteWebApi';
import { PrintDocument } from '../../desktop/components/PrintDocument';
import { PrintEurDocument } from '../../desktop/components/PrintEurDocument';
import { ErrorBoundary } from '../../desktop/components/ErrorBoundary';

const SESSION_STORAGE_KEY = 'billme.web.lite.session.v1';
const DEFAULT_API_PORT = 3100;

const sessionInfoSchema = z.object({
  user: authUserSchema,
  tenantId: z.string().min(1),
  product: serverProductSchema,
  role: serverRoleSchema,
});

type StoredSession = {
  token: string;
  user: z.infer<typeof authUserSchema>;
};

type LiteWebApi = ReturnType<typeof createLiteWebBillmeApi>;

type PrintWorkspaceProps = {
  api: LiteWebApi;
};

const normalizeApiUrl = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const isLoopbackHostname = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';

const getBrowserDefaultApiUrl = (): string => {
  if (typeof window === 'undefined') {
    return `http://127.0.0.1:${DEFAULT_API_PORT}`;
  }
  const hostname = window.location.hostname || '127.0.0.1';
  return `http://${hostname}:${DEFAULT_API_PORT}`;
};

const getRuntimeApiUrl = (): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  return normalizeApiUrl(window.billmeRuntimeConfig?.serverApiUrl);
};

const readStoredSession = (): StoredSession | null => {
  const raw = globalThis.localStorage?.getItem(SESSION_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    return z.object({ token: z.string().min(1), user: authUserSchema }).parse(JSON.parse(raw));
  } catch {
    globalThis.localStorage?.removeItem(SESSION_STORAGE_KEY);
    return null;
  }
};

const persistSession = (session: StoredSession) => {
  globalThis.localStorage?.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
};

const clearStoredSession = () => {
  globalThis.localStorage?.removeItem(SESSION_STORAGE_KEY);
};

const fetchLiteSession = async (baseUrl: string, token: string) => {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/v1/lite/auth/me`, {
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string'
      ? payload.message
      : `Request failed with status ${response.status}`;
    throw new Error(message);
  }
  return sessionInfoSchema.parse(payload);
};

const DesktopShell: React.FC<{
  api: LiteWebApi;
  onLogout: () => void;
}> = ({ api, onLogout }) => {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const [mountError, setMountError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!hostRef.current) {
      return undefined;
    }

    const runtime: DesktopRendererRuntime = {
      shell: 'desktop',
      product: 'lite',
      navigation: ['dashboard', 'clients', 'projects', 'documents', 'finance', 'articles'],
      onLogout,
    };

    let cancelled = false;
    let dispose: undefined | (() => void);

    void mountDesktopRendererApp(hostRef.current, { api, runtime })
      .then((cleanup) => {
        if (cancelled) {
          cleanup();
          return;
        }
        dispose = cleanup;
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMountError(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [api, onLogout]);

  if (mountError) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 py-10 text-slate-50">
        <div className="w-full max-w-xl rounded-3xl border border-red-500/30 bg-slate-900/90 p-6 shadow-2xl shadow-black/30">
          <h1 className="text-xl font-semibold">Billme Lite failed to start</h1>
          <p className="mt-3 text-sm text-slate-300">{mountError}</p>
          <Button className="mt-5" onClick={onLogout}>
            Back to login
          </Button>
        </div>
      </main>
    );
  }

  return <div ref={hostRef} className="min-h-screen" />;
};

const AuthenticatedWorkspace: React.FC<{
  apiUrl: string;
  session: StoredSession;
  onLogout: () => void;
}> = ({ apiUrl, session, onLogout }) => {
  const api = React.useMemo(
    () => createLiteWebBillmeApi({ baseUrl: apiUrl, token: session.token, onAuthFailure: onLogout, onRequestClose: onLogout }),
    [apiUrl, onLogout, session.token],
  );

  return <DesktopShell api={api} onLogout={onLogout} />;
};

const PrintWorkspace: React.FC<PrintWorkspaceProps> = ({ api }) => {
  const params = React.useMemo(() => new URLSearchParams(window.location.search), []);
  const queryClient = React.useMemo(() => createRendererQueryClient(), []);
  const kind = params.get('kind');
  const docKind = kind === 'offer' ? 'offer' : 'invoice';
  const docId = params.get('id') ?? '';
  const taxYear = Number(params.get('taxYear') ?? '2025');
  const from = params.get('from') ?? undefined;
  const to = params.get('to') ?? undefined;
  const shouldAutoPrint = params.get('__autoprint') === '1';

  (globalThis as typeof globalThis & { billmeApi?: LiteWebApi }).billmeApi = api;

  React.useEffect(() => {
    const runtime = globalThis as typeof globalThis & { billmeApi?: LiteWebApi };
    runtime.billmeApi = api;
    return () => {
      if (runtime.billmeApi === api) {
        delete runtime.billmeApi;
      }
    };
  }, [api]);

  React.useEffect(() => {
    if (!shouldAutoPrint) {
      return;
    }
    let cancelled = false;
    let attempts = 0;
    const tick = () => {
      if (cancelled) {
        return;
      }
      if ((globalThis as { __PDF_READY__?: boolean }).__PDF_READY__ === true) {
        window.print();
        return;
      }
      if (attempts < 120) {
        attempts += 1;
        window.setTimeout(tick, 100);
      }
    };
    tick();
    return () => {
      cancelled = true;
    };
  }, [shouldAutoPrint]);

  return (
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        {kind === 'eur' ? (
          <PrintEurDocument taxYear={taxYear} from={from} to={to} />
        ) : (
          <PrintDocument kind={docKind} id={docId} />
        )}
      </ErrorBoundary>
    </QueryClientProvider>
  );
};

export default function App() {
  const apiUrl = React.useMemo(() => getRuntimeApiUrl() ?? getBrowserDefaultApiUrl(), []);
  const authClient = React.useMemo(() => createServerApiClient(apiUrl), [apiUrl]);
  const searchParams = React.useMemo(() => new URLSearchParams(window.location.search), []);
  const isPrintMode = searchParams.get('__print') === '1';
  const storedPrintSession = React.useMemo(() => readStoredSession(), []);
  const [health, setHealth] = React.useState<string>('Checking server...');
  const [capabilities, setCapabilities] = React.useState<string[]>([]);
  const [bootstrapReady, setBootstrapReady] = React.useState(false);
  const [loadingSession, setLoadingSession] = React.useState(true);
  const [email, setEmail] = React.useState('owner@example.com');
  const [password, setPassword] = React.useState('billme-server-123');
  const [fullName, setFullName] = React.useState('Billme Lite Owner');
  const [message, setMessage] = React.useState('');
  const [session, setSession] = React.useState<StoredSession | null>(null);

  const handleLogout = React.useCallback(() => {
    clearStoredSession();
    setSession(null);
    setMessage('You have been signed out.');
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const storedSession = readStoredSession();
        const [healthResponse, capabilitiesResponse, bootstrapStatus, validatedSession] = await Promise.all([
          authClient.getHealth(),
          authClient.getCapabilities(),
          authClient.getBootstrapStatus(),
          storedSession ? fetchLiteSession(apiUrl, storedSession.token).catch(() => null) : Promise.resolve(null),
        ]);

        if (cancelled) {
          return;
        }

        setHealth(`${healthResponse.service} (${healthResponse.backend})`);
        setCapabilities(capabilitiesResponse.auth.roles);
        setBootstrapReady(!bootstrapStatus.bootstrapped);

        if (storedSession && validatedSession) {
          setSession({ token: storedSession.token, user: validatedSession.user });
        } else if (storedSession) {
          clearStoredSession();
        }
      } catch (error: unknown) {
        if (!cancelled) {
          setHealth(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) {
          setLoadingSession(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiUrl, authClient]);

  const finishAuth = React.useCallback((nextSession: StoredSession) => {
    persistSession(nextSession);
    setSession(nextSession);
    setBootstrapReady(false);
    setMessage('');
  }, []);

  const printApi = React.useMemo(
    () => storedPrintSession
      ? createLiteWebBillmeApi({
          baseUrl: apiUrl,
          token: storedPrintSession.token,
          onAuthFailure: handleLogout,
          onRequestClose: handleLogout,
        })
      : null,
    [apiUrl, handleLogout, storedPrintSession],
  );

  if (isPrintMode) {
    if (!printApi) {
      return (
        <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 py-10 text-slate-50">
          <div className="w-full max-w-xl rounded-3xl border border-red-500/30 bg-slate-900/90 p-6 shadow-2xl shadow-black/30">
            <h1 className="text-xl font-semibold">Billme Lite print mode unavailable</h1>
            <p className="mt-3 text-sm text-slate-300">Please sign in again before printing or exporting a PDF.</p>
          </div>
        </main>
      );
    }
    return <PrintWorkspace api={printApi} />;
  }

  const handleBootstrap = async () => {
    try {
      const response = await authClient.bootstrap({ email, password, fullName });
      finishAuth({ token: response.token, user: response.user });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleLogin = async () => {
    try {
      const response = await authClient.login({ email, password });
      finishAuth({ token: response.token, user: response.user });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  if (!loadingSession && session) {
    return <AuthenticatedWorkspace apiUrl={apiUrl} session={session} onLogout={handleLogout} />;
  }

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-50">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <section className="rounded-3xl border border-white/10 bg-white/5 p-8 shadow-2xl shadow-black/25">
          <p className="mb-3 text-sm font-semibold uppercase tracking-[0.25em] text-emerald-300">Billme Lite Web</p>
          <h1 className="text-4xl font-semibold">Sign in to Billme Lite</h1>
          <p className="mt-3 max-w-2xl text-sm text-slate-300">
            Use your server-backed workspace in the browser. After login, the shared desktop renderer takes over.
          </p>
        </section>

        <section className="grid gap-6 md:grid-cols-2">
          <div className="rounded-3xl border border-white/10 bg-slate-900/80 p-6">
            <h2 className="text-lg font-semibold">Backend status</h2>
            <p className="mt-3 text-sm text-slate-300">API URL: {apiUrl}</p>
            <p className="mt-2 text-sm text-slate-200">{health}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {(capabilities.length > 0 ? capabilities : supportedServerRoles).map((role) => (
                <span key={role} className="rounded-full bg-emerald-500/15 px-3 py-1 text-xs text-emerald-300">
                  {role}
                </span>
              ))}
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-slate-900/80 p-6">
            <h2 className="text-lg font-semibold">{bootstrapReady ? 'Bootstrap lite owner' : 'Login'}</h2>
            <div className="mt-4 grid gap-3">
              {bootstrapReady ? (
                <Input value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="Full name" />
              ) : null}
              <Input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email" />
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Password"
              />
              <Button onClick={bootstrapReady ? handleBootstrap : handleLogin}>
                {bootstrapReady ? 'Create owner account' : 'Open lite workspace'}
              </Button>
              {message ? <p className="text-sm text-slate-300">{message}</p> : null}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
