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
  MobilePairingControl,
  useBrowserDocumentShell,
  usePdfAutoPrint,
  type BrowserDocumentShellConfig,
  type DesktopRendererRuntime,
} from '@billme/desktop-renderer';
import DesktopApp from '../../desktop/App';
import { AuthScreen, Button, Input } from '@billme/ui';
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
  pairing?: { apiUrl: string; token: string };
}> = ({ api, onLogout, autoPrint = false, pairing }) => {
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

  return (<>
    {pairing ? <MobilePairingControl {...pairing} product="lite" /> : null}
    <BrowserRendererHost api={api} runtime={runtime} AppComponent={DesktopApp}>
      {(mountError) => (
        <main className="flex min-h-screen items-center justify-center bg-canvas px-6 py-10">
          <div className="w-full max-w-xl rounded-3xl border border-error-border bg-surface p-6 shadow-xl">
            <h1 className="text-xl font-semibold text-foreground">Billme Lite failed to start</h1>
            <p className="mt-3 text-sm text-muted">{mountError}</p>
            {onLogout ? (
              <Button className="mt-5" onClick={onLogout}>
                Back to login
              </Button>
            ) : null}
          </div>
        </main>
      )}
    </BrowserRendererHost>
  </>);
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
        <main className="flex min-h-screen items-center justify-center bg-canvas px-6 py-10">
          <div className="w-full max-w-xl rounded-3xl border border-error-border bg-surface p-6 shadow-xl">
            <h1 className="text-xl font-semibold text-foreground">Billme Lite print mode unavailable</h1>
            <p className="mt-3 text-sm text-muted">Please sign in again before printing or exporting a PDF.</p>
          </div>
        </main>
      );
    }
    return <RendererWorkspace api={shell.printApi} autoPrint={shouldAutoPrint} />;
  }

  if (!shell.loadingSession && shell.session) {
    return <RendererWorkspace api={shell.createWorkspaceApi(shell.session)} onLogout={shell.logout} pairing={{ apiUrl: shell.apiUrl, token: shell.session.token }} />;
  }

  const handleSubmit = () => {
    const credentials = { email, password, fullName };
    return shell.bootstrapReady ? shell.bootstrap(credentials) : shell.login(credentials);
  };

  const activeRoles = shell.roles.length > 0 ? shell.roles : supportedServerRoles;

  return (
    <AuthScreen
      productLabel="Billme Lite Web"
      title="Sign in to Billme Lite"
      description="Use your server-backed workspace in the browser. After login, the shared desktop renderer takes over."
      stats={[
        { label: 'Backend', value: shell.health },
        { label: 'API URL', value: shell.apiUrl },
      ]}
      roles={activeRoles}
      formEyebrow={shell.bootstrapReady ? 'First run' : 'Welcome back'}
      formTitle={shell.bootstrapReady ? 'Bootstrap lite owner' : 'Login'}
      formDescription={
        shell.bootstrapReady
          ? 'Create the first owner account for this workspace.'
          : 'Enter your credentials to open your lite workspace.'
      }
      message={shell.message || null}
      messageTone={shell.message?.toLowerCase().includes('fail') ? 'danger' : 'neutral'}
      onSubmit={handleSubmit}
      submitLabel={shell.bootstrapReady ? 'Create owner account' : 'Open lite workspace'}
    >
      {shell.bootstrapReady ? (
        <Input
          label="Full name"
          fullWidth
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
          placeholder="Full name"
        />
      ) : null}
      <Input
        label="Email"
        fullWidth
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="Email"
      />
      <Input
        label="Password"
        fullWidth
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        placeholder="Password"
      />
    </AuthScreen>
  );
}
