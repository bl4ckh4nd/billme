import React from 'react';
import { authUserSchema, authSessionInfoSchema, createServerApiClient, type AuthUser } from '@billme/server-core';
import { AuthScreen, ErrorState, type AuthScreenCredentials, type AuthScreenMode, type InvitationPreview } from '@billme/ui';
import type { RendererWorkspaces } from './runtime-api';
import { createWorkspaceClient, type WorkspaceSession } from './workspaceClient';
import { ensureRandomUuid } from './randomUuid';

// Plain http in the LAN is no secure context: give the app crypto.randomUUID before anything renders.
ensureRandomUuid();

type Session = { token: string; user: AuthUser; apiUrl: string };
export type BrowserMountContext = {
  apiUrl: string;
  token: string;
  onLogout: () => void;
  signal: AbortSignal;
  /** The person's workspaces and how to switch; absent when the server cannot list them. */
  workspaces?: RendererWorkspaces;
};
type Props = {
  product: 'lite' | 'pro';
  defaultApiUrl: string;
  sessionStorageKey: string;
  apiUrlStorageKey: string;
  initialCredentials?: { email: string; password: string; fullName: string };
  mount: (element: HTMLElement, context: BrowserMountContext) => Promise<() => void>;
};

/**
 * The API address the web container was started with (`BILLME_PUBLIC_API_URL`, written to /runtime-config.js by the
 * image's entrypoint), so one image serves any server. Ignored unless it is a plain http(s) URL.
 */
export const runtimeApiUrl = (): string | undefined => {
  const value = (globalThis as { __BILLME_RUNTIME__?: { apiUrl?: unknown } }).__BILLME_RUNTIME__?.apiUrl;
  return typeof value === 'string' && /^https?:\/\/[^\s"'<>]+$/.test(value.trim()) ? value.trim().replace(/\/+$/, '') : undefined;
};

/** `?invite=` and `?reset=` links from mails; read once, removed from the address after use. */
const readLink = (): { kind: 'invite' | 'reset'; token: string } | null => {
  const params = new URLSearchParams(window.location.search);
  const invite = params.get('invite');
  if (invite) return { kind: 'invite', token: invite };
  const reset = params.get('reset');
  if (reset) return { kind: 'reset', token: reset };
  return null;
};
const clearLink = () => {
  const url = new URL(window.location.href);
  url.searchParams.delete('invite');
  url.searchParams.delete('reset');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
};

function RendererHost({ session, mount, onLogout, product, loadWorkspaces }: {
  session: Session; mount: Props['mount']; onLogout: () => void; product: Props['product'];
  loadWorkspaces: (session: Session) => Promise<RendererWorkspaces | undefined>;
}) {
  const host = React.useRef<HTMLDivElement>(null);
  const [error, setError] = React.useState<string>();
  React.useEffect(() => {
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    setError(undefined);
    void (async () => {
      // An older server without workspace routes still mounts, just without the switcher.
      const workspaces = await loadWorkspaces(session).catch(() => undefined);
      if (controller.signal.aborted) return;
      const cleanup = await mount(host.current!, { apiUrl: session.apiUrl, token: session.token, workspaces,
        onLogout: () => { if (!controller.signal.aborted) onLogout(); }, signal: controller.signal });
      if (controller.signal.aborted) cleanup(); else dispose = cleanup;
    })().catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { controller.abort(); dispose?.(); };
  }, [session, mount, onLogout, loadWorkspaces]);
  return error ? <main className="flex min-h-screen items-center justify-center bg-ground px-6 py-10">
    <div className="w-full max-w-xl"><ErrorState title={`Billme ${product === 'pro' ? 'Pro' : 'Lite'} konnte im Browser nicht gestartet werden`}
      description={error} onRetry={onLogout} retryLabel="Zur Anmeldung" /></div>
  </main> : <div ref={host} className="min-h-screen" />;
}

export function BrowserDocumentShell({ product, defaultApiUrl: buildApiUrl, sessionStorageKey, apiUrlStorageKey, initialCredentials, mount }: Props) {
  // An address typed in at login wins, then the container's runtime setting, then the one built into the bundle.
  const defaultApiUrl = React.useMemo(() => runtimeApiUrl() ?? buildApiUrl, [buildApiUrl]);
  const [apiUrl, setApiUrl] = React.useState(() => localStorage.getItem(apiUrlStorageKey) ?? defaultApiUrl);
  const [mode, setMode] = React.useState<AuthScreenMode>('checking');
  const [session, setSession] = React.useState<Session | null>(null);
  const [notice, setNotice] = React.useState('');
  const [setupTokenRequired, setSetupTokenRequired] = React.useState(false);
  const [checkRun, setCheckRun] = React.useState(0);
  const [link, setLink] = React.useState(readLink);
  const [invitation, setInvitation] = React.useState<InvitationPreview>();
  const [invalidLinkMessage, setInvalidLinkMessage] = React.useState<string>();
  const generation = React.useRef(0);
  const client = React.useMemo(() => createServerApiClient(apiUrl), [apiUrl]);
  const workspaceClient = React.useMemo(() => createWorkspaceClient(apiUrl), [apiUrl]);

  const persist = React.useCallback((next: Session) => {
    localStorage.setItem(sessionStorageKey, JSON.stringify(next));
    setSession(next);
    setMode('login');
    setNotice('');
  }, [sessionStorageKey]);

  /** A session for the other product belongs in the other app; send the person there. */
  const enter = React.useCallback(async (result: WorkspaceSession) => {
    if (result.product !== product) {
      const apps = await workspaceClient.apps().catch(() => ({} as Partial<Record<'lite' | 'pro', string>>));
      const target = apps[result.product];
      if (target) {
        window.location.assign(target);
        return;
      }
      setMode('login');
      setNotice(`Fertig. Melde dich in Billme ${result.product === 'pro' ? 'Pro' : 'Lite'} mit derselben E-Mail-Adresse an.`);
      return;
    }
    persist({ token: result.token, user: result.user, apiUrl });
  }, [apiUrl, persist, product, workspaceClient]);

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
        if (link?.kind === 'invite') {
          try {
            const preview = await workspaceClient.describeInvitation(link.token);
            if (generation.current !== current) return;
            setInvitation(preview);
            setMode('invite');
          } catch (error) {
            if (generation.current !== current) return;
            setInvalidLinkMessage((error as { status?: number }).status === 410
              ? 'Die Einladung wurde schon angenommen, zurückgezogen oder ist abgelaufen. Bitte lass dich erneut einladen.'
              : 'Diese Einladung gibt es nicht. Prüfe, ob der Link vollständig ist.');
            setMode('invalid-link');
          }
          return;
        }
        if (link?.kind === 'reset') {
          setMode('reset-confirm');
          return;
        }
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
        setSetupTokenRequired(status.setupTokenRequired === true);
        setSession(validated);
        if (validated) localStorage.setItem(sessionStorageKey, JSON.stringify(validated));
        else localStorage.removeItem(sessionStorageKey);
      } catch {
        if (generation.current === current) setMode('unreachable');
      }
    })();
    return () => { generation.current++; controller.abort(); };
  }, [apiUrl, client, workspaceClient, product, sessionStorageKey, checkRun, link]);

  const submit = async (input: AuthScreenCredentials) => {
    const current = ++generation.current;
    try {
      if (mode === 'setup' || mode === 'signup') {
        const result = await workspaceClient.signUp(input.product ?? product, {
          email: input.email,
          password: input.password,
          fullName: input.fullName,
          workspaceName: input.workspaceName || input.fullName,
          ...(input.setupToken ? { setupToken: input.setupToken } : {}),
        });
        if (generation.current === current) await enter(result);
        return;
      }
      const result = await client.loginFor(product, input);
      if (generation.current !== current) return;
      persist({ token: result.token, user: result.user, apiUrl });
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

  const backToLogin = React.useCallback((nextMode: AuthScreenMode) => {
    if (nextMode === 'login' && link) {
      clearLink();
      setLink(null);
      return;
    }
    setNotice('');
    setMode(nextMode);
  }, [link]);

  const loadWorkspaces = React.useCallback(async (current: Session): Promise<RendererWorkspaces | undefined> => {
    const [me, list, appUrls, status] = await Promise.all([
      workspaceClient.me(product, current.token),
      workspaceClient.listWorkspaces(current.token),
      workspaceClient.apps().catch(() => ({})),
      client.getBootstrapStatusFor(product).catch(() => ({ setupTokenRequired: false })),
    ]);
    return {
      currentTenantId: me.tenantId,
      currentUserId: current.user.id,
      list,
      appUrls,
      setupTokenRequired: status.setupTokenRequired === true,
      switchTo: async (tenantId) => {
        const target = list.find((workspace) => workspace.tenantId === tenantId);
        if (target && target.product !== product) {
          const url = (appUrls as Partial<Record<'lite' | 'pro', string>>)[target.product];
          if (url) window.location.assign(url);
          return;
        }
        await enter(await workspaceClient.switchWorkspace(product, current.token, tenantId));
      },
      create: async (input) => {
        await enter(await workspaceClient.createWorkspace(current.token, input));
      },
    };
  }, [client, enter, product, workspaceClient]);

  if (session) return <RendererHost session={session} mount={mount} onLogout={logout} product={product} loadWorkspaces={loadWorkspaces} />;
  return <AuthScreen product={product} mode={mode} serverUrl={apiUrl} defaultServerUrl={defaultApiUrl}
    notice={notice} setupTokenRequired={setupTokenRequired} signupAvailable initialCredentials={initialCredentials}
    invitation={invitation} invalidLinkMessage={invalidLinkMessage}
    onAcceptInvitation={async (input) => {
      const result = await workspaceClient.acceptInvitation(link!.token, input);
      clearLink();
      setLink(null);
      await enter(result);
    }}
    onRequestReset={(email) => workspaceClient.requestPasswordReset(product, email)}
    onConfirmReset={async (password) => {
      await workspaceClient.confirmPasswordReset(link!.token, password);
      clearLink();
    }}
    onModeChange={backToLogin}
    onSubmit={submit} onServerUrlChange={changeServer}
    onRetry={() => { generation.current++; setCheckRun((run) => run + 1); }} />;
}
