import React from 'react';
import {
  createServerApiClient,
  authUserSchema,
  type AuthUser,
} from '@billme/server-core';
import {
  BrowserRendererHost,
  useBrowserDocumentShell,
  usePdfAutoPrint,
  type BrowserDocumentShellConfig,
  type DesktopRendererRuntime,
} from '@billme/desktop-renderer';
import ProDesktopApp from '../../pro-desktop/App';
import { Button, Input } from '@billme/ui';
import type { BillmeApi } from '@billme/desktop-contracts-pro/api';
import { createProWebBillmeApi } from './api/createProWebBillmeApi';

const SESSION_STORAGE_KEY = 'billme.web-pro.session.v1';
const API_URL_STORAGE_KEY = 'billme.web-pro.api-url.v1';
const PRO_NAVIGATION = ['dashboard', 'clients', 'projects', 'documents', 'finance', 'articles', 'pro'];

const createProAuthAdapter = (apiUrl: string) => {
  const authClient = createServerApiClient(apiUrl);
  return {
    getHealthLabel: async () => {
      const health = await authClient.getHealth();
      return `${health.service} · ${health.backend}`;
    },
    getRoles: async () => {
      const capabilities = await authClient.getCapabilities();
      return capabilities.auth.roles;
    },
    getBootstrapReady: async () => {
      const status = await authClient.getBootstrapStatusFor('pro');
      return !status.bootstrapped;
    },
    validateSession: async (token: string) => {
      const session = await authClient.getSessionInfo({ token, product: 'pro' });
      return session.user;
    },
    login: async ({ email, password }: { email: string; password: string }) => {
      const response = await authClient.loginFor('pro', { email, password });
      return { token: response.token, user: response.user };
    },
    bootstrap: async ({ email, password, fullName }: { email: string; password: string; fullName: string }) => {
      const response = await authClient.bootstrapFor('pro', { email, password, fullName });
      return { token: response.token, user: response.user };
    },
  };
};

const ProRendererWorkspace: React.FC<{
  api: BillmeApi;
  onLogout?: () => void;
  autoPrint?: boolean;
}> = ({ api, onLogout, autoPrint = false }) => {
  usePdfAutoPrint(autoPrint);
  const runtime = React.useMemo<DesktopRendererRuntime>(
    () => ({
      shell: 'web',
      product: 'pro',
      navigation: PRO_NAVIGATION,
      onLogout,
    }),
    [onLogout],
  );

  return (
    <BrowserRendererHost api={api} runtime={runtime} AppComponent={ProDesktopApp}>
      {(mountError) => (
        <div className="auth-shell">
          <section className="auth-panel">
            <p className="section-eyebrow">Billme Pro Web</p>
            <h1>Renderer konnte nicht gestartet werden</h1>
            <p className="hero-copy">{mountError}</p>
          </section>
        </div>
      )}
    </BrowserRendererHost>
  );
};

export default function App() {
  const shellConfig = React.useMemo<BrowserDocumentShellConfig<BillmeApi, AuthUser>>(
    () => ({
      product: 'pro',
      sessionStorageKey: SESSION_STORAGE_KEY,
      apiUrlStorageKey: API_URL_STORAGE_KEY,
      initialHealth: 'Verbinde...',
      signedOutMessage: 'Abgemeldet.',
      persistApiUrlOnAuth: true,
      createAuthAdapter: createProAuthAdapter,
      createApi: ({ baseUrl, token, onAuthFailure }) =>
        createProWebBillmeApi({ baseUrl, token, onAuthFailure }),
      parseStoredUser: (value) => authUserSchema.parse(value),
    }),
    [],
  );
  const shell = useBrowserDocumentShell(shellConfig);
  const [email, setEmail] = React.useState('owner@example.com');
  const [password, setPassword] = React.useState('billme-server-123');
  const [fullName, setFullName] = React.useState('Billme Pro Owner');
  const shouldAutoPrint = React.useMemo(
    () => new URLSearchParams(window.location.search).get('__autoprint') === '1',
    [],
  );

  if (shell.isPrintMode) {
    if (!shell.printApi) {
      return (
        <div className="auth-shell">
          <section className="auth-panel">
            <p className="section-eyebrow">Billme Pro Web</p>
            <h1>Print mode unavailable</h1>
            <p className="hero-copy">Please sign in again before printing or exporting a PDF.</p>
          </section>
        </div>
      );
    }
    return <ProRendererWorkspace api={shell.printApi} autoPrint={shouldAutoPrint} />;
  }

  if (!shell.loadingSession && shell.session) {
    return <ProRendererWorkspace api={shell.createWorkspaceApi(shell.session)} onLogout={shell.logout} />;
  }

  const handleSubmit = () => {
    const credentials = { email, password, fullName };
    return shell.bootstrapReady ? shell.bootstrap(credentials) : shell.login(credentials);
  };

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
            <strong className="stat-value">{shell.health}</strong>
            <span className="stat-hint">Aktiver API-Endpunkt</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">Rollen</span>
            <strong className="stat-value">{shell.roles.length}</strong>
            <span className="stat-hint">{shell.roles.join(', ') || 'Wird geladen'}</span>
          </div>
        </div>
      </section>

      <section className="auth-panel">
        <p className="section-eyebrow">{shell.bootstrapReady ? 'Erststart' : 'Anmelden'}</p>
        <h2 className="text-2xl font-bold m-0">{shell.bootstrapReady ? 'Pro-Mandant initialisieren' : 'Mit Billme Pro verbinden'}</h2>
        <p className="helper-copy">
          Desktop-nahe Funktionen laufen im Browser mit Web-Fallbacks, während Dokumente und Stammdaten über die bestehenden Server-Endpunkte geladen werden.
        </p>

        {shell.message ? (
          <div className={`notice-banner ${shell.message.toLowerCase().includes('fehler') ? 'notice-danger' : 'notice-neutral'}`}>
            {shell.message}
          </div>
        ) : null}

        <div className="section-card p-6">
          <div className="grid gap-4">
            <label className="grid gap-2">
              <span className="text-sm font-semibold">API-URL</span>
              <Input value={shell.apiUrl} onChange={(event) => shell.setApiUrl(event.target.value)} />
            </label>
            {shell.bootstrapReady ? (
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
            {shell.bootstrapReady ? (
              <Button onClick={handleSubmit}>Initialisieren & anmelden</Button>
            ) : (
              <Button onClick={handleSubmit}>Anmelden</Button>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
