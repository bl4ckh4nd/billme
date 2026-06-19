import React from 'react';
import { z } from 'zod';
import {
  createServerApiClient,
  authUserSchema,
  serverProductSchema,
  serverRoleSchema,
  supportedServerRoles,
} from '@billme/server-core';
import {
  BrowserRendererHost,
  useBrowserDocumentShell,
  usePdfAutoPrint,
  type BrowserDocumentShellConfig,
  type DesktopRendererRuntime,
} from '@billme/desktop-renderer';
import DesktopApp from '../../desktop/App';
import { Button, Input } from '@billme/ui';
import { createLiteWebBillmeApi } from './api/createLiteWebApi';

const SESSION_STORAGE_KEY = 'billme.web.lite.session.v1';
const LITE_NAVIGATION = ['dashboard', 'clients', 'projects', 'documents', 'finance', 'articles'];

const sessionInfoSchema = z.object({
  user: authUserSchema,
  tenantId: z.string().min(1),
  product: serverProductSchema,
  role: serverRoleSchema,
});

type AuthUser = z.infer<typeof authUserSchema>;
type LiteWebApi = ReturnType<typeof createLiteWebBillmeApi>;

const fetchLiteSession = async (baseUrl: string, token: string): Promise<AuthUser> => {
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
  return sessionInfoSchema.parse(payload).user;
};

const createLiteAuthAdapter = (apiUrl: string) => {
  const authClient = createServerApiClient(apiUrl);
  return {
    getHealthLabel: async () => {
      const health = await authClient.getHealth();
      return `${health.service} (${health.backend})`;
    },
    getRoles: async () => {
      const capabilities = await authClient.getCapabilities();
      return capabilities.auth.roles;
    },
    getBootstrapReady: async () => {
      const status = await authClient.getBootstrapStatus();
      return !status.bootstrapped;
    },
    validateSession: (token: string) => fetchLiteSession(apiUrl, token),
    login: async ({ email, password }: { email: string; password: string }) => {
      const response = await authClient.login({ email, password });
      return { token: response.token, user: response.user };
    },
    bootstrap: async ({ email, password, fullName }: { email: string; password: string; fullName: string }) => {
      const response = await authClient.bootstrap({ email, password, fullName });
      return { token: response.token, user: response.user };
    },
  };
};

const RendererWorkspace: React.FC<{
  api: LiteWebApi;
  onLogout?: () => void;
  autoPrint?: boolean;
}> = ({ api, onLogout, autoPrint = false }) => {
  usePdfAutoPrint(autoPrint);
  const runtime = React.useMemo<DesktopRendererRuntime>(
    () => ({
      shell: 'web',
      product: 'lite',
      navigation: LITE_NAVIGATION,
      onLogout,
    }),
    [onLogout],
  );

  return (
    <BrowserRendererHost api={api} runtime={runtime} AppComponent={DesktopApp}>
      {(mountError) => (
        <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 py-10 text-slate-50">
          <div className="w-full max-w-xl rounded-3xl border border-red-500/30 bg-slate-900/90 p-6 shadow-2xl shadow-black/30">
            <h1 className="text-xl font-semibold">Billme Lite failed to start</h1>
            <p className="mt-3 text-sm text-slate-300">{mountError}</p>
            {onLogout ? (
              <Button className="mt-5" onClick={onLogout}>
                Back to login
              </Button>
            ) : null}
          </div>
        </main>
      )}
    </BrowserRendererHost>
  );
};

export default function App() {
  const shellConfig = React.useMemo<BrowserDocumentShellConfig<LiteWebApi, AuthUser>>(
    () => ({
      product: 'lite',
      sessionStorageKey: SESSION_STORAGE_KEY,
      initialHealth: 'Checking server...',
      signedOutMessage: 'You have been signed out.',
      createAuthAdapter: createLiteAuthAdapter,
      createApi: ({ baseUrl, token, onAuthFailure, onRequestClose }) =>
        createLiteWebBillmeApi({ baseUrl, token, onAuthFailure, onRequestClose }),
      parseStoredUser: (value) => authUserSchema.parse(value),
    }),
    [],
  );
  const shell = useBrowserDocumentShell(shellConfig);
  const [email, setEmail] = React.useState('owner@example.com');
  const [password, setPassword] = React.useState('billme-server-123');
  const [fullName, setFullName] = React.useState('Billme Lite Owner');
  const shouldAutoPrint = React.useMemo(
    () => new URLSearchParams(window.location.search).get('__autoprint') === '1',
    [],
  );

  if (shell.isPrintMode) {
    if (!shell.printApi) {
      return (
        <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 py-10 text-slate-50">
          <div className="w-full max-w-xl rounded-3xl border border-red-500/30 bg-slate-900/90 p-6 shadow-2xl shadow-black/30">
            <h1 className="text-xl font-semibold">Billme Lite print mode unavailable</h1>
            <p className="mt-3 text-sm text-slate-300">Please sign in again before printing or exporting a PDF.</p>
          </div>
        </main>
      );
    }
    return <RendererWorkspace api={shell.printApi} autoPrint={shouldAutoPrint} />;
  }

  if (!shell.loadingSession && shell.session) {
    return <RendererWorkspace api={shell.createWorkspaceApi(shell.session)} onLogout={shell.logout} />;
  }

  const handleSubmit = () => {
    const credentials = { email, password, fullName };
    return shell.bootstrapReady ? shell.bootstrap(credentials) : shell.login(credentials);
  };

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
            <p className="mt-3 text-sm text-slate-300">API URL: {shell.apiUrl}</p>
            <p className="mt-2 text-sm text-slate-200">{shell.health}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {(shell.roles.length > 0 ? shell.roles : supportedServerRoles).map((role) => (
                <span key={role} className="rounded-full bg-emerald-500/15 px-3 py-1 text-xs text-emerald-300">
                  {role}
                </span>
              ))}
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-slate-900/80 p-6">
            <h2 className="text-lg font-semibold">{shell.bootstrapReady ? 'Bootstrap lite owner' : 'Login'}</h2>
            <div className="mt-4 grid gap-3">
              {shell.bootstrapReady ? (
                <Input value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="Full name" />
              ) : null}
              <Input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email" />
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Password"
              />
              <Button onClick={handleSubmit}>
                {shell.bootstrapReady ? 'Create owner account' : 'Open lite workspace'}
              </Button>
              {shell.message ? <p className="text-sm text-slate-300">{shell.message}</p> : null}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
