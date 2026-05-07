import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createServerApiClient,
  authUserSchema,
  type AuthUser,
} from '@billme/server-core';
import { Button, Input } from '@billme/ui';
import type { BillmeApi } from '@billme/desktop-contracts-pro/api';
import { createProWebBillmeApi } from './api/createProWebBillmeApi';

const SESSION_STORAGE_KEY = 'billme.web-pro.session.v1';
const API_URL_STORAGE_KEY = 'billme.web-pro.api-url.v1';
const DEFAULT_API_PORT = 3100;

type StoredSession = {
  token: string;
  user: AuthUser;
};

const normalizeApiUrl = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

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

const getInitialApiUrl = (): string => {
  if (typeof window === 'undefined') {
    return getBrowserDefaultApiUrl();
  }
  return (
    getRuntimeApiUrl()
    ?? normalizeApiUrl(window.localStorage.getItem(API_URL_STORAGE_KEY))
    ?? getBrowserDefaultApiUrl()
  );
};

const readStoredSession = (): StoredSession | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { token?: unknown; user?: unknown };
    if (typeof parsed.token !== 'string') {
      return null;
    }
    return {
      token: parsed.token,
      user: authUserSchema.parse(parsed.user),
    };
  } catch {
    return null;
  }
};

const persistSession = (session: StoredSession | null) => {
  if (typeof window === 'undefined') {
    return;
  }
  if (!session) {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
};

const persistApiUrl = (apiUrl: string) => {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(API_URL_STORAGE_KEY, apiUrl);
};

const createRendererQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        gcTime: 5 * 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });

const proDesktopModules = import.meta.glob('../../pro-desktop/App.tsx');

const ProDesktopShell: React.FC<{
  api: BillmeApi;
}> = ({ api }) => {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const [mountError, setMountError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!hostRef.current) {
      return undefined;
    }

    const runtime = globalThis as typeof globalThis & {
      billmeApi?: BillmeApi;
    };

    runtime.billmeApi = api;
    let root: Root | undefined;
    let cancelled = false;

    const loadProDesktopApp = proDesktopModules['../../pro-desktop/App.tsx'];
    if (!loadProDesktopApp) {
      setMountError('apps/pro-desktop/App.tsx konnte nicht geladen werden.');
      return undefined;
    }

    void loadProDesktopApp()
      .then((module) => {
        if (!hostRef.current || cancelled) {
          return;
        }
        const ProDesktopApp = (module as { default: React.ComponentType }).default;
        const queryClient = createRendererQueryClient();
        root = createRoot(hostRef.current);
        root.render(
          <React.StrictMode>
            <QueryClientProvider client={queryClient}>
              <ProDesktopApp />
            </QueryClientProvider>
          </React.StrictMode>,
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMountError(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      cancelled = true;
      root?.unmount();
      if (runtime.billmeApi === api) {
        delete runtime.billmeApi;
      }
    };
  }, [api]);

  if (mountError) {
    return (
      <div className="auth-shell">
        <section className="auth-panel">
          <p className="section-eyebrow">Billme Pro Web</p>
          <h1>Renderer konnte nicht gestartet werden</h1>
          <p className="hero-copy">{mountError}</p>
        </section>
      </div>
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
    () => createProWebBillmeApi({ baseUrl: apiUrl, token: session.token, onAuthFailure: onLogout }),
    [apiUrl, onLogout, session.token],
  );

  return <ProDesktopShell api={api} />;
};

export default function App() {
  const [apiUrl, setApiUrl] = React.useState(getInitialApiUrl);
  const [health, setHealth] = React.useState('Verbinde…');
  const [roles, setRoles] = React.useState<string[]>([]);
  const [bootstrapReady, setBootstrapReady] = React.useState(false);
  const [loadingSession, setLoadingSession] = React.useState(true);
  const [email, setEmail] = React.useState('owner@example.com');
  const [password, setPassword] = React.useState('billme-server-123');
  const [fullName, setFullName] = React.useState('Billme Pro Owner');
  const [message, setMessage] = React.useState('');
  const [session, setSession] = React.useState<StoredSession | null>(null);
  const authClient = React.useMemo(() => createServerApiClient(apiUrl), [apiUrl]);

  const handleLogout = React.useCallback(() => {
    persistSession(null);
    setSession(null);
    setMessage('Abgemeldet.');
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const storedSession = readStoredSession();
        const [healthResponse, capabilitiesResponse, bootstrapStatus, validatedSession] = await Promise.all([
          authClient.getHealth(),
          authClient.getCapabilities(),
          authClient.getBootstrapStatusFor('pro'),
          storedSession
            ? authClient.getSessionInfo({ token: storedSession.token, product: 'pro' }).catch(() => null)
            : Promise.resolve(null),
        ]);

        if (cancelled) {
          return;
        }

        setHealth(`${healthResponse.service} · ${healthResponse.backend}`);
        setRoles(capabilitiesResponse.auth.roles);
        setBootstrapReady(!bootstrapStatus.bootstrapped);

        if (storedSession && validatedSession) {
          setSession({ token: storedSession.token, user: validatedSession.user });
        } else if (storedSession) {
          persistSession(null);
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
  }, [authClient]);

  const finishAuth = React.useCallback(
    (nextSession: StoredSession) => {
      persistApiUrl(apiUrl);
      persistSession(nextSession);
      setSession(nextSession);
      setBootstrapReady(false);
      setMessage('');
    },
    [apiUrl],
  );

  const handleBootstrap = async () => {
    try {
      const response = await authClient.bootstrapFor('pro', { email, password, fullName });
      finishAuth({ token: response.token, user: response.user });
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleLogin = async () => {
    try {
      const response = await authClient.loginFor('pro', { email, password });
      finishAuth({ token: response.token, user: response.user });
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  if (!loadingSession && session) {
    return <AuthenticatedWorkspace apiUrl={apiUrl} session={session} onLogout={handleLogout} />;
  }

  return (
    <main className="auth-shell">
      <section className="auth-hero">
        <p className="hero-kicker">Billme Pro Web</p>
        <h1>Echte Pro-UI, servergestützt im Browser.</h1>
        <p className="hero-copy">
          Diese Shell lädt die bestehende {`apps/pro-desktop`} Oberfläche und verbindet sie über einen HTTP-Adapter mit dem Server-Backend.
        </p>
        <div className="hero-metrics">
          <div className="stat-card">
            <span className="stat-label">Server</span>
            <strong className="stat-value">{health}</strong>
            <span className="stat-hint">Aktiver API-Endpunkt</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Rollen</span>
            <strong className="stat-value">{roles.length}</strong>
            <span className="stat-hint">{roles.join(', ') || 'Wird geladen'}</span>
          </div>
        </div>
      </section>

      <section className="auth-panel">
        <p className="section-eyebrow">{bootstrapReady ? 'Erststart' : 'Anmelden'}</p>
        <h2 className="text-2xl font-bold m-0">{bootstrapReady ? 'Pro-Mandant initialisieren' : 'Mit Billme Pro verbinden'}</h2>
        <p className="helper-copy">
          Desktop-nahe Funktionen laufen im Browser mit Web-Fallbacks, während Dokumente und Stammdaten über die bestehenden Server-Endpunkte geladen werden.
        </p>

        {message ? (
          <div className={`notice-banner ${message.toLowerCase().includes('fehler') ? 'notice-danger' : 'notice-neutral'}`}>
            {message}
          </div>
        ) : null}

        <div className="section-card p-6">
          <div className="grid gap-4">
            <label className="grid gap-2">
              <span className="text-sm font-semibold">API-URL</span>
              <Input value={apiUrl} onChange={(event) => setApiUrl(event.target.value)} />
            </label>
            {bootstrapReady ? (
              <label className="grid gap-2">
                <span className="text-sm font-semibold">Vollständiger Name</span>
                <Input value={fullName} onChange={(event) => setFullName(event.target.value)} />
              </label>
            ) : null}
            <label className="grid gap-2">
              <span className="text-sm font-semibold">E-Mail</span>
              <Input value={email} onChange={(event) => setEmail(event.target.value)} type="email" />
            </label>
            <label className="grid gap-2">
              <span className="text-sm font-semibold">Passwort</span>
              <Input value={password} onChange={(event) => setPassword(event.target.value)} type="password" />
            </label>
          </div>
          <div className="action-row mt-5">
            {bootstrapReady ? (
              <Button onClick={handleBootstrap}>Initialisieren & anmelden</Button>
            ) : (
              <Button onClick={handleLogin}>Anmelden</Button>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
