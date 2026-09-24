import crypto from 'crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
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

/* Missing values render as the half-width dash, never as an empty cell or "Invalid Date". */
const optionalNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

/* Matches desktop-utils `formatDate`: German invoice views always render TT.MM.JJJJ. */
const formatDateDe = (value: unknown): string => {
  const parsed = typeof value === 'string' && value.trim() ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : '–';
};

const formatDateTimeDe = (value: unknown): string => {
  const parsed = typeof value === 'string' && value.trim() ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toLocaleString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '–';
};

/* Portal palette. The portal renders straight from Node without a build step and
   does not depend on @billme/ui, so the token values from packages/ui/styles.css
   are declared once here instead of being repeated as literals per element. */
export const PORTAL_TOKENS = {
  surface: '#ffffff',
  surfaceSunken: '#f3f4f6',
  foreground: '#0d0e11',
  muted: '#64686d',
  border: '#e5e6e9',
  controlBorder: '#87898d',
  accent: '#d9f944',
  accentForeground: '#0d0e11',
  focusRing: '#0d0e11',
  successText: '#15803d',
  warningText: '#92400e',
  warningBg: '#fbf5da',
  warningBorder: '#fde68a',
  errorText: '#b91c1c',
  radiusSm: '0.375rem',
  radiusMd: '0.5rem',
  radiusLg: '0.75rem',
} as const;

/* Inter first, per DESIGN.md. The desktop apps load the webfont themselves; the
   portal is served as plain HTML, so the stack falls back to Helvetica/Arial. */
const PORTAL_FONT_STACK = 'Inter, "Helvetica Neue", Helvetica, Arial, sans-serif';

/* One name and one shell width for every page: the header must neither relabel
   itself nor shift between the start, document and error views. */
const PORTAL_NAME = 'Angebotsportal';
const PORTAL_SHELL_MAX_WIDTH_PX = 980;

const PORTAL_CSP_BASE =
  "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'";
const PORTAL_CSP_WITH_FORM =
  "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const PORTAL_INPUT_STYLE = `width:100%; padding:.625rem .75rem; border-radius:${PORTAL_TOKENS.radiusSm}; border:1px solid ${PORTAL_TOKENS.controlBorder}; background:${PORTAL_TOKENS.surface}; color:${PORTAL_TOKENS.foreground}; font:inherit;`;
const PORTAL_PRIMARY_BUTTON_STYLE = `cursor:pointer; padding:.625rem .875rem; border-radius:${PORTAL_TOKENS.radiusSm}; border:1px solid ${PORTAL_TOKENS.accent}; background:${PORTAL_TOKENS.accent}; color:${PORTAL_TOKENS.accentForeground}; font:inherit; font-weight:600;`;
const PORTAL_SECONDARY_BUTTON_STYLE = `cursor:pointer; padding:.625rem .875rem; border-radius:${PORTAL_TOKENS.radiusSm}; border:1px solid ${PORTAL_TOKENS.controlBorder}; background:${PORTAL_TOKENS.surface}; color:${PORTAL_TOKENS.foreground}; font:inherit; font-weight:600;`;
const PORTAL_LABEL_STYLE = `display:block; font-size:.8125rem; font-weight:500; color:${PORTAL_TOKENS.foreground};`;
const PORTAL_CARD_STYLE = `background:${PORTAL_TOKENS.surface}; border:1px solid ${PORTAL_TOKENS.border}; border-radius:${PORTAL_TOKENS.radiusLg};`;

const renderPortalPage = (options: {
  title: string;
  contentSecurityPolicy: string;
  contentMaxWidthPx?: number;
  content: string;
}) => `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="${options.contentSecurityPolicy}" />
    <title>${escapeHtml(options.title)}</title>
    <style>
      :root { color-scheme: light; }
      *, *::before, *::after { box-sizing: border-box; }
      html { background: ${PORTAL_TOKENS.surfaceSunken}; }
      body {
        margin: 0;
        min-height: 100vh;
        background: ${PORTAL_TOKENS.surfaceSunken};
        color: ${PORTAL_TOKENS.foreground};
        font-family: ${PORTAL_FONT_STACK};
        font-size: 16px;
        line-height: 1.5;
        -webkit-font-smoothing: antialiased;
      }
      a:focus-visible, button:focus-visible, input:focus-visible {
        outline: 2px solid ${PORTAL_TOKENS.focusRing};
        outline-offset: 2px;
      }
    </style>
  </head>
  <body>
    <main style="max-width:${PORTAL_SHELL_MAX_WIDTH_PX}px; margin:0 auto; padding:32px 16px 48px;">
      <div style="display:flex; align-items:center; gap:.75rem; margin-bottom:1.25rem;">
        <img src="${BILLME_FULL_LOGO_DATA_URI}" alt="Billme" style="height:28px; width:auto;" />
        <span style="font-size:.8125rem; font-weight:500; color:${PORTAL_TOKENS.muted};">${escapeHtml(PORTAL_NAME)}</span>
      </div>
      <div style="max-width:${options.contentMaxWidthPx ?? PORTAL_SHELL_MAX_WIDTH_PX}px;">
      ${options.content}
      </div>
    </main>
  </body>
</html>`;

/* Accent fill is reserved for the one action a page wants the reader to take. */
const renderPortalActionLink = (href: string, label: string) =>
  `<a href="${escapeHtml(href)}" style="display:inline-block; padding:.625rem .875rem; border-radius:${PORTAL_TOKENS.radiusSm}; border:1px solid ${PORTAL_TOKENS.accent}; background:${PORTAL_TOKENS.accent}; color:${PORTAL_TOKENS.accentForeground}; font-weight:600; text-decoration:none;">${escapeHtml(label)}</a>`;

const renderPortalTextLink = (href: string, label: string) =>
  `<a href="${escapeHtml(href)}" style="color:${PORTAL_TOKENS.foreground}; font-weight:600;">${escapeHtml(label)}</a>`;

type PortalErrorCondition = 'unknown' | 'revoked' | 'expired' | 'rate_limited';
type PortalDecisionErrorCondition = 'csrf_invalid' | 'origin_invalid';

const PORTAL_ERRORS: Record<PortalErrorCondition | PortalDecisionErrorCondition, { title: string; cause: string; action: string; color: string }> = {
  unknown: {
    title: 'Dieser Link gehört zu keinem Dokument',
    cause:
      'Der Link ist unvollständig oder das Dokument wurde entfernt. Links, die E-Mail-Programme umbrechen, verlieren oft die letzten Zeichen.',
    action: 'Bitte wende dich an den Absender und bitte um einen neuen Link.',
    color: PORTAL_TOKENS.muted,
  },
  revoked: {
    title: 'Dieser Link wurde zurückgezogen',
    cause: 'Der Absender hat den Zugriff über diesen Link beendet. Meist wurde dafür ein neuer Link ausgestellt.',
    action: 'Bitte wende dich an den Absender und bitte um einen neuen Link.',
    color: PORTAL_TOKENS.errorText,
  },
  expired: {
    title: 'Dieser Link ist abgelaufen',
    cause: 'Die Gültigkeitsdauer des Links ist abgelaufen, deshalb werden die Dokumente nicht mehr angezeigt.',
    action: 'Bitte wende dich an den Absender und bitte um einen neuen Link.',
    color: PORTAL_TOKENS.warningText,
  },
  rate_limited: {
    title: 'Zu viele Aufrufe in kurzer Zeit',
    cause: 'Von dieser Verbindung kamen zu viele Anfragen, deshalb pausiert das Portal den Zugriff kurz.',
    action: 'Bitte lade die Seite in einer Minute erneut.',
    color: PORTAL_TOKENS.warningText,
  },
  csrf_invalid: {
    title: 'Diese Entscheidung konnte nicht gespeichert werden',
    cause: 'Das Sicherheitsmerkmal des Formulars fehlt oder ist veraltet. Das passiert, wenn die Seite lange offen war oder Cookies blockiert sind.',
    action: 'Bitte lade die Dokumentseite neu und sende das Formular erneut.',
    color: PORTAL_TOKENS.errorText,
  },
  origin_invalid: {
    title: 'Diese Entscheidung konnte nicht gespeichert werden',
    cause: 'Die Anfrage kam nicht von der Dokumentseite dieses Portals, deshalb wurde sie aus Sicherheitsgründen abgelehnt.',
    action: 'Bitte öffne das Dokument über den Link aus deiner E-Mail und sende das Formular von dort.',
    color: PORTAL_TOKENS.errorText,
  },
};

const renderPortalErrorPage = (condition: PortalErrorCondition | PortalDecisionErrorCondition, options?: { retryHref?: string }) => {
  const spec = PORTAL_ERRORS[condition];
  const retry = options?.retryHref
    ? `<p style="margin:1rem 0 0;">${renderPortalTextLink(options.retryHref, 'Erneut versuchen')}</p>`
    : '';
  return renderPortalPage({
    title: spec.title,
    contentSecurityPolicy: PORTAL_CSP_BASE,
    contentMaxWidthPx: 640,
    content: `<section style="${PORTAL_CARD_STYLE} padding:1.5rem;">
  <h1 style="margin:0; font-size:1.5rem; letter-spacing:-.01em;">${escapeHtml(spec.title)}</h1>
  <p style="margin:.75rem 0 0;">${escapeHtml(spec.cause)}</p>
  <p style="margin:1rem 0 0; color:${spec.color}; font-weight:600;">${escapeHtml(spec.action)}</p>
  ${retry}
</section>`,
  });
};

/* Status stays readable text, never colour alone; the label carries the meaning. */
const portalStatusColor = (status: string): string => {
  switch (status) {
    case 'Angenommen':
    case 'Bezahlt':
      return PORTAL_TOKENS.successText;
    case 'Abgelehnt':
    case 'Abgelaufen':
    case 'Überfällig':
      return PORTAL_TOKENS.errorText;
    default:
      return PORTAL_TOKENS.muted;
  }
};

/* Snapshot statuses are stored in English; the portal only ever shows German labels. */
const DOCUMENT_STATUS_LABELS: Record<string, string> = {
  draft: 'Entwurf',
  open: 'Offen',
  paid: 'Bezahlt',
  overdue: 'Überfällig',
  cancelled: 'Storniert',
};

const documentStatusLabel = (status: unknown): string => {
  const raw = typeof status === 'string' ? status.trim() : '';
  if (!raw) return 'Offen';
  return DOCUMENT_STATUS_LABELS[raw.toLowerCase()] ?? raw;
};

type PortalSnapshotItem = {
  description?: string;
  quantity?: number;
  price?: number;
  total?: number;
};

type PortalSnapshot = {
  number?: string;
  client?: string;
  clientId?: string;
  clientEmail?: string;
  date?: string;
  dueDate?: string;
  amount?: number;
  status?: string;
  items?: PortalSnapshotItem[];
  taxSnapshot?: {
    vatRateApplied?: number;
    vatAmount?: number;
    netAmount?: number;
    grossAmount?: number;
  };
};

const looksLikeDocSnapshot = (snap: unknown): snap is PortalSnapshot =>
  typeof snap === 'object' && snap !== null;

const PORTAL_TABLE_HEAD = `text-align:left; padding:.625rem .5rem .625rem 0; border-bottom:1px solid ${PORTAL_TOKENS.border}; font-size:.75rem; letter-spacing:.05em; text-transform:uppercase; color:${PORTAL_TOKENS.muted};`;
const PORTAL_TABLE_HEAD_NUM = `text-align:right; padding:.625rem .5rem; border-bottom:1px solid ${PORTAL_TOKENS.border}; font-size:.75rem; letter-spacing:.05em; text-transform:uppercase; color:${PORTAL_TOKENS.muted};`;

/* Mirrors the desktop document view: one row per line item, German quantity and
   currency notation. A value the snapshot does not carry stays a dash. */
const renderDocumentPositions = (items: PortalSnapshotItem[]): string =>
  `<div style="overflow-x:auto;" role="region" aria-label="Positionen" tabindex="0">
    <table style="width:100%; min-width:28rem; border-collapse:collapse;">
      <thead>
        <tr>
          <th style="${PORTAL_TABLE_HEAD}">Position</th>
          <th style="${PORTAL_TABLE_HEAD_NUM}">Menge</th>
          <th style="${PORTAL_TABLE_HEAD_NUM}">Einzelpreis</th>
          <th style="${PORTAL_TABLE_HEAD_NUM}">Summe</th>
        </tr>
      </thead>
      <tbody>${items
        .slice(0, 100)
        .map((item) => {
          const quantity = optionalNumber(item.quantity);
          const price = optionalNumber(item.price);
          const total = optionalNumber(item.total);
          return `<tr>
          <td style="padding:.625rem .5rem .625rem 0; border-bottom:1px solid ${PORTAL_TOKENS.border};">${escapeHtml(item.description ?? '')}</td>
          <td style="padding:.625rem .5rem; border-bottom:1px solid ${PORTAL_TOKENS.border}; text-align:right; font-variant-numeric:tabular-nums;">${quantity === null ? '–' : escapeHtml(quantity.toLocaleString('de-DE'))}</td>
          <td style="padding:.625rem .5rem; border-bottom:1px solid ${PORTAL_TOKENS.border}; text-align:right; font-variant-numeric:tabular-nums;">${price === null ? '–' : escapeHtml(formatCurrencyEur(price))}</td>
          <td style="padding:.625rem 0 .625rem .5rem; border-bottom:1px solid ${PORTAL_TOKENS.border}; text-align:right; font-variant-numeric:tabular-nums;">${total === null ? '–' : escapeHtml(formatCurrencyEur(total))}</td>
        </tr>`;
        })
        .join('\n')}</tbody>
    </table>
  </div>`;

/* Netto, USt and Brutto come from the stored tax snapshot; the line items cover
   snapshots that predate it, and the document amount is the gross fallback. */
const renderDocumentTotals = (snapshot: PortalSnapshot | null): string => {
  const tax = snapshot?.taxSnapshot;
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  const itemsNet = items.reduce((sum, item) => sum + (optionalNumber(item.total) ?? 0), 0);
  const net = optionalNumber(tax?.netAmount) ?? (items.length ? Math.round(itemsNet * 100) / 100 : null);
  const gross = optionalNumber(tax?.grossAmount) ?? optionalNumber(snapshot?.amount);
  const vat =
    optionalNumber(tax?.vatAmount) ??
    (net !== null && gross !== null ? Math.round((gross - net) * 100) / 100 : null);
  const vatRate = optionalNumber(tax?.vatRateApplied);
  const row = (label: string, value: string) =>
    `<div style="display:flex; justify-content:space-between; gap:1rem;"><span style="color:${PORTAL_TOKENS.muted};">${label}</span><span style="font-variant-numeric:tabular-nums;">${value}</span></div>`;

  return `<div style="margin-top:.875rem; padding-top:.75rem; border-top:1px solid ${PORTAL_TOKENS.border}; display:grid; gap:.375rem; font-size:.875rem;">
  ${row('Netto', net === null ? '–' : escapeHtml(formatCurrencyEur(net)))}
  ${row(vatRate === null ? 'USt' : `USt (${vatRate.toLocaleString('de-DE')} %)`, vat === null ? '–' : escapeHtml(formatCurrencyEur(vat)))}
  <div style="display:flex; justify-content:space-between; gap:1rem; margin-top:.125rem; padding-top:.5rem; border-top:1px solid ${PORTAL_TOKENS.border}; font-size:1rem; font-weight:700;">
    <span>Brutto</span>
    <span style="font-variant-numeric:tabular-nums;">${gross === null ? '–' : escapeHtml(formatCurrencyEur(gross))}</span>
  </div>
</div>`;
};

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
  return snap?.status ? documentStatusLabel(snap.status) : expired ? 'Abgelaufen' : 'Offen';
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
  /* `no-referrer` makes browsers send `Origin: null` on the decision form POST,
     which the origin check then has to reject. `same-origin` still keeps the
     token-bearing portal URL away from every other origin, while the Origin
     header stays intact. */
  c.header('Referrer-Policy', 'same-origin');
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
  const publicBase = (() => {
    const base = deps.config.publicBaseUrl?.trim();
    if (!base) return null;
    try {
      return new URL(base);
    } catch {
      return null;
    }
  })();
  const publicOrigin = publicBase?.origin ?? null;
  const publicHost = publicBase?.host ?? null;

  /* A decision POST is same-origin when the browser names one of our own origins:
     the configured public base URL, or the origin the request was addressed to
     (behind a proxy the two differ). Every other named origin is rejected.
     `Origin: null` or a missing header means the sending page suppressed the
     header. That case is accepted only for a form post that we can still tie to
     our own host, where the SameSite=Strict CSRF cookie identifies the sender. */
  const isAllowedDecisionOrigin = (c: Context): boolean => {
    if (!publicOrigin) return true;
    let requestOrigin: string | null = null;
    try {
      requestOrigin = new URL(c.req.url).origin;
    } catch {
      requestOrigin = null;
    }
    const allowedOrigins = [publicOrigin];
    if (requestOrigin && requestOrigin !== publicOrigin) allowedOrigins.push(requestOrigin);
    const origin = c.req.header('origin');
    if (origin && origin !== 'null') return allowedOrigins.includes(origin);
    const contentType = c.req.header('content-type') ?? '';
    const isFormPost =
      contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data');
    if (!isFormPost) return false;
    const referer = c.req.header('referer');
    if (referer) {
      try {
        return allowedOrigins.includes(new URL(referer).origin);
      } catch {
        return false;
      }
    }
    const host = c.req.header('host');
    if (!host || !publicHost) return false;
    return host.toLowerCase() === publicHost.toLowerCase();
  };

  app.get('/health', (c) => c.json({ ok: true, ts: nowIso() }));

  app.get('/', (c) => {
    applySensitiveResponseHeaders(c);
    return c.html(
      renderPortalPage({
        title: 'Angebotsportal',
        contentSecurityPolicy: PORTAL_CSP_BASE,
        contentMaxWidthPx: 720,
        content: `<section style="${PORTAL_CARD_STYLE} padding:1.5rem;">
  <h1 style="margin:0; font-size:1.5rem; letter-spacing:-.01em;">Angebotsportal</h1>
  <p style="margin:.75rem 0 0;">Über dieses Portal erreichst du Angebote und Rechnungen, die dir per E-Mail zugeschickt wurden. Der Link aus der E-Mail führt direkt zum Dokument.</p>
  <p style="margin:.75rem 0 0; color:${PORTAL_TOKENS.muted};">Auf der Dokumentseite kannst du ein Angebot annehmen oder ablehnen und die PDF herunterladen. Ein Link gilt nur für die Person, an die er gerichtet ist, und nur bis zum angegebenen Datum.</p>
  <p style="margin:1rem 0 0; font-weight:600;">Du hast keinen Link zur Hand? Dann bitte den Absender um einen neuen.</p>
</section>`,
      }),
    );
  });

  app.get('/admin/setup', (c) => {
    applySensitiveResponseHeaders(c);
    const baseUrl = deps.config.publicBaseUrl ?? '(nicht gesetzt)';
    const hasKey = Boolean(deps.config.publishApiKey);
    const strictAuth = Boolean(deps.config.requirePublishApiKey);
    const authHealth =
      strictAuth && !hasKey ? 'Fehlkonfiguration (STRICT_PUBLISH_AUTH ohne Schlüssel)' : hasKey ? 'aktiv' : 'inaktiv';
    return c.html(
      renderPortalPage({
        title: 'Einrichtung des Angebotsportals',
        contentSecurityPolicy: PORTAL_CSP_BASE,
        contentMaxWidthPx: 720,
        content: `<h1 style="margin:0 0 .5rem; font-size:1.5rem; letter-spacing:-.01em;">Einrichtung</h1>
<p style="margin:0; color:${PORTAL_TOKENS.muted};">Dieses Portal läuft als selbst gehosteter Node-Dienst.</p>
<section style="${PORTAL_CARD_STYLE} margin-top:1rem; padding:1.25rem;">
  <h2 style="margin:0 0 .5rem; font-size:1rem;">Konfiguration</h2>
  <ul style="margin:0; padding-left:1.25rem;">
    <li><strong>PUBLIC_BASE_URL</strong>: ${escapeHtml(baseUrl)}</li>
    <li><strong>PUBLISH_API_KEY</strong>: ${hasKey ? 'gesetzt' : 'nicht gesetzt'}</li>
    <li><strong>STRICT_PUBLISH_AUTH</strong>: ${strictAuth ? 'aktiv' : 'inaktiv'}</li>
    <li><strong>Status der Veröffentlichungsanmeldung</strong>: ${authHealth}</li>
  </ul>
</section>
<section style="${PORTAL_CARD_STYLE} margin-top:1rem; padding:1.25rem;">
  <h2 style="margin:0 0 .5rem; font-size:1rem;">Nächste Schritte</h2>
  <ol style="margin:0; padding-left:1.25rem;">
    <li>Setze <code>PUBLIC_BASE_URL</code> auf deine Domain, zum Beispiel https://offers.example.com.</li>
    <li>Setze <code>PUBLISH_API_KEY</code> und hinterlege den Schlüssel in der Desktop-App.</li>
    <li>Prüfe den Dienst mit <code>GET /health</code>.</li>
  </ol>
</section>`,
      }),
    );
  });

  app.notFound((c) => {
    const accept = c.req.header('accept') ?? '';
    if (!accept.includes('text/html')) return c.json({ error: 'not found' }, 404);
    applySensitiveResponseHeaders(c);
    return c.html(renderPortalErrorPage('unknown'), 404);
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
      return c.html(renderPortalErrorPage('rate_limited', { retryHref: c.req.path }), 429);
    }
    const parsedToken = z.object({ token: z.string().min(16) }).safeParse(c.req.param());
    if (!parsedToken.success) return c.html(renderPortalErrorPage('unknown'), 404);
    const token = parsedToken.data.token;
    const access = await deps.store.getCustomerAccessByTokenHash(sha256(token));
    if (!access) return c.html(renderPortalErrorPage('unknown'), 404);
    if (access.revokedAt) return c.html(renderPortalErrorPage('revoked'), 403);
    if (Date.parse(access.expiresAt) < Date.now()) return c.html(renderPortalErrorPage('expired'), 410);

    const query = historyQuerySchema.parse(c.req.query());
    const result = await deps.store.listDocumentsByCustomerRef({
      customerRef: access.customerRef,
      kind: query.kind,
      limit: query.limit,
      cursor: query.cursor,
    });

    const customerLabel = escapeHtml(access.customerLabel ?? access.customerRef);
    const filteredKind = query.kind === 'all' ? null : query.kind === 'offer' ? 'Angebote' : 'Rechnungen';

    const rows = result.items
      .map((item) => {
        const snap = looksLikeDocSnapshot(item.snapshotJson) ? item.snapshotJson : null;
        const url = `/d/${encodeURIComponent(item.documentId)}`;
        const status = normalizeDocStatus(item);
        return `<tr>
<td style="padding:.625rem .5rem; border-bottom:1px solid ${PORTAL_TOKENS.border};">${item.kind === 'offer' ? 'Angebot' : 'Rechnung'}</td>
<td style="padding:.625rem .5rem; border-bottom:1px solid ${PORTAL_TOKENS.border}; white-space:nowrap;">${renderPortalTextLink(url, snap?.number || (item.kind === 'offer' ? 'Angebot ansehen' : 'Rechnung ansehen'))}</td>
<td style="padding:.625rem .5rem; border-bottom:1px solid ${PORTAL_TOKENS.border};">${escapeHtml(formatDateDe(snap?.date))}</td>
<td style="padding:.625rem .5rem; border-bottom:1px solid ${PORTAL_TOKENS.border}; text-align:right; font-variant-numeric:tabular-nums;">${escapeHtml(formatCurrencyEur(snap?.amount ?? 0))}</td>
<td style="padding:.625rem .5rem; border-bottom:1px solid ${PORTAL_TOKENS.border}; color:${portalStatusColor(status)}; font-weight:600;">${escapeHtml(status)}</td>
</tr>`;
      })
      .join('\n');

    /* A filtered view that comes back empty is not the same as a portal without
       documents, so it names the filter and offers the way back to all of them. */
    const emptyState = filteredKind
      ? `<div style="padding:1.25rem;">
  <h2 style="margin:0; font-size:1rem;">Keine ${filteredKind} in dieser Ansicht</h2>
  <p style="margin:.5rem 0 0; color:${PORTAL_TOKENS.muted};">Für ${customerLabel} ist zurzeit kein Dokument dieser Art hinterlegt. Andere Dokumentarten können vorhanden sein.</p>
  <p style="margin:.75rem 0 0;">${renderPortalTextLink(`/customers/${encodeURIComponent(token)}`, 'Alle Dokumente anzeigen')}</p>
</div>`
      : `<div style="padding:1.25rem;">
  <h2 style="margin:0; font-size:1rem;">Noch keine Dokumente freigegeben</h2>
  <p style="margin:.5rem 0 0; color:${PORTAL_TOKENS.muted};">Für ${customerLabel} wurde bisher kein Angebot und keine Rechnung veröffentlicht.</p>
  <p style="margin:.75rem 0 0;">Sobald der Absender ein Dokument freigibt, erscheint es hier. Erwartest du eines, bitte den Absender um eine neue Freigabe.</p>
</div>`;

    const nextLink = result.nextCursor
      ? `<p style="margin:1rem 0 0;">${renderPortalTextLink(`/customers/${encodeURIComponent(token)}?kind=${encodeURIComponent(query.kind)}&limit=${query.limit}&cursor=${encodeURIComponent(result.nextCursor)}`, 'Weitere laden')}</p>`
      : '';

    return c.html(
      renderPortalPage({
        title: 'Dokumente',
        contentSecurityPolicy: PORTAL_CSP_BASE,
        content: `<h1 style="margin:0 0 .375rem; font-size:1.5rem; letter-spacing:-.01em;">Bisherige Dokumente</h1>
<div style="color:${PORTAL_TOKENS.muted}; margin-bottom:1rem;">${customerLabel}</div>
<section style="${PORTAL_CARD_STYLE} padding:.5rem .875rem;">
  ${
    rows
      ? `<div style="overflow-x:auto;" role="region" aria-label="Dokumente" tabindex="0">
    <table style="width:100%; min-width:34rem; border-collapse:collapse;">
      <thead>
        <tr>
          <th style="text-align:left; padding:.625rem .5rem; border-bottom:1px solid ${PORTAL_TOKENS.border}; font-size:.75rem; letter-spacing:.05em; text-transform:uppercase; color:${PORTAL_TOKENS.muted};">Typ</th>
          <th style="text-align:left; padding:.625rem .5rem; border-bottom:1px solid ${PORTAL_TOKENS.border}; font-size:.75rem; letter-spacing:.05em; text-transform:uppercase; color:${PORTAL_TOKENS.muted};">Nummer</th>
          <th style="text-align:left; padding:.625rem .5rem; border-bottom:1px solid ${PORTAL_TOKENS.border}; font-size:.75rem; letter-spacing:.05em; text-transform:uppercase; color:${PORTAL_TOKENS.muted};">Datum</th>
          <th style="text-align:right; padding:.625rem .5rem; border-bottom:1px solid ${PORTAL_TOKENS.border}; font-size:.75rem; letter-spacing:.05em; text-transform:uppercase; color:${PORTAL_TOKENS.muted};">Betrag</th>
          <th style="text-align:left; padding:.625rem .5rem; border-bottom:1px solid ${PORTAL_TOKENS.border}; font-size:.75rem; letter-spacing:.05em; text-transform:uppercase; color:${PORTAL_TOKENS.muted};">Status</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`
      : emptyState
  }
</section>
${nextLink}`,
      }),
    );
  });

  app.get('/d/:documentId', async (c) => {
    applySensitiveResponseHeaders(c);
    const accept = c.req.header('accept') ?? '';
    const wantsHtml = accept.includes('text/html') || c.req.query('view') === '1';
    const rl = checkRateLimit(c, 'tokenRead');
    if (!rl.ok) {
      c.header('Retry-After', String(rl.retryAfterSec));
      return wantsHtml
        ? c.html(renderPortalErrorPage('rate_limited', { retryHref: c.req.path }), 429)
        : c.json({ error: 'rate_limited' }, 429);
    }
    const parsedDocumentId = z.object({ documentId: z.string().min(8) }).safeParse(c.req.param());
    if (!parsedDocumentId.success) {
      return wantsHtml ? c.html(renderPortalErrorPage('unknown'), 404) : c.json({ error: 'not found' }, 404);
    }
    const documentId = parsedDocumentId.data.documentId;
    const rec = await deps.store.getDocumentById(documentId);
    if (!rec) return wantsHtml ? c.html(renderPortalErrorPage('unknown'), 404) : c.json({ error: 'not found' }, 404);
    const expired = Date.parse(rec.expiresAt) < Date.now();
    const snapshot = looksLikeDocSnapshot(rec.snapshotJson) ? rec.snapshotJson : null;
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
          : documentStatusLabel(snapshot?.status);
    const csrfToken = crypto.randomBytes(24).toString('base64url');
    if (rec.kind === 'offer' && !expired && !rec.decision) {
      c.header(
        'Set-Cookie',
        `csrfToken=${encodeURIComponent(csrfToken)}; Path=/; HttpOnly; SameSite=Strict${publicOrigin?.startsWith('https://') ? '; Secure' : ''}`,
      );
    }
    /* While the decision form is on the page it carries the accent, so the PDF
       link stays a plain link. Without the form, downloading is the main action. */
    const offerCanBeDecided = rec.kind === 'offer' && !expired && !rec.decision;
    const decisionHtml =
      rec.kind !== 'offer'
        ? ''
        : rec.decision
          ? `<div style="margin-top:1rem; padding:.875rem 1rem; border:1px solid ${PORTAL_TOKENS.border}; border-radius:${PORTAL_TOKENS.radiusMd}; background:${PORTAL_TOKENS.surfaceSunken};">
  <div style="font-weight:600; color:${portalStatusColor(statusText)};">${escapeHtml(statusText)}</div>
  <div style="margin-top:.25rem; color:${PORTAL_TOKENS.muted}; font-size:.875rem;">Bestätigt von ${escapeHtml(rec.decision.acceptedName)} am ${escapeHtml(formatDateTimeDe(rec.decision.decidedAt))}</div>
</div>`
          : offerCanBeDecided
            ? `<form method="post" action="/d/${encodeURIComponent(rec.documentId)}/decision" style="margin-top:1rem; padding:1rem; border:1px solid ${PORTAL_TOKENS.border}; border-radius:${PORTAL_TOKENS.radiusMd};" onsubmit="for (const control of this.querySelectorAll('button')) { control.disabled = true; if (control.dataset.label) continue; control.dataset.label = control.textContent || ''; control.textContent = 'Wird gesendet …'; } return true;">
  <div style="display:flex; gap:.75rem; flex-wrap:wrap;">
    <div style="flex:1; min-width:11rem;">
      <label for="acceptedName" style="${PORTAL_LABEL_STYLE}">Name (Pflicht)</label>
      <input id="acceptedName" name="acceptedName" required minlength="1" autocomplete="name" style="${PORTAL_INPUT_STYLE} margin-top:.375rem;" />
    </div>
    <div style="flex:1; min-width:11rem;">
      <label for="acceptedEmail" style="${PORTAL_LABEL_STYLE}">E-Mail (Pflicht)</label>
      <input id="acceptedEmail" name="acceptedEmail" required type="email" autocomplete="email" style="${PORTAL_INPUT_STYLE} margin-top:.375rem;" />
    </div>
  </div>
  <input type="hidden" name="decisionTextVersion" value="v1" />
  <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" />
  <div style="display:flex; gap:.75rem; margin-top:.875rem; flex-wrap:wrap;">
    <button name="decision" value="accepted" style="${PORTAL_PRIMARY_BUTTON_STYLE}">Annehmen</button>
    <button name="decision" value="declined" style="${PORTAL_SECONDARY_BUTTON_STYLE}">Ablehnen</button>
  </div>
  <p style="margin:.75rem 0 0; color:${PORTAL_TOKENS.muted}; font-size:.8125rem;">Die Entscheidung wird einmalig gespeichert. Das Dokument bleibt danach weiter einsehbar.</p>
</form>`
            : '';
    const expiredNotice = expired
      ? `<div style="margin-top:1rem; padding:.75rem .875rem; border:1px solid ${PORTAL_TOKENS.warningBorder}; border-radius:${PORTAL_TOKENS.radiusSm}; background:${PORTAL_TOKENS.warningBg}; color:${PORTAL_TOKENS.warningText};">
  Dieser Link ist abgelaufen. Bitte wende dich an den Absender, wenn du ${rec.kind === 'offer' ? 'das Angebot noch annehmen möchtest' : 'das Dokument erneut brauchst'}.
</div>`
      : '';
    const pdfUrl = rec.pdfKey ? `/d/${encodeURIComponent(rec.documentId)}/pdf` : '';
    const pdfSection = pdfUrl
      ? `<section style="${PORTAL_CARD_STYLE} margin-top:1rem; overflow:hidden;">
  <div style="display:flex; justify-content:space-between; align-items:center; gap:.75rem; flex-wrap:wrap; padding:.875rem 1rem; border-bottom:1px solid ${PORTAL_TOKENS.border};">
    <div style="font-weight:600;">PDF</div>
    ${offerCanBeDecided ? renderPortalTextLink(pdfUrl, 'PDF herunterladen') : renderPortalActionLink(pdfUrl, 'PDF herunterladen')}
  </div>
  <iframe title="Dokument-PDF" src="${escapeHtml(pdfUrl)}" style="width:100%; height:900px; border:0;"></iframe>
</section>`
      : '';
    const snapshotItems = Array.isArray(snapshot?.items) ? snapshot.items : [];
    /* The stored snapshot carries the line items and the tax snapshot; when either
       is missing the card keeps the reader on the PDF instead of inventing figures. */
    const summarySection = `<section style="${PORTAL_CARD_STYLE} margin-top:1rem; padding:1.25rem;">
  <h2 style="margin:0; font-size:1rem;">Zusammenfassung</h2>
  ${
    snapshotItems.length
      ? renderDocumentPositions(snapshotItems)
      : `<div style="margin-top:.625rem; color:${PORTAL_TOKENS.muted}; font-size:.875rem;">Die Positionen stehen in der PDF.</div>`
  }
  ${renderDocumentTotals(snapshot)}
</section>`;
    return c.html(
      renderPortalPage({
        title,
        contentSecurityPolicy: PORTAL_CSP_WITH_FORM,
        content: `<section style="${PORTAL_CARD_STYLE} padding:1.25rem;">
  <h1 style="margin:0 0 .5rem; font-size:1.5rem; letter-spacing:-.01em;">${escapeHtml(title)}</h1>
  <div style="color:${PORTAL_TOKENS.muted}; font-size:.875rem;">Status: <strong style="color:${portalStatusColor(statusText)};">${escapeHtml(statusText)}</strong>${snapshot?.dueDate ? ` · ${rec.kind === 'offer' ? 'Angebot gültig bis' : 'Fällig am'} ${escapeHtml(formatDateDe(snapshot.dueDate))}` : ''} · Link gültig bis ${escapeHtml(formatDateDe(rec.expiresAt))}</div>
  <div style="margin-top:.75rem;">Kunde: <strong>${escapeHtml(snapshot?.client ?? rec.customerLabel ?? '')}</strong></div>
  <div style="margin-top:.5rem; font-size:1.25rem; font-weight:700; font-variant-numeric:tabular-nums;">${escapeHtml(formatCurrencyEur(snapshot?.amount ?? 0))}</div>
  ${expiredNotice}
  ${decisionHtml}
</section>
${summarySection}
${pdfSection}`,
      }),
    );
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
    const decisionAccept = c.req.header('accept') ?? '';
    const decisionWantsHtml = decisionAccept.includes('text/html');
    const decisionError = (condition: PortalDecisionErrorCondition | 'expired', retryHref?: string, status: 403 | 410 = 403) =>
      decisionWantsHtml ? c.html(renderPortalErrorPage(condition, retryHref ? { retryHref } : undefined), status) : c.json({ error: condition }, status);
    const rl = checkRateLimit(c, 'tokenDecision');
    if (!rl.ok) {
      c.header('Retry-After', String(rl.retryAfterSec));
      return c.json({ error: 'rate_limited' }, 429);
    }
    const documentId = z.object({ documentId: z.string().min(8) }).parse(c.req.param()).documentId;
    if (!isAllowedDecisionOrigin(c)) {
      return decisionError('origin_invalid', `/d/${encodeURIComponent(documentId)}`);
    }
    const rec = await deps.store.getDocumentById(documentId);
    if (!rec || rec.kind !== 'offer') return c.json({ error: 'not found' }, 404);
    if (Date.parse(rec.expiresAt) < Date.now()) return decisionError('expired', `/d/${encodeURIComponent(documentId)}`, 410);
    const contentType = c.req.header('content-type') ?? '';
    const isForm =
      contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data');
    const rawBody = isForm ? await c.req.parseBody() : await c.req.json();
    if (isForm) {
      const cookies = parseCookies(c.req.header('cookie'));
      const csrfCookie = String(cookies.csrfToken ?? '').trim();
      const csrfBody = String((rawBody as any).csrfToken ?? '').trim();
      if (!csrfCookie || !csrfBody || csrfCookie !== csrfBody) {
        return decisionError('csrf_invalid', `/d/${encodeURIComponent(documentId)}`);
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
    if (decisionWantsHtml) {
      return c.redirect(`/d/${encodeURIComponent(documentId)}`);
    }
    return c.json({ ok: true, decision });
  });

  app.get('/offers/:token', async (c) => {
    applySensitiveResponseHeaders(c);
    const accept = c.req.header('accept') ?? '';
    const wantsHtml = accept.includes('text/html') || c.req.query('view') === '1';
    const rl = checkRateLimit(c, 'tokenRead');
    if (!rl.ok) {
      c.header('Retry-After', String(rl.retryAfterSec));
      return wantsHtml
        ? c.html(renderPortalErrorPage('rate_limited', { retryHref: c.req.path }), 429)
        : c.json({ error: 'rate_limited' }, 429);
    }
    const parsedToken = z.object({ token: z.string().min(16) }).safeParse(c.req.param());
    if (!parsedToken.success) {
      return wantsHtml ? c.html(renderPortalErrorPage('unknown'), 404) : c.json({ error: 'not found' }, 404);
    }
    const token = parsedToken.data.token;
    const tokenHash = sha256(token);
    const rec = await deps.store.getOfferByTokenHash(tokenHash);
    if (!rec) return wantsHtml ? c.html(renderPortalErrorPage('unknown'), 404) : c.json({ error: 'not found' }, 404);
    const document = await deps.store.getDocumentByTokenHash(tokenHash);
    const expired = Date.parse(rec.expiresAt) < Date.now();

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

    const decidedAt = formatDateTimeDe(decision?.decidedAt);
    const expiresAt = formatDateDe(rec.expiresAt);
    const publishedAt = formatDateDe(rec.publishedAt);

    const itemsHtml =
      snapshot?.items && Array.isArray(snapshot.items) && snapshot.items.length > 0
        ? snapshot.items
            .slice(0, 100)
            .map((it) => {
              const desc = escapeHtml(it.description ?? '');
              const qty = Number.isFinite(Number(it.quantity)) ? Number(it.quantity) : 0;
              const total = formatCurrencyEur(it.total);
              return `<tr>
  <td style="padding:.625rem 0; border-bottom:1px solid ${PORTAL_TOKENS.border};">${desc}</td>
  <td style="padding:.625rem 0; border-bottom:1px solid ${PORTAL_TOKENS.border}; text-align:right; font-variant-numeric:tabular-nums;">${qty}</td>
  <td style="padding:.625rem 0; border-bottom:1px solid ${PORTAL_TOKENS.border}; text-align:right; font-variant-numeric:tabular-nums;">${total}</td>
</tr>`;
            })
            .join('\n')
        : '';

    const decisionBox = decision
      ? `<div style="margin-top:1rem; padding:.875rem 1rem; border:1px solid ${PORTAL_TOKENS.border}; border-radius:${PORTAL_TOKENS.radiusMd}; background:${PORTAL_TOKENS.surfaceSunken};">
  <div style="font-weight:600; color:${portalStatusColor(statusText)};">${escapeHtml(statusText)}</div>
  <div style="margin-top:.25rem; color:${PORTAL_TOKENS.muted}; font-size:.875rem;">Entscheidung am ${escapeHtml(decidedAt)}</div>
  <div style="color:${PORTAL_TOKENS.muted}; font-size:.875rem;">Name: ${escapeHtml(decision.acceptedName)}</div>
  <div style="color:${PORTAL_TOKENS.muted}; font-size:.875rem;">E-Mail: ${escapeHtml(decision.acceptedEmail)}</div>
</div>`
      : '';
    const expiredNotice =
      expired && !decision
        ? `<div style="margin-top:1rem; padding:.75rem .875rem; border:1px solid ${PORTAL_TOKENS.warningBorder}; border-radius:${PORTAL_TOKENS.radiusSm}; background:${PORTAL_TOKENS.warningBg}; color:${PORTAL_TOKENS.warningText};">
  Dieser Link ist abgelaufen. Bitte wende dich an den Absender, wenn du das Angebot noch annehmen möchtest.
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
        : `<form method="post" action="/offers/${encodeURIComponent(token)}/decision" style="margin-top:1rem; padding:1rem; border:1px solid ${PORTAL_TOKENS.border}; border-radius:${PORTAL_TOKENS.radiusMd};" onsubmit="for (const control of this.querySelectorAll('button')) { control.disabled = true; if (control.dataset.label) continue; control.dataset.label = control.textContent || ''; control.textContent = 'Wird gesendet …'; } return true;">
  <div style="display:flex; gap:.75rem; flex-wrap:wrap;">
    <div style="flex:1; min-width:13rem;">
      <label for="offerAcceptedName" style="${PORTAL_LABEL_STYLE}">Name (Pflicht)</label>
      <input id="offerAcceptedName" name="acceptedName" required minlength="1" autocomplete="name" style="${PORTAL_INPUT_STYLE} margin-top:.375rem;" />
    </div>
    <div style="flex:1; min-width:13rem;">
      <label for="offerAcceptedEmail" style="${PORTAL_LABEL_STYLE}">E-Mail (Pflicht)</label>
      <input id="offerAcceptedEmail" name="acceptedEmail" required minlength="3" autocomplete="email" type="email" style="${PORTAL_INPUT_STYLE} margin-top:.375rem;" />
    </div>
  </div>
  <input type="hidden" name="decisionTextVersion" value="v1" />
  <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}" />
  <div style="display:flex; gap:.75rem; margin-top:.875rem; flex-wrap:wrap;">
    <button name="decision" value="accepted" style="${PORTAL_PRIMARY_BUTTON_STYLE}">Angebot annehmen</button>
    <button name="decision" value="declined" style="${PORTAL_SECONDARY_BUTTON_STYLE}">Ablehnen</button>
  </div>
  <p style="margin:.75rem 0 0; color:${PORTAL_TOKENS.muted}; font-size:.8125rem;">Die Entscheidung wird einmalig gespeichert. Das Angebot bleibt danach weiter einsehbar.</p>
</form>`;

    return c.html(
      renderPortalPage({
        title,
        contentSecurityPolicy: PORTAL_CSP_WITH_FORM,
        content: `<div style="display:flex; justify-content:space-between; gap:.75rem; flex-wrap:wrap; align-items:flex-end;">
  <div>
    <div style="${PORTAL_LABEL_STYLE}">Angebot</div>
    <h1 style="margin:.375rem 0 0; font-size:1.5rem; letter-spacing:-.01em;">${escapeHtml(snapshot?.number ?? 'Angebot')}</h1>
    <div style="margin-top:.5rem; color:${PORTAL_TOKENS.muted};">Kunde: <strong style="color:${PORTAL_TOKENS.foreground};">${escapeHtml(snapshot?.client ?? '')}</strong></div>
  </div>
  <div style="${PORTAL_CARD_STYLE} padding:.875rem 1rem;">
    <div style="${PORTAL_LABEL_STYLE}">Status</div>
    <div style="margin-top:.375rem; font-size:1rem; font-weight:600; color:${portalStatusColor(statusText)};">${escapeHtml(statusText)}</div>
    <div style="margin-top:.25rem; font-size:.8125rem; color:${PORTAL_TOKENS.muted};">Veröffentlicht: ${escapeHtml(publishedAt)} · Link gültig bis ${escapeHtml(expiresAt)}</div>
  </div>
</div>

<section style="${PORTAL_CARD_STYLE} margin-top:1rem; padding:1.25rem;">
  <div style="display:flex; justify-content:space-between; align-items:center; gap:.75rem; flex-wrap:wrap;">
    <div style="font-weight:600;">Zusammenfassung</div>
    <div style="font-size:1.25rem; font-weight:700; font-variant-numeric:tabular-nums;">${escapeHtml(formatCurrencyEur(snapshot?.amount))}</div>
  </div>
  ${
            itemsHtml
              ? `<table style="width:100%; border-collapse:collapse; margin-top:.625rem;">
  <thead>
    <tr>
      <th style="text-align:left; font-size:.75rem; letter-spacing:.05em; text-transform:uppercase; color:${PORTAL_TOKENS.muted}; padding:.5rem 0; border-bottom:1px solid ${PORTAL_TOKENS.border};">Position</th>
      <th style="text-align:right; font-size:.75rem; letter-spacing:.05em; text-transform:uppercase; color:${PORTAL_TOKENS.muted}; padding:.5rem 0; border-bottom:1px solid ${PORTAL_TOKENS.border};">Menge</th>
      <th style="text-align:right; font-size:.75rem; letter-spacing:.05em; text-transform:uppercase; color:${PORTAL_TOKENS.muted}; padding:.5rem 0; border-bottom:1px solid ${PORTAL_TOKENS.border};">Summe</th>
    </tr>
  </thead>
  <tbody>${itemsHtml}</tbody>
</table>`
              : `<div style="margin-top:.625rem; color:${PORTAL_TOKENS.muted}; font-size:.875rem;">Die Positionen stehen in der PDF.</div>`
          }

  ${expiredNotice}
  ${decisionBox}
  ${actionForm}
</section>

${
  pdfUrl
    ? `<section style="${PORTAL_CARD_STYLE} margin-top:1rem; overflow:hidden;">
  <div style="display:flex; justify-content:space-between; align-items:center; gap:.75rem; flex-wrap:wrap; padding:.875rem 1rem; border-bottom:1px solid ${PORTAL_TOKENS.border};">
    <div style="font-weight:600;">PDF</div>
    ${expired || decision ? renderPortalActionLink(pdfUrl, 'PDF herunterladen') : renderPortalTextLink(pdfUrl, 'PDF herunterladen')}
  </div>
  <iframe title="Angebots-PDF" src="${escapeHtml(pdfUrl)}" style="width:100%; height:900px; border:0;"></iframe>
</section>`
    : `<section style="${PORTAL_CARD_STYLE} margin-top:1rem; padding:1.25rem;">
  <div style="font-weight:600;">PDF</div>
  <div style="margin-top:.5rem; color:${PORTAL_TOKENS.muted}; font-size:.875rem;">Für dieses Angebot liegt keine PDF vor. Bitte wende dich an den Absender, wenn du das Dokument als Datei brauchst.</div>
</section>`
}

<footer style="margin:1.25rem 0 0; color:${PORTAL_TOKENS.muted}; font-size:.75rem;">
  Angebotsportal · Zugriff per Link · ${escapeHtml(statusText)}
</footer>`,
      }),
    );
  });

  app.get('/invoices/:token', async (c) => {
    applySensitiveResponseHeaders(c);
    const accept = c.req.header('accept') ?? '';
    const wantsHtml = accept.includes('text/html') || c.req.query('view') === '1';
    const rl = checkRateLimit(c, 'tokenRead');
    if (!rl.ok) {
      c.header('Retry-After', String(rl.retryAfterSec));
      return wantsHtml
        ? c.html(renderPortalErrorPage('rate_limited', { retryHref: c.req.path }), 429)
        : c.json({ error: 'rate_limited' }, 429);
    }
    const parsedToken = z.object({ token: z.string().min(16) }).safeParse(c.req.param());
    if (!parsedToken.success) {
      return wantsHtml ? c.html(renderPortalErrorPage('unknown'), 404) : c.json({ error: 'not found' }, 404);
    }
    const token = parsedToken.data.token;
    const rec = await deps.store.getInvoiceByTokenHash(sha256(token));
    if (!rec) return wantsHtml ? c.html(renderPortalErrorPage('unknown'), 404) : c.json({ error: 'not found' }, 404);
    const document = await deps.store.getDocumentByTokenHash(sha256(token));
    const expired = Date.parse(rec.expiresAt) < Date.now();

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
  <td style="padding:.625rem 0; border-bottom:1px solid ${PORTAL_TOKENS.border};">${desc}</td>
  <td style="padding:.625rem 0; border-bottom:1px solid ${PORTAL_TOKENS.border}; text-align:right; font-variant-numeric:tabular-nums;">${qty}</td>
  <td style="padding:.625rem 0; border-bottom:1px solid ${PORTAL_TOKENS.border}; text-align:right; font-variant-numeric:tabular-nums;">${total}</td>
</tr>`;
            })
            .join('\n')
        : '';

    const invoiceTitle = snapshot?.number ? `Rechnung ${snapshot.number}` : 'Rechnung';
    return c.html(
      renderPortalPage({
        title: invoiceTitle,
        contentSecurityPolicy: PORTAL_CSP_WITH_FORM,
        content: `<div style="display:flex; justify-content:space-between; gap:.75rem; flex-wrap:wrap; align-items:flex-end;">
  <div>
    <div style="${PORTAL_LABEL_STYLE}">Rechnung</div>
    <h1 style="margin:.375rem 0 0; font-size:1.5rem; letter-spacing:-.01em;">${escapeHtml(snapshot?.number ?? 'Rechnung')}</h1>
    <div style="margin-top:.5rem; color:${PORTAL_TOKENS.muted};">Kunde: <strong style="color:${PORTAL_TOKENS.foreground};">${escapeHtml(snapshot?.client ?? '')}</strong></div>
  </div>
</div>
<section style="${PORTAL_CARD_STYLE} margin-top:1rem; padding:1.25rem;">
  <div style="display:flex; justify-content:space-between; align-items:center; gap:.75rem; flex-wrap:wrap;">
    <div style="font-weight:600;">Zusammenfassung</div>
    <div style="font-size:1.25rem; font-weight:700; font-variant-numeric:tabular-nums;">${escapeHtml(formatCurrencyEur(snapshot?.amount))}</div>
  </div>
  ${
    itemsHtml
      ? `<table style="width:100%; border-collapse:collapse; margin-top:.625rem;">
  <thead>
    <tr>
      <th style="text-align:left; font-size:.75rem; letter-spacing:.05em; text-transform:uppercase; color:${PORTAL_TOKENS.muted}; padding:.5rem 0; border-bottom:1px solid ${PORTAL_TOKENS.border};">Position</th>
      <th style="text-align:right; font-size:.75rem; letter-spacing:.05em; text-transform:uppercase; color:${PORTAL_TOKENS.muted}; padding:.5rem 0; border-bottom:1px solid ${PORTAL_TOKENS.border};">Menge</th>
      <th style="text-align:right; font-size:.75rem; letter-spacing:.05em; text-transform:uppercase; color:${PORTAL_TOKENS.muted}; padding:.5rem 0; border-bottom:1px solid ${PORTAL_TOKENS.border};">Summe</th>
    </tr>
  </thead>
  <tbody>${itemsHtml}</tbody>
</table>`
      : `<div style="margin-top:.625rem; color:${PORTAL_TOKENS.muted}; font-size:.875rem;">Die Positionen stehen in der PDF.</div>`
  }
</section>
${
  pdfUrl
    ? `<section style="${PORTAL_CARD_STYLE} margin-top:1rem; overflow:hidden;">
  <div style="display:flex; justify-content:space-between; align-items:center; gap:.75rem; flex-wrap:wrap; padding:.875rem 1rem; border-bottom:1px solid ${PORTAL_TOKENS.border};">
    <div style="font-weight:600;">PDF</div>
    ${renderPortalActionLink(pdfUrl, 'PDF herunterladen')}
  </div>
  <iframe title="Rechnungs-PDF" src="${escapeHtml(pdfUrl)}" style="width:100%; height:900px; border:0;"></iframe>
</section>`
    : `<section style="${PORTAL_CARD_STYLE} margin-top:1rem; padding:1.25rem;">
  <div style="font-weight:600;">PDF</div>
  <div style="margin-top:.5rem; color:${PORTAL_TOKENS.muted}; font-size:.875rem;">Für diese Rechnung liegt keine PDF vor. Bitte wende dich an den Absender, wenn du das Dokument als Datei brauchst.</div>
</section>`
}`,
      }),
    );
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
    const token = z.object({ token: z.string().min(16) }).parse(c.req.param()).token;
    const legacyAccept = c.req.header('accept') ?? '';
    const legacyWantsHtml = legacyAccept.includes('text/html');
    const legacyError = (condition: PortalDecisionErrorCondition | 'expired', retryHref?: string, status: 403 | 410 = 403) =>
      legacyWantsHtml ? c.html(renderPortalErrorPage(condition, retryHref ? { retryHref } : undefined), status) : c.json({ error: condition }, status);
    const rl = checkRateLimit(c, 'tokenDecision');
    if (!rl.ok) {
      c.header('Retry-After', String(rl.retryAfterSec));
      return c.json({ error: 'rate_limited' }, 429);
    }
    const tokenHash = sha256(token);
    const rec = await deps.store.getOfferByTokenHash(tokenHash);
    if (!rec) return c.json({ error: 'not found' }, 404);
    const document = await deps.store.getDocumentByTokenHash(tokenHash);

    const expired = Date.parse(rec.expiresAt) < Date.now();
    if (expired) return legacyError('expired', `/offers/${encodeURIComponent(token)}`, 410);

    const contentType = c.req.header('content-type') ?? '';
    const isForm =
      contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data');
    if (!isAllowedDecisionOrigin(c)) {
      return legacyError('origin_invalid', `/offers/${encodeURIComponent(token)}`);
    }
    const rawBody = isForm ? await c.req.parseBody() : await c.req.json();
    if (isForm) {
      const cookies = parseCookies(c.req.header('cookie'));
      const csrfCookie = String(cookies.csrfToken ?? '').trim();
      const csrfBody = String((rawBody as any).csrfToken ?? '').trim();
      if (!csrfCookie || !csrfBody || csrfCookie !== csrfBody) {
        return legacyError('csrf_invalid', `/offers/${encodeURIComponent(token)}`);
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

    if (legacyWantsHtml) {
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
