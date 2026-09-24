import React from 'react';
import { z } from 'zod';
import { createServerApiClient, authUserSchema, serverProductSchema, serverRoleSchema } from '@billme/server-core';
import { mountProDesktopRendererApp, type DesktopRendererRuntime } from '@billme/desktop-renderer/pro';
import { AuthScreen, ErrorState, type AuthScreenMode } from '@billme/ui';
import { createProWebBillmeApi } from './createProWebApi';

const DEFAULT_API_URL = (import.meta.env.VITE_SERVER_API_URL as string | undefined) ?? 'http://127.0.0.1:3100';
const SESSION_STORAGE_KEY = 'billme.web-pro.session.v1';
const API_URL_STORAGE_KEY = 'billme.web-pro.api-url.v1';
const DEV_CREDENTIALS = import.meta.env.DEV
  ? { email: 'owner@example.com', password: 'billme-server-123', fullName: 'Billme Pro Owner' }
  : undefined;

const readStoredApiUrl = () => globalThis.localStorage?.getItem(API_URL_STORAGE_KEY) ?? DEFAULT_API_URL;

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

const fetchProSession = async (baseUrl: string, token: string) => {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/v1/pro/auth/me`, {
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string'
      ? payload.message
      : `Anfrage fehlgeschlagen (HTTP ${response.status}).`;
    throw new Error(message);
  }
  return sessionInfoSchema.parse(payload);
};

const DesktopShell: React.FC<{
  apiUrl: string;
  token: string;
  onLogout: () => void;
}> = ({ apiUrl, token, onLogout }) => {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const [mountError, setMountError] = React.useState<string | null>(null);
  const api = React.useMemo(
    () => createProWebBillmeApi({ baseUrl: apiUrl, token, onRequestClose: onLogout }),
    [apiUrl, onLogout, token],
  );

  React.useEffect(() => {
    if (!hostRef.current) {
      return undefined;
    }

    const runtime: DesktopRendererRuntime = {
      shell: 'web',
      product: 'pro',
      onLogout,
    };

    let cancelled = false;
    let dispose: undefined | (() => void);

    void mountProDesktopRendererApp(hostRef.current, { api, runtime })
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
      <main className="flex min-h-screen items-center justify-center bg-surface-sunken px-6 py-10">
        <div className="w-full max-w-xl">
          <ErrorState
            title="Billme Pro konnte im Browser nicht gestartet werden"
            description={mountError}
            onRetry={onLogout}
            retryLabel="Zur Anmeldung"
          />
        </div>
      </main>
    );
  }

  return <div ref={hostRef} className="min-h-screen" />;
};

export default function App() {
  const [apiUrl, setApiUrl] = React.useState(readStoredApiUrl);
  const authClient = React.useMemo(() => createServerApiClient(apiUrl), [apiUrl]);
  const [authMode, setAuthMode] = React.useState<AuthScreenMode>('checking');
  const [checkRun, setCheckRun] = React.useState(0);
  const [loadingSession, setLoadingSession] = React.useState(true);
  const [message, setMessage] = React.useState('');
  const [session, setSession] = React.useState<StoredSession | null>(null);

  const handleLogout = React.useCallback(() => {
    clearStoredSession();
    setSession(null);
    setMessage('Du wurdest abgemeldet.');
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    setAuthMode('checking');

    void (async () => {
      try {
        const storedSession = readStoredSession();
        const [bootstrapStatus, validatedSession] = await Promise.all([
          authClient.getBootstrapStatusFor('pro'),
          storedSession ? fetchProSession(apiUrl, storedSession.token).catch(() => null) : Promise.resolve(null),
        ]);

        if (cancelled) {
          return;
        }

        setAuthMode(bootstrapStatus.bootstrapped ? 'login' : 'setup');

        if (storedSession && validatedSession) {
          setSession({ token: storedSession.token, user: validatedSession.user });
        } else if (storedSession) {
          clearStoredSession();
        }
      } catch {
        if (!cancelled) {
          setAuthMode('unreachable');
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
  }, [apiUrl, authClient, checkRun]);

  const handleSubmit = async ({ email, password, fullName }: { email: string; password: string; fullName: string }) => {
    const response = authMode === 'setup'
      ? await authClient.bootstrapFor('pro', { email, password, fullName })
      : await authClient.loginFor('pro', { email, password });
    const nextSession = { token: response.token, user: response.user };
    persistSession(nextSession);
    setSession(nextSession);
    setAuthMode('login');
    setMessage('');
  };

  const handleServerUrlChange = async (nextUrl: string) => {
    await createServerApiClient(nextUrl).getBootstrapStatusFor('pro');
    globalThis.localStorage?.setItem(API_URL_STORAGE_KEY, nextUrl);
    setApiUrl(nextUrl);
  };

  if (!loadingSession && session) {
    return <DesktopShell apiUrl={apiUrl} token={session.token} onLogout={handleLogout} />;
  }

  return (
    <AuthScreen
      product="pro"
      mode={loadingSession ? 'checking' : authMode}
      serverUrl={apiUrl}
      defaultServerUrl={DEFAULT_API_URL}
      notice={message}
      initialCredentials={DEV_CREDENTIALS}
      onSubmit={handleSubmit}
      onRetry={() => setCheckRun((run) => run + 1)}
      onServerUrlChange={handleServerUrlChange}
    />
  );
}
