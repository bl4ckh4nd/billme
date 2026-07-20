import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { AppState } from 'react-native';
import { File } from 'expo-file-system';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import {
  mobileHomeSchema,
  mobileSessionSchema,
  receiptSchema,
  type MobileHome,
  type MobileSession,
  type ServerProduct,
} from '@billme/server-core';
import { z } from 'zod';
import { cacheGet, cacheSet, clearLocalWorkspace, listOutbox, markOutboxFailure, outboxCount, queueOutbox, removeOutbox } from './storage';

const SESSION_KEY = 'billme.mobile.session.v1';
const normalizeServerUrl = (value: string): string => value.trim().replace(/\/+$/, '');

type StoredSession = MobileSession & { serverUrl: string };
type ReceiptUpload = {
  metadata: { id: string; originalName: string; mimeType: string; sha256: string };
  dataBase64: string;
  sourceUri?: string;
};
type RuntimeContextValue = {
  session: StoredSession | null;
  loading: boolean;
  locked: boolean;
  pendingCount: number;
  message: string;
  login(args: { serverUrl: string; product: ServerProduct; email: string; password: string; deviceName: string; platform: 'ios' | 'android' }): Promise<void>;
  exchangePairing(uri: string, deviceName: string, platform: 'ios' | 'android'): Promise<void>;
  unlock(): Promise<boolean>;
  logout(): Promise<void>;
  request<S extends z.ZodTypeAny>(path: string, schema: S, init?: RequestInit): Promise<z.output<S>>;
  fetchAuthorized(path: string, init?: RequestInit): Promise<Response>;
  loadHome(): Promise<{ data: MobileHome; cached: boolean }>;
  queueReceipt(payload: ReceiptUpload): Promise<void>;
  flushOutbox(): Promise<void>;
};

const RuntimeContext = createContext<RuntimeContextValue | null>(null);

const readStoredSession = async (): Promise<StoredSession | null> => {
  const raw = await SecureStore.getItemAsync(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { serverUrl?: unknown; session?: unknown };
    return typeof parsed.serverUrl === 'string'
      ? { ...mobileSessionSchema.parse(parsed.session), serverUrl: parsed.serverUrl }
      : null;
  } catch {
    await SecureStore.deleteItemAsync(SESSION_KEY);
    return null;
  }
};

const storeSession = async (session: StoredSession | null): Promise<void> => {
  if (!session) return SecureStore.deleteItemAsync(SESSION_KEY);
  const { serverUrl, ...value } = session;
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify({ serverUrl, session: value }));
};

export const RuntimeProvider = ({ children }: PropsWithChildren) => {
  const [session, setSession] = useState<StoredSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [message, setMessage] = useState('');
  const refreshInFlight = useRef<Promise<StoredSession> | null>(null);

  useEffect(() => {
    void (async () => {
      const stored = await readStoredSession();
      setSession(stored);
      if (stored && await LocalAuthentication.hasHardwareAsync() && await LocalAuthentication.isEnrolledAsync()) {
        setLocked(true);
      }
      setPendingCount(await outboxCount());
      setLoading(false);
    })();
  }, []);

  const acceptSession = useCallback(async (next: MobileSession, serverUrl: string) => {
    const stored = { ...next, serverUrl: normalizeServerUrl(serverUrl) };
    await storeSession(stored);
    setSession(stored);
    setLocked(false);
    setMessage('');
  }, []);

  const login = useCallback(async (args: {
    serverUrl: string;
    product: ServerProduct;
    email: string;
    password: string;
    deviceName: string;
    platform: 'ios' | 'android';
  }) => {
    const serverUrl = normalizeServerUrl(args.serverUrl);
    const response = await fetch(`${serverUrl}/api/v1/${args.product}/auth/device-sessions/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.message || `Login failed with ${response.status}`);
    await acceptSession(mobileSessionSchema.parse(payload), serverUrl);
  }, [acceptSession]);

  const exchangePairing = useCallback(async (uri: string, deviceName: string, platform: 'ios' | 'android') => {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'billme:' || parsed.hostname !== 'pair') throw new Error('This is not a Billme pairing code');
    const serverUrl = parsed.searchParams.get('server');
    const product = parsed.searchParams.get('product');
    const code = parsed.searchParams.get('code');
    if (!serverUrl || !code || !['lite', 'pro'].includes(product ?? '')) throw new Error('Pairing code is incomplete');
    const response = await fetch(`${normalizeServerUrl(serverUrl)}/api/v1/${product}/auth/pairing-codes/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, deviceName, platform }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.message || `Pairing failed with ${response.status}`);
    await acceptSession(mobileSessionSchema.parse(payload), serverUrl);
  }, [acceptSession]);

  const refresh = useCallback((current: StoredSession): Promise<StoredSession> => {
    if (refreshInFlight.current) return refreshInFlight.current;
    const pending = (async () => {
      const response = await fetch(`${current.serverUrl}/api/v1/${current.product}/auth/device-sessions/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message || 'Your mobile session has expired');
      const next = { ...mobileSessionSchema.parse(payload), serverUrl: current.serverUrl };
      await storeSession(next);
      setSession(next);
      return next;
    })();
    refreshInFlight.current = pending;
    const clear = () => { if (refreshInFlight.current === pending) refreshInFlight.current = null; };
    void pending.then(clear, clear);
    return pending;
  }, []);

  const fetchAuthorized = useCallback(async (path: string, init?: RequestInit): Promise<Response> => {
    if (!session) throw new Error('Sign in first');
    let active = session;
    if (new Date(active.accessTokenExpiresAt).getTime() <= Date.now() + 30_000) active = await refresh(active);
    const execute = (token: string) => fetch(`${active.serverUrl}/api/v1/${active.product}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
    let response = await execute(active.accessToken);
    if (response.status === 401) {
      active = await refresh(active);
      response = await execute(active.accessToken);
    }
    return response;
  }, [refresh, session]);

  const request = useCallback(async <S extends z.ZodTypeAny>(path: string, schema: S, init?: RequestInit): Promise<z.output<S>> => {
    const response = await fetchAuthorized(path, init);
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.message || `Request failed with ${response.status}`);
    return schema.parse(payload);
  }, [fetchAuthorized]);

  const flushOutbox = useCallback(async () => {
    if (!session) return;
    for (const item of await listOutbox()) {
      try {
        if (item.kind === 'receipt') {
          await request('/receipts', receiptSchema, { method: 'POST', body: JSON.stringify(item.payload) });
        }
        await removeOutbox(item.id);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await markOutboxFailure(item.id, detail);
        setMessage(`Upload paused: ${detail}`);
        break;
      }
    }
    setPendingCount(await outboxCount());
  }, [request, session]);

  useEffect(() => {
    if (!session) return;
    void flushOutbox();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void flushOutbox();
    });
    return () => subscription.remove();
  }, [flushOutbox, session]);

  const loadHome = useCallback(async () => {
    try {
      const data = await request('/mobile/home', mobileHomeSchema);
      await cacheSet(`home:${session?.tenantId}:${session?.product}`, data);
      return { data, cached: false };
    } catch (error) {
      const cached = await cacheGet<MobileHome>(`home:${session?.tenantId}:${session?.product}`);
      if (!cached) throw error;
      return { data: mobileHomeSchema.parse(cached), cached: true };
    }
  }, [request, session]);

  const queueReceipt = useCallback(async (payload: ReceiptUpload) => {
    const { sourceUri, ...encryptedPayload } = payload;
    await queueOutbox(payload.metadata.id, 'receipt', encryptedPayload);
    if (sourceUri) {
      try { new File(sourceUri).delete(); } catch { /* The picker may already have cleared its cache. */ }
    }
    setPendingCount(await outboxCount());
    await flushOutbox();
  }, [flushOutbox]);

  const unlock = useCallback(async () => {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Unlock Billme',
      cancelLabel: 'Sign out',
      biometricsSecurityLevel: 'strong',
    });
    setLocked(!result.success);
    return result.success;
  }, []);

  const logout = useCallback(async () => {
    if (session) {
      try {
        await fetchAuthorized(`/auth/device-sessions/${session.device.id}`, { method: 'DELETE' });
      } catch {
        // Local sign-out must still succeed if the server is unavailable.
      }
    }
    await storeSession(null);
    await clearLocalWorkspace();
    setSession(null);
    setLocked(false);
    setPendingCount(0);
  }, [fetchAuthorized, session]);

  const value = useMemo<RuntimeContextValue>(() => ({
    session, loading, locked, pendingCount, message, login, exchangePairing, unlock, logout, request, loadHome,
    queueReceipt, flushOutbox, fetchAuthorized,
  }), [session, loading, locked, pendingCount, message, login, exchangePairing, unlock, logout, request, loadHome, queueReceipt, flushOutbox, fetchAuthorized]);

  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
};

export const useRuntime = (): RuntimeContextValue => {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error('useRuntime must be used inside RuntimeProvider');
  return value;
};
