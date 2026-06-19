import React from 'react';

export type BrowserShellProduct = 'lite' | 'pro';

export type StoredBrowserSession<TUser> = {
  token: string;
  user: TUser;
};

export type BrowserAuthCredentials = {
  email: string;
  password: string;
  fullName: string;
};

export type BrowserShellAuthAdapter<TUser> = {
  getHealthLabel: () => Promise<string>;
  getRoles: () => Promise<string[]>;
  getBootstrapReady: () => Promise<boolean>;
  validateSession: (token: string) => Promise<TUser | null>;
  login: (credentials: BrowserAuthCredentials) => Promise<StoredBrowserSession<TUser>>;
  bootstrap: (credentials: BrowserAuthCredentials) => Promise<StoredBrowserSession<TUser>>;
};

export type BrowserShellApiFactory<TApi> = (options: {
  baseUrl: string;
  token: string;
  onAuthFailure: () => void;
  onRequestClose: () => void;
}) => TApi;

export type BrowserDocumentShellConfig<TApi, TUser> = {
  product: BrowserShellProduct;
  sessionStorageKey: string;
  apiUrlStorageKey?: string;
  defaultApiPort?: number;
  initialHealth: string;
  signedOutMessage: string;
  persistApiUrlOnAuth?: boolean;
  createAuthAdapter: (apiUrl: string) => BrowserShellAuthAdapter<TUser>;
  createApi: BrowserShellApiFactory<TApi>;
  parseStoredUser: (value: unknown) => TUser;
};

export type BrowserDocumentShellState<TApi, TUser> = {
  apiUrl: string;
  setApiUrl: React.Dispatch<React.SetStateAction<string>>;
  health: string;
  roles: string[];
  bootstrapReady: boolean;
  loadingSession: boolean;
  session: StoredBrowserSession<TUser> | null;
  message: string;
  isPrintMode: boolean;
  printApi: TApi | null;
  logout: () => void;
  login: (credentials: BrowserAuthCredentials) => Promise<void>;
  bootstrap: (credentials: BrowserAuthCredentials) => Promise<void>;
  createWorkspaceApi: (session: StoredBrowserSession<TUser>) => TApi;
};

type BrowserRuntimeConfigWindow = Window & {
  billmeRuntimeConfig?: {
    serverApiUrl?: string;
  };
};

type StoredSessionShape = {
  token?: unknown;
  user?: unknown;
};

const DEFAULT_API_PORT = 3100;

const normalizeApiUrl = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const getBrowserDefaultApiUrl = (defaultApiPort = DEFAULT_API_PORT): string => {
  if (typeof window === 'undefined') {
    return `http://127.0.0.1:${defaultApiPort}`;
  }
  const hostname = window.location.hostname || '127.0.0.1';
  return `http://${hostname}:${defaultApiPort}`;
};

const getRuntimeApiUrl = (): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  return normalizeApiUrl((window as BrowserRuntimeConfigWindow).billmeRuntimeConfig?.serverApiUrl);
};

const readStoredApiUrl = (key: string | undefined): string | null => {
  if (typeof window === 'undefined' || !key) {
    return null;
  }
  return normalizeApiUrl(window.localStorage.getItem(key));
};

export const getInitialBrowserApiUrl = (options: {
  apiUrlStorageKey?: string;
  defaultApiPort?: number;
} = {}): string =>
  getRuntimeApiUrl()
  ?? readStoredApiUrl(options.apiUrlStorageKey)
  ?? getBrowserDefaultApiUrl(options.defaultApiPort);

const readStoredSession = <TUser,>(
  key: string,
  parseStoredUser: (value: unknown) => TUser,
): StoredBrowserSession<TUser> | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as StoredSessionShape;
    if (typeof parsed.token !== 'string') {
      window.localStorage.removeItem(key);
      return null;
    }
    return {
      token: parsed.token,
      user: parseStoredUser(parsed.user),
    };
  } catch {
    window.localStorage.removeItem(key);
    return null;
  }
};

const writeStoredSession = <TUser,>(key: string, session: StoredBrowserSession<TUser> | null): void => {
  if (typeof window === 'undefined') {
    return;
  }
  if (!session) {
    window.localStorage.removeItem(key);
    return;
  }
  window.localStorage.setItem(key, JSON.stringify(session));
};

const writeStoredApiUrl = (key: string | undefined, apiUrl: string): void => {
  if (typeof window === 'undefined' || !key) {
    return;
  }
  window.localStorage.setItem(key, apiUrl);
};

export const usePdfAutoPrint = (enabled: boolean): void => {
  React.useEffect(() => {
    if (!enabled) {
      return undefined;
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
  }, [enabled]);
};

export const useBrowserDocumentShell = <TApi, TUser,>(
  config: BrowserDocumentShellConfig<TApi, TUser>,
): BrowserDocumentShellState<TApi, TUser> => {
  const [apiUrl, setApiUrl] = React.useState(() =>
    getInitialBrowserApiUrl({
      apiUrlStorageKey: config.apiUrlStorageKey,
      defaultApiPort: config.defaultApiPort,
    }),
  );
  const searchParams = React.useMemo(() => new URLSearchParams(window.location.search), []);
  const isPrintMode = searchParams.get('__print') === '1';
  const storedPrintSession = React.useMemo(
    () => readStoredSession(config.sessionStorageKey, config.parseStoredUser),
    [config.parseStoredUser, config.sessionStorageKey],
  );
  const auth = React.useMemo(() => config.createAuthAdapter(apiUrl), [apiUrl, config]);
  const [health, setHealth] = React.useState(config.initialHealth);
  const [roles, setRoles] = React.useState<string[]>([]);
  const [bootstrapReady, setBootstrapReady] = React.useState(false);
  const [loadingSession, setLoadingSession] = React.useState(true);
  const [session, setSession] = React.useState<StoredBrowserSession<TUser> | null>(null);
  const [message, setMessage] = React.useState('');

  const logout = React.useCallback(() => {
    writeStoredSession(config.sessionStorageKey, null);
    setSession(null);
    setMessage(config.signedOutMessage);
  }, [config.sessionStorageKey, config.signedOutMessage]);

  const createWorkspaceApi = React.useCallback(
    (nextSession: StoredBrowserSession<TUser>) =>
      config.createApi({
        baseUrl: apiUrl,
        token: nextSession.token,
        onAuthFailure: logout,
        onRequestClose: logout,
      }),
    [apiUrl, config, logout],
  );

  const finishAuth = React.useCallback(
    (nextSession: StoredBrowserSession<TUser>) => {
      if (config.persistApiUrlOnAuth) {
        writeStoredApiUrl(config.apiUrlStorageKey, apiUrl);
      }
      writeStoredSession(config.sessionStorageKey, nextSession);
      setSession(nextSession);
      setBootstrapReady(false);
      setMessage('');
    },
    [apiUrl, config.apiUrlStorageKey, config.persistApiUrlOnAuth, config.sessionStorageKey],
  );

  React.useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const storedSession = readStoredSession(config.sessionStorageKey, config.parseStoredUser);
        const [nextHealth, nextRoles, nextBootstrapReady, validatedUser] = await Promise.all([
          auth.getHealthLabel(),
          auth.getRoles(),
          auth.getBootstrapReady(),
          storedSession ? auth.validateSession(storedSession.token).catch(() => null) : Promise.resolve(null),
        ]);

        if (cancelled) {
          return;
        }

        setHealth(nextHealth);
        setRoles(nextRoles);
        setBootstrapReady(nextBootstrapReady);

        if (storedSession && validatedUser) {
          setSession({ token: storedSession.token, user: validatedUser });
        } else if (storedSession) {
          writeStoredSession(config.sessionStorageKey, null);
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
  }, [auth, config.parseStoredUser, config.sessionStorageKey]);

  const login = React.useCallback(
    async (credentials: BrowserAuthCredentials) => {
      try {
        finishAuth(await auth.login(credentials));
      } catch (error: unknown) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [auth, finishAuth],
  );

  const bootstrap = React.useCallback(
    async (credentials: BrowserAuthCredentials) => {
      try {
        finishAuth(await auth.bootstrap(credentials));
      } catch (error: unknown) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    },
    [auth, finishAuth],
  );

  const printApi = React.useMemo(
    () => (storedPrintSession ? createWorkspaceApi(storedPrintSession) : null),
    [createWorkspaceApi, storedPrintSession],
  );

  return {
    apiUrl,
    setApiUrl,
    health,
    roles,
    bootstrapReady,
    loadingSession,
    session,
    message,
    isPrintMode,
    printApi,
    logout,
    login,
    bootstrap,
    createWorkspaceApi,
  };
};
