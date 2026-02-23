import { ipcRoutes, type IpcArgs, type IpcResult, type IpcRouteKey } from '../../desktop/ipc/contract';
import { createMockInvoke } from '../../desktop/ipc/mockEngine';

type Env = {
  ASSETS: Fetcher;
  DEMO_SESSIONS: DurableObjectNamespace;
};

type SessionError = { error: string };

type SessionSuccess = { data: unknown };

const json = (payload: SessionError | SessionSuccess, status = 200): Response => {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
};

const parseCookie = (cookieHeader: string | null, key: string): string | null => {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k !== key) continue;
    const rawValue = v.join('=');
    try {
      const decoded = decodeURIComponent(rawValue);
      return decoded.length > 0 ? decoded : null;
    } catch {
      return rawValue.length > 0 ? rawValue : null;
    }
  }
  return null;
};

const secureCookie = (request: Request): boolean => {
  const url = new URL(request.url);
  return url.protocol === 'https:';
};

const setSecurityHeaders = (headers: Headers): void => {
  headers.set('content-security-policy', 'upgrade-insecure-requests');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
};

const needsHtmlRewrite = (response: Response): boolean => {
  const type = response.headers.get('content-type') ?? '';
  return type.toLowerCase().includes('text/html');
};

const rewriteInsecureOriginInHtml = (html: string, host: string): string => {
  const escapedHost = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const originPattern = new RegExp(`http://${escapedHost}`, 'gi');
  return html.replace(originPattern, `https://${host}`);
};

export class DemoSession {
  private invoke = createMockInvoke();

  constructor(_state: DurableObjectState, _env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/reset') {
      this.invoke = createMockInvoke();
      return json({ data: { ok: true } });
    }

    if (request.method === 'POST' && url.pathname.startsWith('/ipc/')) {
      const key = decodeURIComponent(url.pathname.slice('/ipc/'.length)) as IpcRouteKey;
      if (!(key in ipcRoutes)) {
        return json({ error: `Unknown IPC route: ${key}` }, 404);
      }

      const route = ipcRoutes[key];
      const payload = (await request.json().catch(() => ({}))) as { args?: unknown };

      try {
        const parsedArgs = route.args.parse(payload.args) as IpcArgs<typeof key>;
        const rawResult = await this.invoke(key, parsedArgs);
        const result = route.result.parse(rawResult) as IpcResult<typeof key>;
        return json({ data: result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json({ error: message }, 400);
      }
    }

    return json({ error: 'Not found' }, 404);
  }
}

const finalizeResponse = async (
  request: Request,
  response: Response,
  sessionId: string,
): Promise<Response> => {
  const requestUrl = new URL(request.url);
  let body: BodyInit | null = response.body;
  const headers = new Headers(response.headers);

  if (needsHtmlRewrite(response)) {
    const html = await response.text();
    body = rewriteInsecureOriginInHtml(html, requestUrl.host);
  }

  setSecurityHeaders(headers);
  headers.append(
    'set-cookie',
    `demo_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secureCookie(request) ? '; Secure' : ''}`,
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const sessionId =
      parseCookie(request.headers.get('cookie'), 'demo_session') ??
      (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2));

    if (url.pathname.startsWith('/api/')) {
      const id = env.DEMO_SESSIONS.idFromName(sessionId);
      const stub = env.DEMO_SESSIONS.get(id);

      if (url.pathname.startsWith('/api/ipc/')) {
        const path = url.pathname.slice('/api'.length);
        const target = new Request(`https://session${path}`, {
          method: 'POST',
          headers: request.headers,
          body: request.body,
        });
        const res = await stub.fetch(target);
        return finalizeResponse(request, res, sessionId);
      }

      if (url.pathname === '/api/session/reset') {
        const res = await stub.fetch('https://session/reset', { method: 'POST' });
        return finalizeResponse(request, res, sessionId);
      }

      if (url.pathname === '/api/health') {
        return finalizeResponse(
          request,
          json({ data: { ok: true, ts: new Date().toISOString() } }),
          sessionId,
        );
      }

      return finalizeResponse(request, json({ error: 'Not found' }, 404), sessionId);
    }

    const assetResponse = await env.ASSETS.fetch(request);
    return finalizeResponse(request, assetResponse, sessionId);
  },
};
