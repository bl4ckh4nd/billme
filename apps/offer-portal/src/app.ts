import crypto from 'crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { OfferStore, PdfStore, PortalDocumentListItem } from './storage/types';
import { BILLME_FULL_LOGO_DATA_URI } from './branding';

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const nowIso = () => new Date().toISOString();

const escapeHtml = (s: string) =>
  String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const formatCurrencyEur = (amount: unknown) => {
  const n = typeof amount === 'number' ? amount : Number(amount);
  const safe = Number.isFinite(n) ? n : 0;
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(safe);
};

const looksLikeDocSnapshot = (
  snap: unknown,
): snap is {
  number?: string;
  client?: string;
  clientId?: string;
  clientEmail?: string;
  date?: string;
  dueDate?: string;
  amount?: number;
  status?: string;
  items?: Array<{ description?: string; quantity?: number; total?: number }>;
} => typeof snap === 'object' && snap !== null;

export const publishJsonSchema = z.object({
  token: z.string().min(16),
  snapshot: z.unknown(),
  expiresAt: z.string().optional(),
  customerRef: z.string().min(1).optional(),
  customerLabel: z.string().optional(),
});

const customerAccessLinkSchema = z.object({
  customerRef: z.string().min(1),
  customerLabel: z.string().optional(),
  expiresInDays: z.coerce.number().int().positive().max(365).optional(),
});

const historyQuerySchema = z.object({
  kind: z.enum(['offer', 'invoice', 'all']).default('all'),
  limit: z.coerce.number().int().positive().max(200).default(50),
  cursor: z.string().optional(),
});

export const decisionSchema = z.object({
  decision: z.enum(['accepted', 'declined']),
  acceptedName: z.string().min(1),
  acceptedEmail: z.string().min(1),
  decisionTextVersion: z.string().min(1),
});

export type PortalConfig = {
  publishApiKey?: string;
  publicBaseUrl?: string;
  requirePublishApiKey?: boolean;
};

const inferCustomerRef = (snapshot: unknown, fallbackToken: string): string => {
  if (typeof snapshot !== 'object' || snapshot === null) return `anon:${sha256(fallbackToken).slice(0, 16)}`;
  const maybeClientId = (snapshot as Record<string, unknown>).clientId;
  if (typeof maybeClientId === 'string' && maybeClientId.trim()) return `client:${maybeClientId.trim()}`;
  const maybeEmail = (snapshot as Record<string, unknown>).clientEmail;
  if (typeof maybeEmail === 'string' && maybeEmail.trim()) {
    return `email:${sha256(maybeEmail.trim().toLowerCase())}`;
  }
  return `anon:${sha256(fallbackToken).slice(0, 16)}`;
};

const inferCustomerLabel = (snapshot: unknown): string | null => {
  if (typeof snapshot !== 'object' || snapshot === null) return null;
  const value = (snapshot as Record<string, unknown>).client;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

const normalizeDocStatus = (item: PortalDocumentListItem) => {
  const expired = Date.parse(item.expiresAt) < Date.now();
  if (item.kind === 'offer') {
    if (expired) return 'Abgelaufen';
    if (item.decision?.decision === 'accepted') return 'Angenommen';
    if (item.decision?.decision === 'declined') return 'Abgelehnt';
    return 'Offen';
  }
  const snap = looksLikeDocSnapshot(item.snapshotJson) ? item.snapshotJson : null;
  return snap?.status ? String(snap.status) : expired ? 'Abgelaufen' : 'Offen';
};

type RateBucketState = {
  count: number;
  resetAt: number;
};

const RATE_LIMITS = {
  tokenRead: { windowMs: 60_000, max: 180 },
  tokenDecision: { windowMs: 60_000, max: 30 },
} as const;

const rateBuckets = new Map<string, RateBucketState>();
const MAX_RATE_BUCKETS = 5_000;

const getClientIdentifier = (c: any): string => {
  const cfIp = c.req.header('cf-connecting-ip');
  if (cfIp) return String(cfIp);
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() || 'unknown';
  return 'unknown';
};

const checkRateLimit = (
  c: any,
  bucket: keyof typeof RATE_LIMITS,
): { ok: true } | { ok: false; retryAfterSec: number } => {
  const cfg = RATE_LIMITS[bucket];
  const now = Date.now();
  for (const [k, state] of rateBuckets) {
    if (state.resetAt <= now) rateBuckets.delete(k);
  }
  if (rateBuckets.size > MAX_RATE_BUCKETS) {
    let oldestKey: string | null = null;
    let oldestResetAt = Number.POSITIVE_INFINITY;
    for (const [k, state] of rateBuckets) {
      if (state.resetAt < oldestResetAt) {
        oldestResetAt = state.resetAt;
        oldestKey = k;
      }
    }
    if (oldestKey) rateBuckets.delete(oldestKey);
  }
  const key = `${bucket}:${getClientIdentifier(c)}`;
  const existing = rateBuckets.get(key);

  if (!existing || existing.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + cfg.windowMs });
    return { ok: true };
  }

  if (existing.count >= cfg.max) {
    const retryAfterSec = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    return { ok: false, retryAfterSec };
  }

  existing.count += 1;
  rateBuckets.set(key, existing);
  return { ok: true };
};

const applySensitiveResponseHeaders = (
  c: any,
  options?: {
    allowFrameFromSameOrigin?: boolean;
  },
) => {
  c.header('Cache-Control', 'no-store, max-age=0');
  c.header('Pragma', 'no-cache');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', options?.allowFrameFromSameOrigin ? 'SAMEORIGIN' : 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
};

const parseCookies = (header: string | null | undefined): Record<string, string> => {
  if (!header) return {};
  return header.split(';').reduce<Record<string, string>>((acc, part) => {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (!rawKey) return acc;
    try {
      acc[rawKey] = decodeURIComponent(rawValue.join('=') ?? '');
    } catch {
      acc[rawKey] = rawValue.join('=') ?? '';
    }
    return acc;
  }, {});
};

const renderPortalBranding = (subtitle: string) => `<div style="display:flex; align-items:center; gap:12px; margin-bottom: 16px;">
  <img src="${BILLME_FULL_LOGO_DATA_URI}" alt="Billme" style="height: 28px; width: auto;" />
  <div style="font-size:12px; font-weight:800; letter-spacing:.08em; color:#666; text-transform:uppercase;">${subtitle}</div>
</div>`;

const checkPublishAuth = (
  config: PortalConfig,
  c: any,
): { ok: boolean; status?: 401 | 503; error?: 'unauthorized' | 'publish_api_key_required' } => {
  const publishApiKey = config.publishApiKey?.trim();
  if (config.requirePublishApiKey && !publishApiKey) {
    return {
      ok: false,
      status: 503,
      error: 'publish_api_key_required',
    };
  }

  if (!publishApiKey) return { ok: true };

  const header = c.req.header('x-api-key');
  if (header && header === publishApiKey) return { ok: true };

  return { ok: false, status: 401, error: 'unauthorized' };
};

export const createApp = (deps: { store: OfferStore; pdf: PdfStore; config: PortalConfig }) => {
  const app = new Hono();
  const publicOrigin = (() => {
    const base = deps.config.publicBaseUrl?.trim();
    if (!base) return null;
    try {
      return new URL(base).origin;
    } catch {
      return null;
    }
  })();
  const isAllowedDecisionOrigin = (c: any): boolean => {
    if (!publicOrigin) return true;
    const origin = c.req.header('origin');
    if (origin && origin === publicOrigin) return true;
    const referer = c.req.header('referer');
    if (!referer) return false;
    try {
      return new URL(referer).origin === publicOrigin;
    } catch {
      return false;
    }
  };

  app.get('/health', (c) => c.json({ ok: true, ts: nowIso() }));

  app.get('/admin/setup', (c) => {
    const baseUrl = deps.config.publicBaseUrl ?? '(unset)';
    const hasKey = Boolean(deps.config.publishApiKey);
    const strictAuth = Boolean(deps.config.requirePublishApiKey);
    const authHealth = strictAuth && !hasKey ? 'misconfigured (strict=true, key missing)' : hasKey ? 'enabled' : 'disabled';
    const html = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Offer Portal Setup</title></head>
  <body style="font-family: system-ui; max-width: 720px; margin: 40px auto; padding: 0 16px;">
    ${renderPortalBranding('Offer Portal')}
    <h1>Setup</h1>
    <p>This portal supports self-hosting (Node) and Cloudflare Workers.</p>
    <ul>
      <li><strong>PUBLIC_BASE_URL</strong>: ${baseUrl}</li>
      <li><strong>PUBLISH_API_KEY</strong>: ${hasKey ? 'set' : 'not set'}</li>
      <li><strong>STRICT_PUBLISH_AUTH</strong>: ${strictAuth ? 'enabled' : 'disabled'}</li>
      <li><strong>Publish Auth Status</strong>: ${authHealth}</li>
    </ul>
    <h2>Next steps</h2>
    <ol>
      <li>Set <code>PUBLIC_BASE_URL</code> to your custom domain (e.g. https://offers.example.com).</li>
      <li>Set <code>PUBLISH_API_KEY</code> and configure the desktop app to use it.</li>
      <li>Verify: <code>GET /health</code></li>
    </ol>
  </body>
</html>`;
    return c.html(html);
  });

  app.post('/customers/access-links', async (c) => {
    const auth = checkPublishAuth(deps.config, c);
    if (!auth.ok) {
      c.header('WWW-Authenticate', 'ApiKey realm="publish"');
      return c.json({ error: auth.error ?? 'unauthorized' }, auth.status ?? 401);
    }
    const body = customerAccessLinkSchema.parse(await c.req.json());
    const token = crypto.randomBytes(24).toString('base64url');
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + (body.expiresInDays ?? 90) * 24 * 60 * 60 * 1000).toISOString();
    await deps.store.createCustomerAccessToken({
      tokenHash: sha256(token),
      customerRef: body.customerRef,
      customerLabel: body.customerLabel ?? null,
      createdAt,
      expiresAt,
      revokedAt: null,
    });
    const base = deps.config.publicBaseUrl?.replace(/\/+$/, '');
    return c.json({
      ok: true,
      token,
      publicUrl: `${base ?? ''}/customers/${token}`,
      expiresAt,
    });
  });

  app.post('/customers/access-links/rotate', async (c) => {
    const auth = checkPublishAuth(deps.config, c);
    if (!auth.ok) {
      c.header('WWW-Authenticate', 'ApiKey realm="publish"');
      return c.json({ error: auth.error ?? 'unauthorized' }, auth.status ?? 401);
    }
    const body = customerAccessLinkSchema.parse(await c.req.json());
    await deps.store.revokeCustomerAccessTokens(body.customerRef);
    const token = crypto.randomBytes(24).toString('base64url');
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + (body.expiresInDays ?? 90) * 24 * 60 * 60 * 1000).toISOString();
    await deps.store.createCustomerAccessToken({
      tokenHash: sha256(token),
      customerRef: body.customerRef,
      customerLabel: body.customerLabel ?? null,
      createdAt,
      expiresAt,
      revokedAt: null,
    });
    const base = deps.config.publicBaseUrl?.replace(/\/+$/, '');
    return c.json({
      ok: true,
      token,
      publicUrl: `${base ?? ''}/customers/${token}`,
      expiresAt,
    });
  });

  app.post('/offers', async (c) => {
    const auth = checkPublishAuth(deps.config, c);
    if (!auth.ok) {
      c.header('WWW-Authenticate', 'ApiKey realm="publish"');
      return c.json({ error: auth.error ?? 'unauthorized' }, auth.status ?? 401);
    }
    const contentType = c.req.header('content-type') ?? '';
    const publishedAt = nowIso();
    const defaultExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    if (contentType.includes('application/json')) {
      const body = publishJsonSchema.parse(await c.req.json());
      const tokenHash = sha256(body.token);
      await deps.store.upsertOffer({
        tokenHash,
        publishedAt,
        expiresAt: body.expiresAt ?? defaultExpiresAt,
        snapshotJson: body.snapshot,
        customerRef: body.customerRef ?? inferCustomerRef(body.snapshot, body.token),
        customerLabel: body.customerLabel ?? inferCustomerLabel(body.snapshot),
        pdfKey: null,
        decision: null,
      });
      return c.json({ ok: true });
    }

    if (contentType.includes('multipart/form-data')) {
      const form = await c.req.formData();
      const token = String(form.get('token') ?? '');
      const snapshotRaw = String(form.get('snapshot') ?? 'null');
      const snapshot = JSON.parse(snapshotRaw);
      const expiresAtFromForm = String(form.get('expiresAt') ?? '').trim();
      const customerRefRaw = String(form.get('customerRef') ?? '').trim();
      const customerLabelRaw = String(form.get('customerLabel') ?? '').trim();

      if (!token || token.length < 16) return c.json({ error: 'token required' }, 400);

      const pdfFile = form.get('pdf');
      const pdfKey = pdfFile && typeof pdfFile !== 'string' ? `offer-${Date.now()}-${tokenHashPrefix(token)}.pdf` : null;
      if (pdfKey && pdfFile && typeof pdfFile !== 'string') {
        const buf = new Uint8Array(await pdfFile.arrayBuffer());
        await deps.pdf.putPdf(pdfKey, buf);
      }

      const tokenHash = sha256(token);
      await deps.store.upsertOffer({
        tokenHash,
        publishedAt,
        expiresAt: expiresAtFromForm || defaultExpiresAt,
        snapshotJson: snapshot,
        customerRef: customerRefRaw || inferCustomerRef(snapshot, token),
        customerLabel: customerLabelRaw || inferCustomerLabel(snapshot),
        pdfKey,
        decision: null,
      });
      return c.json({ ok: true });
    }

    return c.json({ error: 'unsupported content-type' }, 415);
  });

  app.post('/invoices', async (c) => {
    const auth = checkPublishAuth(deps.config, c);
    if (!auth.ok) {
      c.header('WWW-Authenticate', 'ApiKey realm="publish"');
      return c.json({ error: auth.error ?? 'unauthorized' }, auth.status ?? 401);
    }
    const contentType = c.req.header('content-type') ?? '';
    const publishedAt = nowIso();
    const defaultExpiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

    if (contentType.includes('application/json')) {
      const body = publishJsonSchema.parse(await c.req.json());
      const tokenHash = sha256(body.token);
      await deps.store.upsertInvoice({
        tokenHash,
        publishedAt,
        expiresAt: body.expiresAt ?? defaultExpiresAt,
        snapshotJson: body.snapshot,
        customerRef: body.customerRef ?? inferCustomerRef(body.snapshot, body.token),
        customerLabel: body.customerLabel ?? inferCustomerLabel(body.snapshot),
        pdfKey: null,
      });
      return c.json({ ok: true });
    }

    if (contentType.includes('multipart/form-data')) {
      const form = await c.req.formData();
      const token = String(form.get('token') ?? '');
      const snapshotRaw = String(form.get('snapshot') ?? 'null');
      const snapshot = JSON.parse(snapshotRaw);
      const expiresAtFromForm = String(form.get('expiresAt') ?? '').trim();
      const customerRefRaw = String(form.get('customerRef') ?? '').trim();
      const customerLabelRaw = String(form.get('customerLabel') ?? '').trim();

      if (!token || token.length < 16) return c.json({ error: 'token required' }, 400);
      const customerRef = customerRefRaw || inferCustomerRef(snapshot, token);
      if (!customerRef) return c.json({ error: 'customerRef required' }, 400);

      const pdfFile = form.get('pdf');
      const pdfKey = pdfFile && typeof pdfFile !== 'string' ? `invoice-${Date.now()}-${tokenHashPrefix(token)}.pdf` : null;
      if (pdfKey && pdfFile && typeof pdfFile !== 'string') {
        const buf = new Uint8Array(await pdfFile.arrayBuffer());
        await deps.pdf.putPdf(pdfKey, buf);
      }

      await deps.store.upsertInvoice({
        tokenHash: sha256(token),
        publishedAt,
        expiresAt: expiresAtFromForm || defaultExpiresAt,
        snapshotJson: snapshot,
        customerRef,
        customerLabel: customerLabelRaw || inferCustomerLabel(snapshot),
        pdfKey,
      });
      return c.json({ ok: true });
    }

    return c.json({ error: 'unsupported content-type' }, 415);
  });

  app.get('/customers/:token/documents', async (c) => {
    applySensitiveResponseHeaders(c);
    const rl = checkRateLimit(c, 'tokenRead');
    if (!rl.ok) {
      c.header('Retry-After', String(rl.retryAfterSec));
      return c.json({ error: 'rate_limited' }, 429);
    }
    const token = z.object({ token: z.string().min(16) }).parse(c.req.param()).token;
    const access = await deps.store.getCustomerAccessByTokenHash(sha256(token));
    if (!access) return c.json({ error: 'not found' }, 404);
    if (access.revokedAt) return c.json({ error: 'revoked' }, 403);
    if (Date.parse(access.expiresAt) < Date.now()) return c.json({ error: 'expired' }, 410);

    const query = historyQuerySchema.parse(c.req.query());
    const result = await deps.store.listDocumentsByCustomerRef({
      customerRef: access.customerRef,
      kind: query.kind,
      limit: query.limit,
      cursor: query.cursor,
    });

    const items = result.items.map((item) => {
      const snap = looksLikeDocSnapshot(item.snapshotJson) ? item.snapshotJson : null;
      return {
        kind: item.kind,
        number: snap?.number ?? '',
        client: snap?.client ?? access.customerLabel ?? '',
        date: snap?.date ?? '',
        dueDate: snap?.dueDate ?? '',
        amount: snap?.amount ?? 0,
        status: normalizeDocStatus(item),
        hasPdf: Boolean(item.pdfKey),
        publishedAt: item.publishedAt,
        expiresAt: item.expiresAt,
        url: `/d/${encodeURIComponent(item.documentId)}`,
      };
    });
    return c.json({ ok: true, items, nextCursor: result.nextCursor });
  });

  app.get('/customers/:token', async (c) => {
    applySensitiveResponseHeaders(c);
    const rl = checkRateLimit(c, 'tokenRead');
    if (!rl.ok) {
      c.header('Retry-After', String(rl.retryAfterSec));
      return c.text('Zu viele Anfragen. Bitte später erneut versuchen.', 429);
    }
    const token = z.object({ token: z.string().min(16) }).parse(c.req.param()).token;
    const access = await deps.store.getCustomerAccessByTokenHash(sha256(token));
    if (!access) return c.json({ error: 'not found' }, 404);
    if (access.revokedAt) return c.text('Link ist nicht mehr gueltig.', 403);
    if (Date.parse(access.expiresAt) < Date.now()) return c.text('Link ist abgelaufen.', 410);

    const query = historyQuerySchema.parse(c.req.query());
    const result = await deps.store.listDocumentsByCustomerRef({
      customerRef: access.customerRef,
      kind: query.kind,
      limit: query.limit,
      cursor: query.cursor,
    });

    const rows = result.items
      .map((item) => {
        const snap = looksLikeDocSnapshot(item.snapshotJson) ? item.snapshotJson : null;
        const url = `/d/${encodeURIComponent(item.documentId)}`;
        return `<tr>
<td style="padding:10px 8px; border-bottom:1px solid #eee;">${item.kind === 'offer' ? 'Angebot' : 'Rechnung'}</td>
<td style="padding:10px 8px; border-bottom:1px solid #eee;">${escapeHtml(snap?.number ?? '')}</td>
<td style="padding:10px 8px; border-bottom:1px solid #eee;">${escapeHtml(snap?.date ?? '')}</td>
<td style="padding:10px 8px; border-bottom:1px solid #eee; text-align:right;">${escapeHtml(formatCurrencyEur(snap?.amount ?? 0))}</td>
<td style="padding:10px 8px; border-bottom:1px solid #eee;">${escapeHtml(normalizeDocStatus(item))}</td>
<td style="padding:10px 8px; border-bottom:1px solid #eee;"><a href="${escapeHtml(url)}">Ansehen</a></td>
</tr>`;
      })
      .join('\n');

    const nextLink = result.nextCursor
      ? `<a href="/customers/${encodeURIComponent(token)}?kind=${encodeURIComponent(query.kind)}&limit=${query.limit}&cursor=${encodeURIComponent(result.nextCursor)}">Weitere laden</a>`
      : '';

    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'" />
    <title>Dokumente</title>
  </head>
  <body style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background:#f3f4f6; margin:0;">
    <main style="max-width: 980px; margin: 32px auto; padding: 0 16px;">
      ${renderPortalBranding('Kundenportal')}
      <h1 style="margin:0 0 6px;">Bisherige Dokumente</h1>
      <div style="color:#666; margin-bottom: 16px;">${escapeHtml(access.customerLabel ?? access.customerRef)}</div>
      <section style="background:#fff; border:1px solid #e5e7eb; border-radius:16px; padding: 8px 14px;">
        <table style="width:100%; border-collapse:collapse;">
          <thead>
            <tr>
              <th style="text-align:left; padding:10px 8px; border-bottom:1px solid #eee;">Typ</th>
              <th style="text-align:left; padding:10px 8px; border-bottom:1px solid #eee;">Nummer</th>
              <th style="text-align:left; padding:10px 8px; border-bottom:1px solid #eee;">Datum</th>
              <th style="text-align:right; padding:10px 8px; border-bottom:1px solid #eee;">Betrag</th>
              <th style="text-align:left; padding:10px 8px; border-bottom:1px solid #eee;">Status</th>
              <th style="text-align:left; padding:10px 8px; border-bottom:1px solid #eee;">Link</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="6" style="padding:12px; color:#666;">Keine Dokumente vorhanden.</td></tr>'}</tbody>
        </table>
      </section>
      <div style="margin-top:12px;">${nextLink}</div>
    </main>
  </body>
</html>`;
    return c.html(html);
  });

  app.get('/d/:documentId', async (c) => {
    applySensitiveResponseHeaders(c);
    const rl = checkRateLimit(c, 'tokenRead');
    if (!rl.ok) {
      c.header('Retry-After', String(rl.retryAfterSec));
      return c.json({ error: 'rate_limited' }, 429);
    }
    const documentId = z.object({ documentId: z.string().min(8) }).parse(c.req.param()).documentId;
    const rec = await deps.store.getDocumentById(documentId);
    if (!rec) return c.json({ error: 'not found' }, 404);
    const expired = Date.parse(rec.expiresAt) < Date.now();
    const snapshot = looksLikeDocSnapshot(rec.snapshotJson) ? rec.snapshotJson : null;
    const accept = c.req.header('accept') ?? '';
    const wantsHtml = accept.includes('text/html') || c.req.query('view') === '1';
    if (!wantsHtml) {
      return c.json({
        kind: rec.kind,
        publishedAt: rec.publishedAt,
        expiresAt: rec.expiresAt,
        expired,
        snapshot: rec.snapshotJson,
        decision: rec.kind === 'offer' ? rec.decision ?? null : undefined,
        hasPdf: Boolean(rec.pdfKey),
      });
    }

    const title =
      rec.kind === 'offer'
        ? snapshot?.number
          ? `Angebot ${snapshot.number}`
          : 'Angebot'
        : snapshot?.number
          ? `Rechnung ${snapshot.number}`
          : 'Rechnung';
    const statusText =
      rec.kind === 'offer'
        ? expired
          ? 'Abgelaufen'
          : rec.decision
            ? rec.decision.decision === 'accepted'
              ? 'Angenommen'
              : 'Abgelehnt'
            : 'Offen'
        : expired
          ? 'Abgelaufen'
          : String(snapshot?.status ?? 'Offen');
    const csrfToken = crypto.randomBytes(24).toString('base64url');
    if (rec.kind === 'offer' && !expired && !rec.decision) {
      c.header(
        'Set-Cookie',
        `csrfToken=${encodeURIComponent(csrfToken)}; Path=/; HttpOnly; SameSite=Strict${publicOrigin?.startsWith('https://') ? '; Secure' : ''}`,
      );
    }
    const decisionHtml =
      rec.kind !== 'offer'
        ? ''
        : rec.decision
          ? `<div style="margin-top: 14px; color:#555;">Entscheidung: <strong>${escapeHtml(rec.decision.decision)}</strong> (${escapeHtml(rec.decision.acceptedName)})</div>`
          : expired
            ? ''
            : `<form method="post" action="/d/${encodeURIComponent(rec.documentId)}/decision" style="margin-top:16px; padding:14px; border:1px solid #e5e7eb; border-radius:14px;">
  <div style="display:flex; gap:12px; flex-wrap:wrap;">
    <input name="acceptedName" required minlength="1" placeholder="Name" style="flex:1; min-width:180px; padding:10px; border-radius:10px; border:1px solid #ddd;" />
    <input name="acceptedEmail" required type="email" placeholder="E-Mail" style="flex:1; min-width:180px; padding:10px; border-radius:10px; border:1px solid #ddd;" />
  </div>
  <input type="hidden" name="decisionTextVersion" value="v1" />
  <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" />
  <div style="display:flex; gap:12px; margin-top:12px;">
    <button name="decision" value="accepted" style="padding:10px 12px; border-radius:10px; border:1px solid #111; background:#111; color:#fff; font-weight:700;">Annehmen</button>
    <button name="decision" value="declined" style="padding:10px 12px; border-radius:10px; border:1px solid #ddd; background:#fff; color:#111; font-weight:700;">Ablehnen</button>
  </div>
</form>`;
    const pdfUrl = rec.pdfKey ? `/d/${encodeURIComponent(rec.documentId)}/pdf` : '';
    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background:#f3f4f6; margin:0;">
    <main style="max-width: 920px; margin: 30px auto; padding: 0 16px;">
      ${renderPortalBranding('Kundenportal')}
      <section style="background:#fff; border:1px solid #e5e7eb; border-radius:18px; padding:18px;">
        <h1 style="margin:0 0 8px;">${escapeHtml(title)}</h1>
        <div style="color:#666; font-size:14px;">Status: <strong>${escapeHtml(statusText)}</strong> · Gültig bis: ${escapeHtml(new Date(rec.expiresAt).toLocaleDateString('de-DE'))}</div>
        <div style="margin-top:12px; color:#555;">Kunde: <strong>${escapeHtml(snapshot?.client ?? rec.customerLabel ?? '')}</strong></div>
        <div style="margin-top:8px; font-size:20px; font-weight:900;">${escapeHtml(formatCurrencyEur(snapshot?.amount ?? 0))}</div>
        ${decisionHtml}
      </section>
      ${
        pdfUrl
          ? `<section style="margin-top:16px; background:#fff; border:1px solid #e5e7eb; border-radius:18px; overflow:hidden;">
  <div style="padding: 12px 14px; border-bottom:1px solid #eee;"><a href="${escapeHtml(pdfUrl)}" style="font-weight:700; color:#111; text-decoration:none;">PDF herunterladen</a></div>
  <iframe title="Document PDF" src="${escapeHtml(pdfUrl)}" style="width:100%; height: 900px; border:0;"></iframe>
</section>`
          : ''
      }
    </main>
  </body>
</html>`;
    return c.html(html);
  });

  app.get('/d/:documentId/pdf', async (c) => {
    applySensitiveResponseHeaders(c, { allowFrameFromSameOrigin: true });
    const rl = checkRateLimit(c, 'tokenRead');
    if (!rl.ok) {
      c.header('Retry-After', String(rl.retryAfterSec));
      return c.json({ error: 'rate_limited' }, 429);
    }
    const documentId = z.object({ documentId: z.string().min(8) }).parse(c.req.param()).documentId;
    const rec = await deps.store.getDocumentById(documentId);
    if (!rec || !rec.pdfKey) return c.json({ error: 'not found' }, 404);
    const bytes = await deps.pdf.getPdf(rec.pdfKey);
    if (!bytes) return c.json({ error: 'not found' }, 404);
    c.header('content-type', 'application/pdf');
    return c.body(bytes);
  });

  app.post('/d/:documentId/decision', async (c) => {
    applySensitiveResponseHeaders(c);
    const rl = checkRateLimit(c, 'tokenDecision');
    if (!rl.ok) {
      c.header('Retry-After', String(rl.retryAfterSec));
      return c.json({ error: 'rate_limited' }, 429);
    }
    if (!isAllowedDecisionOrigin(c)) {
      return c.json({ error: 'origin_invalid' }, 403);
    }
    const documentId = z.object({ documentId: z.string().min(8) }).parse(c.req.param()).documentId;
    const rec = await deps.store.getDocumentById(documentId);
    if (!rec || rec.kind !== 'offer') return c.json({ error: 'not found' }, 404);
    if (Date.parse(rec.expiresAt) < Date.now()) return c.json({ error: 'expired' }, 410);
    const contentType = c.req.header('content-type') ?? '';
    const isForm =
      contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data');
    const rawBody = isForm ? await c.req.parseBody() : await c.req.json();
    if (isForm) {
      const cookies = parseCookies(c.req.header('cookie'));
      const csrfCookie = String(cookies.csrfToken ?? '').trim();
      const csrfBody = String((rawBody as any).csrfToken ?? '').trim();
      if (!csrfCookie || !csrfBody || csrfCookie !== csrfBody) {
        return c.json({ error: 'csrf_invalid' }, 403);
      }
    }
    const body = decisionSchema.parse({
      decision: String((rawBody as any).decision ?? '').trim(),
      acceptedName: String((rawBody as any).acceptedName ?? '').trim(),
      acceptedEmail: String((rawBody as any).acceptedEmail ?? '').trim().toLowerCase(),
      decisionTextVersion: String((rawBody as any).decisionTextVersion ?? '').trim(),
    });
    const decision = await deps.store.setDecisionOnceByDocumentId(documentId, {
      decidedAt: nowIso(),
      decision: body.decision,
      acceptedName: body.acceptedName,
      acceptedEmail: body.acceptedEmail,
      decisionTextVersion: body.decisionTextVersion,
    });
    const accept = c.req.header('accept') ?? '';
    if (accept.includes('text/html')) {
      return c.redirect(`/d/${encodeURIComponent(documentId)}`);
    }
    return c.json({ ok: true, decision });
  });

  app.get('/offers/:token', async (c) => {
    applySensitiveResponseHeaders(c);
    const rl = checkRateLimit(c, 'tokenRead');
    if (!rl.ok) {
      c.header('Retry-After', String(rl.retryAfterSec));
      return c.json({ error: 'rate_limited' }, 429);
    }
    const token = z.object({ token: z.string().min(16) }).parse(c.req.param()).token;
    const tokenHash = sha256(token);
    const rec = await deps.store.getOfferByTokenHash(tokenHash);
    if (!rec) return c.json({ error: 'not found' }, 404);
    const document = await deps.store.getDocumentByTokenHash(tokenHash);
    const expired = Date.parse(rec.expiresAt) < Date.now();

    const accept = c.req.header('accept') ?? '';
    const wantsHtml = accept.includes('text/html') || c.req.query('view') === '1';
    if (!wantsHtml) {
      return c.json({
        publishedAt: rec.publishedAt,
        expiresAt: rec.expiresAt,
        expired,
        snapshot: rec.snapshotJson,
        decision: rec.decision ?? null,
        hasPdf: Boolean(rec.pdfKey),
      });
    }
    if (document?.documentId) {
      return c.redirect(`/d/${encodeURIComponent(document.documentId)}`);
    }

    const snapshot = looksLikeDocSnapshot(rec.snapshotJson) ? rec.snapshotJson : null;
    const title = snapshot?.number ? `Angebot ${snapshot.number}` : 'Angebot';
    const decision = rec.decision ?? null;

    const pdfUrl = rec.pdfKey ? `/offers/${encodeURIComponent(token)}/pdf` : null;
    const statusText = expired
      ? 'Abgelaufen'
      : decision
        ? decision.decision === 'accepted'
          ? 'Angenommen'
          : 'Abgelehnt'
        : 'Offen';

    const decidedAt = decision?.decidedAt ? new Date(decision.decidedAt).toLocaleString('de-DE') : '';
    const expiresAt = rec.expiresAt ? new Date(rec.expiresAt).toLocaleDateString('de-DE') : '';
    const publishedAt = rec.publishedAt ? new Date(rec.publishedAt).toLocaleDateString('de-DE') : '';

    const itemsHtml =
      snapshot?.items && Array.isArray(snapshot.items) && snapshot.items.length > 0
        ? snapshot.items
            .slice(0, 100)
            .map((it) => {
              const desc = escapeHtml(it.description ?? '');
              const qty = Number.isFinite(Number(it.quantity)) ? Number(it.quantity) : 0;
              const total = formatCurrencyEur(it.total);
              return `<tr>
  <td style="padding: 10px 0; border-bottom: 1px solid #eee;">${desc}</td>
  <td style="padding: 10px 0; border-bottom: 1px solid #eee; text-align:right; font-variant-numeric: tabular-nums;">${qty}</td>
  <td style="padding: 10px 0; border-bottom: 1px solid #eee; text-align:right; font-variant-numeric: tabular-nums;">${total}</td>
</tr>`;
            })
            .join('\n')
        : '';

    const decisionBox = decision
      ? `<div style="padding:16px; border-radius:16px; border:1px solid #eee; background:#fafafa; margin-top: 16px;">
  <div style="font-weight: 800; margin-bottom: 6px;">Status: ${escapeHtml(statusText)}</div>
  <div style="color:#555; font-size:14px;">Entscheidung am ${escapeHtml(decidedAt)}</div>
  <div style="color:#555; font-size:14px;">Name: ${escapeHtml(decision.acceptedName)}</div>
  <div style="color:#555; font-size:14px;">E-Mail: ${escapeHtml(decision.acceptedEmail)}</div>
</div>`
      : '';
    const csrfToken = crypto.randomBytes(24).toString('base64url');
    if (!expired && !decision) {
      c.header(
        'Set-Cookie',
        `csrfToken=${encodeURIComponent(csrfToken)}; Path=/; HttpOnly; SameSite=Strict${publicOrigin?.startsWith('https://') ? '; Secure' : ''}`,
      );
    }

    const actionForm =
      expired || decision
        ? ''
        : `<form method="post" action="/offers/${encodeURIComponent(token)}/decision" style="margin-top:16px; padding:16px; border-radius:16px; border:1px solid #eee;">
  <div style="display:flex; gap:12px; flex-wrap:wrap;">
    <div style="flex:1; min-width: 220px;">
      <label style="display:block; font-size:12px; font-weight:800; color:#444;">Name (Pflicht)</label>
      <input name="acceptedName" required minlength="1" autocomplete="name" style="width:100%; padding:10px 12px; border-radius:12px; border:1px solid #ddd; margin-top:6px;" />
    </div>
    <div style="flex:1; min-width: 220px;">
      <label style="display:block; font-size:12px; font-weight:800; color:#444;">E-Mail (Pflicht)</label>
      <input name="acceptedEmail" required minlength="3" autocomplete="email" type="email" style="width:100%; padding:10px 12px; border-radius:12px; border:1px solid #ddd; margin-top:6px;" />
    </div>
  </div>
  <div style="margin-top:12px; color:#555; font-size:13px;">
    Mit Klick wird eine Entscheidung gespeichert (einmalig). Das Angebot bleibt danach weiter einsehbar.
  </div>
  <input type="hidden" name="decisionTextVersion" value="v1" />
  <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" />
  <div style="display:flex; gap:12px; margin-top: 14px;">
    <button name="decision" value="accepted" style="cursor:pointer; padding:12px 14px; border-radius:14px; border:1px solid #111; background:#111; color:#fff; font-weight:800;">
      Angebot annehmen
    </button>
    <button name="decision" value="declined" style="cursor:pointer; padding:12px 14px; border-radius:14px; border:1px solid #ddd; background:#fff; color:#111; font-weight:800;">
      Ablehnen
    </button>
  </div>
</form>`;

    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'unsafe-inline'; frame-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background:#f3f4f6; margin:0;">
    <main style="max-width: 980px; margin: 40px auto; padding: 0 16px;">
      ${renderPortalBranding('Kundenportal')}
      <div style="display:flex; justify-content:space-between; gap: 12px; flex-wrap:wrap; align-items:flex-end;">
        <div>
          <div style="font-size:12px; font-weight:900; letter-spacing: .12em; color:#666; text-transform:uppercase;">Angebot</div>
          <h1 style="margin:6px 0 0; font-size: 28px; letter-spacing:-.02em;">${escapeHtml(snapshot?.number ?? 'Angebot')}</h1>
          <div style="margin-top:8px; color:#555;">Kunde: <strong>${escapeHtml(snapshot?.client ?? '')}</strong></div>
        </div>
        <div style="padding:14px 16px; border-radius:18px; background:#fff; border:1px solid #e5e7eb;">
          <div style="font-size:12px; font-weight:900; letter-spacing: .12em; color:#666; text-transform:uppercase;">Status</div>
          <div style="margin-top:6px; font-size: 16px; font-weight:900;">${escapeHtml(statusText)}</div>
          <div style="margin-top:4px; font-size: 13px; color:#666;">Veröffentlicht: ${escapeHtml(publishedAt)} · Gültig bis: ${escapeHtml(expiresAt)}</div>
        </div>
      </div>

      <div style="margin-top: 18px; display:grid; grid-template-columns: 1fr; gap: 16px;">
        <section style="background:#fff; border:1px solid #e5e7eb; border-radius: 24px; padding: 18px 18px;">
          <div style="display:flex; justify-content:space-between; align-items:center; gap: 12px; flex-wrap:wrap;">
            <div style="font-weight: 900;">Zusammenfassung</div>
            <div style="font-size: 18px; font-weight: 1000; font-variant-numeric: tabular-nums;">
              ${escapeHtml(formatCurrencyEur(snapshot?.amount))}
            </div>
          </div>
          ${
            itemsHtml
              ? `<table style="width:100%; border-collapse:collapse; margin-top: 10px;">
  <thead>
    <tr>
      <th style="text-align:left; font-size:12px; color:#666; padding: 8px 0; border-bottom: 1px solid #eee;">Position</th>
      <th style="text-align:right; font-size:12px; color:#666; padding: 8px 0; border-bottom: 1px solid #eee;">Menge</th>
      <th style="text-align:right; font-size:12px; color:#666; padding: 8px 0; border-bottom: 1px solid #eee;">Summe</th>
    </tr>
  </thead>
  <tbody>${itemsHtml}</tbody>
</table>`
              : `<div style="margin-top: 10px; color:#666; font-size: 14px;">Details sind in der PDF enthalten.</div>`
          }

          ${decisionBox}
          ${actionForm}
        </section>

        ${
          pdfUrl
            ? `<section style="background:#fff; border:1px solid #e5e7eb; border-radius: 24px; overflow:hidden;">
  <div style="display:flex; justify-content:space-between; align-items:center; padding: 14px 16px; border-bottom: 1px solid #eee;">
    <div style="font-weight:900;">PDF</div>
    <a href="${escapeHtml(pdfUrl)}" style="text-decoration:none; font-weight:900; color:#111;">PDF herunterladen</a>
  </div>
  <iframe title="Offer PDF" src="${escapeHtml(pdfUrl)}" style="width:100%; height: 900px; border:0;"></iframe>
</section>`
            : `<section style="background:#fff; border:1px solid #e5e7eb; border-radius: 24px; padding: 16px;">
  <div style="font-weight: 900;">PDF</div>
  <div style="margin-top: 8px; color:#666; font-size: 14px;">Keine PDF verfügbar.</div>
</section>`
        }
      </div>

      <footer style="margin: 18px 0; color:#666; font-size: 12px;">
        Offer Portal · Token-basierter Zugriff · ${escapeHtml(statusText)}
      </footer>
    </main>
  </body>
</html>`;

    return c.html(html);
  });

  app.get('/invoices/:token', async (c) => {
    applySensitiveResponseHeaders(c);
    const rl = checkRateLimit(c, 'tokenRead');
    if (!rl.ok) {
      c.header('Retry-After', String(rl.retryAfterSec));
      return c.json({ error: 'rate_limited' }, 429);
    }
    const token = z.object({ token: z.string().min(16) }).parse(c.req.param()).token;
    const rec = await deps.store.getInvoiceByTokenHash(sha256(token));
    if (!rec) return c.json({ error: 'not found' }, 404);
    const document = await deps.store.getDocumentByTokenHash(sha256(token));
    const expired = Date.parse(rec.expiresAt) < Date.now();

    const accept = c.req.header('accept') ?? '';
    const wantsHtml = accept.includes('text/html') || c.req.query('view') === '1';
    if (!wantsHtml) {
      return c.json({
        publishedAt: rec.publishedAt,
        expiresAt: rec.expiresAt,
        expired,
        snapshot: rec.snapshotJson,
        hasPdf: Boolean(rec.pdfKey),
      });
    }
    if (document?.documentId) {
      return c.redirect(`/d/${encodeURIComponent(document.documentId)}`);
    }

    const snapshot = looksLikeDocSnapshot(rec.snapshotJson) ? rec.snapshotJson : null;
    const pdfUrl = rec.pdfKey ? `/invoices/${encodeURIComponent(token)}/pdf` : null;

    const itemsHtml =
      snapshot?.items && Array.isArray(snapshot.items) && snapshot.items.length > 0
        ? snapshot.items
            .slice(0, 100)
            .map((it) => {
              const desc = escapeHtml(it.description ?? '');
              const qty = Number.isFinite(Number(it.quantity)) ? Number(it.quantity) : 0;
              const total = formatCurrencyEur(it.total);
              return `<tr>
  <td style="padding: 10px 0; border-bottom: 1px solid #eee;">${desc}</td>
  <td style="padding: 10px 0; border-bottom: 1px solid #eee; text-align:right; font-variant-numeric: tabular-nums;">${qty}</td>
  <td style="padding: 10px 0; border-bottom: 1px solid #eee; text-align:right; font-variant-numeric: tabular-nums;">${total}</td>
</tr>`;
            })
            .join('\n')
        : '';

    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'unsafe-inline'; frame-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'" />
    <title>${escapeHtml(snapshot?.number ? `Rechnung ${snapshot.number}` : 'Rechnung')}</title>
  </head>
  <body style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background:#f3f4f6; margin:0;">
    <main style="max-width: 980px; margin: 40px auto; padding: 0 16px;">
      ${renderPortalBranding('Kundenportal')}
      <div style="display:flex; justify-content:space-between; gap: 12px; flex-wrap:wrap; align-items:flex-end;">
        <div>
          <div style="font-size:12px; font-weight:900; letter-spacing: .12em; color:#666; text-transform:uppercase;">Rechnung</div>
          <h1 style="margin:6px 0 0; font-size: 28px; letter-spacing:-.02em;">${escapeHtml(snapshot?.number ?? 'Rechnung')}</h1>
          <div style="margin-top:8px; color:#555;">Kunde: <strong>${escapeHtml(snapshot?.client ?? '')}</strong></div>
        </div>
      </div>
      <section style="margin-top: 18px; background:#fff; border:1px solid #e5e7eb; border-radius: 24px; padding: 18px;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
          <div style="font-weight: 900;">Zusammenfassung</div>
          <div style="font-size: 18px; font-weight: 1000; font-variant-numeric: tabular-nums;">${escapeHtml(formatCurrencyEur(snapshot?.amount))}</div>
        </div>
        ${
          itemsHtml
            ? `<table style="width:100%; border-collapse:collapse; margin-top: 10px;">
  <thead>
    <tr>
      <th style="text-align:left; font-size:12px; color:#666; padding: 8px 0; border-bottom: 1px solid #eee;">Position</th>
      <th style="text-align:right; font-size:12px; color:#666; padding: 8px 0; border-bottom: 1px solid #eee;">Menge</th>
      <th style="text-align:right; font-size:12px; color:#666; padding: 8px 0; border-bottom: 1px solid #eee;">Summe</th>
    </tr>
  </thead>
  <tbody>${itemsHtml}</tbody>
</table>`
            : `<div style="margin-top: 10px; color:#666; font-size: 14px;">Details sind in der PDF enthalten.</div>`
        }
      </section>
      ${
        pdfUrl
          ? `<section style="margin-top:16px; background:#fff; border:1px solid #e5e7eb; border-radius: 24px; overflow:hidden;">
  <div style="display:flex; justify-content:space-between; align-items:center; padding: 14px 16px; border-bottom: 1px solid #eee;">
    <div style="font-weight:900;">PDF</div>
    <a href="${escapeHtml(pdfUrl)}" style="text-decoration:none; font-weight:900; color:#111;">PDF herunterladen</a>
  </div>
  <iframe title="Invoice PDF" src="${escapeHtml(pdfUrl)}" style="width:100%; height: 900px; border:0;"></iframe>
</section>`
          : ''
      }
    </main>
  </body>
</html>`;

    return c.html(html);
  });

  app.get('/offers/:token/pdf', async (c) => {
    applySensitiveResponseHeaders(c, { allowFrameFromSameOrigin: true });
    const rl = checkRateLimit(c, 'tokenRead');
    if (!rl.ok) {
      c.header('Retry-After', String(rl.retryAfterSec));
      return c.json({ error: 'rate_limited' }, 429);
    }
    const token = z.object({ token: z.string().min(16) }).parse(c.req.param()).token;
    const tokenHash = sha256(token);
    const rec = await deps.store.getOfferByTokenHash(tokenHash);
    if (!rec || !rec.pdfKey) return c.json({ error: 'not found' }, 404);
    const bytes = await deps.pdf.getPdf(rec.pdfKey);
    if (!bytes) return c.json({ error: 'not found' }, 404);
    c.header('content-type', 'application/pdf');
    return c.body(bytes);
  });

  app.get('/invoices/:token/pdf', async (c) => {
    applySensitiveResponseHeaders(c, { allowFrameFromSameOrigin: true });
    const rl = checkRateLimit(c, 'tokenRead');
    if (!rl.ok) {
      c.header('Retry-After', String(rl.retryAfterSec));
      return c.json({ error: 'rate_limited' }, 429);
    }
    const token = z.object({ token: z.string().min(16) }).parse(c.req.param()).token;
    const rec = await deps.store.getInvoiceByTokenHash(sha256(token));
    if (!rec || !rec.pdfKey) return c.json({ error: 'not found' }, 404);
    const bytes = await deps.pdf.getPdf(rec.pdfKey);
    if (!bytes) return c.json({ error: 'not found' }, 404);
    c.header('content-type', 'application/pdf');
    return c.body(bytes);
  });

  app.post('/offers/:token/decision', async (c) => {
    applySensitiveResponseHeaders(c);
    const rl = checkRateLimit(c, 'tokenDecision');
    if (!rl.ok) {
      c.header('Retry-After', String(rl.retryAfterSec));
      return c.json({ error: 'rate_limited' }, 429);
    }
    const token = z.object({ token: z.string().min(16) }).parse(c.req.param()).token;
    const tokenHash = sha256(token);
    const rec = await deps.store.getOfferByTokenHash(tokenHash);
    if (!rec) return c.json({ error: 'not found' }, 404);
    const document = await deps.store.getDocumentByTokenHash(tokenHash);

    const expired = Date.parse(rec.expiresAt) < Date.now();
    if (expired) return c.json({ error: 'expired' }, 410);

    const contentType = c.req.header('content-type') ?? '';
    const isForm =
      contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data');
    if (!isAllowedDecisionOrigin(c)) {
      return c.json({ error: 'origin_invalid' }, 403);
    }
    const rawBody = isForm ? await c.req.parseBody() : await c.req.json();
    if (isForm) {
      const cookies = parseCookies(c.req.header('cookie'));
      const csrfCookie = String(cookies.csrfToken ?? '').trim();
      const csrfBody = String((rawBody as any).csrfToken ?? '').trim();
      if (!csrfCookie || !csrfBody || csrfCookie !== csrfBody) {
        return c.json({ error: 'csrf_invalid' }, 403);
      }
    }
    const body = decisionSchema.parse({
      decision: String((rawBody as any).decision ?? '').trim(),
      acceptedName: String((rawBody as any).acceptedName ?? '').trim(),
      acceptedEmail: String((rawBody as any).acceptedEmail ?? '').trim().toLowerCase(),
      decisionTextVersion: String((rawBody as any).decisionTextVersion ?? '').trim(),
    });
    const decision = await deps.store.setDecisionOnce(tokenHash, {
      decidedAt: nowIso(),
      decision: body.decision,
      acceptedName: body.acceptedName,
      acceptedEmail: body.acceptedEmail,
      decisionTextVersion: body.decisionTextVersion,
    });

    const accept = c.req.header('accept') ?? '';
    const wantsHtml = accept.includes('text/html');
    if (wantsHtml) {
      if (document?.documentId) {
        return c.redirect(`/d/${encodeURIComponent(document.documentId)}`);
      }
      return c.redirect(`/offers/${encodeURIComponent(token)}`);
    }
    return c.json({ ok: true, decision });
  });

  app.get('/offers/:token/status', async (c) => {
    applySensitiveResponseHeaders(c);
    const rl = checkRateLimit(c, 'tokenRead');
    if (!rl.ok) {
      c.header('Retry-After', String(rl.retryAfterSec));
      return c.json({ error: 'rate_limited' }, 429);
    }
    const token = z.object({ token: z.string().min(16) }).parse(c.req.param()).token;
    const tokenHash = sha256(token);
    const rec = await deps.store.getOfferByTokenHash(tokenHash);
    if (!rec) return c.json({ error: 'not found' }, 404);
    return c.json({ decision: rec.decision ?? null });
  });

  return app;
};

const tokenHashPrefix = (token: string) => sha256(token).slice(0, 10);
