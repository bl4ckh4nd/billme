import React from 'react';
import {
  createServerApiClient,
  authUserSchema,
  type AuthUser,
} from '@billme/server-core';
import {
  BrowserRendererHost,
  MobilePairingControl,
  useBrowserDocumentShell,
  usePdfAutoPrint,
  type BrowserDocumentShellConfig,
  type DesktopRendererRuntime,
} from '@billme/desktop-renderer';
import ProDesktopApp from '../../pro-desktop/App';
import { AuthScreen, Input } from '@billme/ui';
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
  pairing?: { apiUrl: string; token: string };
}> = ({ api, onLogout, autoPrint = false, pairing }) => {
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

  return (<>
    {pairing ? <MobilePairingControl {...pairing} product="pro" /> : null}
    <BrowserRendererHost api={api} runtime={runtime} AppComponent={ProDesktopApp}>
      {(mountError) => (
        <main className="flex min-h-screen items-center justify-center bg-canvas px-6 py-10">
          <div className="w-full max-w-xl rounded-3xl border border-error-border bg-surface p-6 shadow-xl">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Billme Pro Web</p>
            <h1 className="mt-2 text-xl font-semibold text-foreground">Renderer konnte nicht gestartet werden</h1>
            <p className="mt-3 text-sm text-muted">{mountError}</p>
          </div>
        </main>
      )}
    </BrowserRendererHost>
  </>);
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
        <main className="flex min-h-screen items-center justify-center bg-canvas px-6 py-10">
          <div className="w-full max-w-xl rounded-3xl border border-error-border bg-surface p-6 shadow-xl">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Billme Pro Web</p>
            <h1 className="mt-2 text-xl font-semibold text-foreground">Print mode unavailable</h1>
            <p className="mt-3 text-sm text-muted">Please sign in again before printing or exporting a PDF.</p>
          </div>
        </main>
      );
    }
    return <ProRendererWorkspace api={shell.printApi} autoPrint={shouldAutoPrint} />;
  }

  if (!shell.loadingSession && shell.session) {
    return <ProRendererWorkspace api={shell.createWorkspaceApi(shell.session)} onLogout={shell.logout} pairing={{ apiUrl: shell.apiUrl, token: shell.session.token }} />;
  }

  const handleSubmit = () => {
    const credentials = { email, password, fullName };
    return shell.bootstrapReady ? shell.bootstrap(credentials) : shell.login(credentials);
  };

  return (
    <AuthScreen
      productLabel="Billme Pro Web"
      title="Echte Pro-UI, servergestützt im Browser."
      description={`Diese Shell lädt die bestehende apps/pro-desktop Oberfläche und verbindet sie über einen HTTP-Adapter mit dem Server-Backend.`}
      stats={[
        { label: 'Server', value: shell.health, hint: 'Aktiver API-Endpunkt' },
        { label: 'Rollen', value: String(shell.roles.length), hint: shell.roles.join(', ') || 'Wird geladen' },
      ]}
      formEyebrow={shell.bootstrapReady ? 'Erststart' : 'Anmelden'}
      formTitle={shell.bootstrapReady ? 'Pro-Mandant initialisieren' : 'Mit Billme Pro verbinden'}
      formDescription="Desktop-nahe Funktionen laufen im Browser mit Web-Fallbacks, während Dokumente und Stammdaten über die bestehenden Server-Endpunkte geladen werden."
      message={shell.message || null}
      messageTone={shell.message?.toLowerCase().includes('fehler') ? 'danger' : 'neutral'}
      onSubmit={handleSubmit}
      submitLabel={shell.bootstrapReady ? 'Initialisieren & anmelden' : 'Anmelden'}
    >
      <Input
        label="API-URL"
        fullWidth
        value={shell.apiUrl}
        onChange={(event) => shell.setApiUrl(event.target.value)}
      />
      {shell.bootstrapReady ? (
        <Input
          label="Vollständiger Name"
          fullWidth
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
        />
      ) : null}
      <Input
        label="E-Mail"
        fullWidth
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        type="email"
      />
      <Input
        label="Passwort"
        fullWidth
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        type="password"
      />
    </AuthScreen>
  );
}
