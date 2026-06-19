import crypto from 'crypto';
import { z } from 'zod';
import type {
  CustomerAccessTokenRecord,
  InvoiceRecord,
  OfferRecord,
  PortalDocumentListItem,
} from './storage/types';

export type PortalConfig = {
  publishApiKey?: string;
  publicBaseUrl?: string;
  requirePublishApiKey?: boolean;
};

export const publishJsonSchema = z.object({
  token: z.string().min(16),
  snapshot: z.unknown(),
  expiresAt: z.string().optional(),
  customerRef: z.string().min(1).optional(),
  customerLabel: z.string().optional(),
});

export const customerAccessLinkSchema = z.object({
  customerRef: z.string().min(1),
  customerLabel: z.string().optional(),
  expiresInDays: z.coerce.number().int().positive().max(365).optional(),
});

export const historyQuerySchema = z.object({
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

export type PublishJsonBody = z.infer<typeof publishJsonSchema>;
export type CustomerAccessLinkBody = z.infer<typeof customerAccessLinkSchema>;

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const nowIso = () => new Date().toISOString();
export const randomPortalToken = () => crypto.randomBytes(24).toString('base64url');
export const tokenHashPrefix = (token: string) => sha256(token).slice(0, 10);

export const expiresInDaysFromNow = (days: number): string =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

export const resolvePublicOrigin = (config: PortalConfig): string | null => {
  const base = config.publicBaseUrl?.trim();
  if (!base) return null;
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
};

export const isAllowedOrigin = (
  publicOrigin: string | null,
  origin: string | null | undefined,
  referer: string | null | undefined,
): boolean => {
  if (!publicOrigin) return true;
  if (origin && origin === publicOrigin) return true;
  if (!referer) return false;
  try {
    return new URL(referer).origin === publicOrigin;
  } catch {
    return false;
  }
};

export const isExpired = (expiresAt: string): boolean => Date.parse(expiresAt) < Date.now();

export const checkPublishAuth = (
  config: PortalConfig,
  apiKeyHeader: string | null | undefined,
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
  if (apiKeyHeader && apiKeyHeader === publishApiKey) return { ok: true };

  return { ok: false, status: 401, error: 'unauthorized' };
};

export const parseCookies = (header: string | null | undefined): Record<string, string> => {
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

export const looksLikeDocSnapshot = (
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

export const inferCustomerRef = (snapshot: unknown, fallbackToken: string): string => {
  if (typeof snapshot !== 'object' || snapshot === null) return `anon:${sha256(fallbackToken).slice(0, 16)}`;
  const maybeClientId = (snapshot as Record<string, unknown>).clientId;
  if (typeof maybeClientId === 'string' && maybeClientId.trim()) return `client:${maybeClientId.trim()}`;
  const maybeEmail = (snapshot as Record<string, unknown>).clientEmail;
  if (typeof maybeEmail === 'string' && maybeEmail.trim()) {
    return `email:${sha256(maybeEmail.trim().toLowerCase())}`;
  }
  return `anon:${sha256(fallbackToken).slice(0, 16)}`;
};

export const inferCustomerLabel = (snapshot: unknown): string | null => {
  if (typeof snapshot !== 'object' || snapshot === null) return null;
  const value = (snapshot as Record<string, unknown>).client;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

export const normalizeDocStatus = (item: PortalDocumentListItem) => {
  const expired = isExpired(item.expiresAt);
  if (item.kind === 'offer') {
    if (expired) return 'Abgelaufen';
    if (item.decision?.decision === 'accepted') return 'Angenommen';
    if (item.decision?.decision === 'declined') return 'Abgelehnt';
    return 'Offen';
  }
  const snap = looksLikeDocSnapshot(item.snapshotJson) ? item.snapshotJson : null;
  return snap?.status ? String(snap.status) : expired ? 'Abgelaufen' : 'Offen';
};

export const buildCustomerAccessTokenRecord = (params: {
  token: string;
  customerRef: string;
  customerLabel?: string | null;
  createdAt: string;
  expiresAt: string;
}): CustomerAccessTokenRecord => ({
  tokenHash: sha256(params.token),
  customerRef: params.customerRef,
  customerLabel: params.customerLabel ?? null,
  createdAt: params.createdAt,
  expiresAt: params.expiresAt,
  revokedAt: null,
});

export const buildPublishedOfferRecord = (params: {
  token: string;
  snapshot: unknown;
  publishedAt: string;
  expiresAt: string;
  customerRef?: string;
  customerLabel?: string | null;
  pdfKey?: string | null;
}): OfferRecord => ({
  tokenHash: sha256(params.token),
  publishedAt: params.publishedAt,
  expiresAt: params.expiresAt,
  snapshotJson: params.snapshot,
  customerRef: params.customerRef ?? inferCustomerRef(params.snapshot, params.token),
  customerLabel: params.customerLabel ?? inferCustomerLabel(params.snapshot),
  pdfKey: params.pdfKey ?? null,
  decision: null,
});

export const buildPublishedInvoiceRecord = (params: {
  token: string;
  snapshot: unknown;
  publishedAt: string;
  expiresAt: string;
  customerRef?: string;
  customerLabel?: string | null;
  pdfKey?: string | null;
}): InvoiceRecord => ({
  tokenHash: sha256(params.token),
  publishedAt: params.publishedAt,
  expiresAt: params.expiresAt,
  snapshotJson: params.snapshot,
  customerRef: params.customerRef ?? inferCustomerRef(params.snapshot, params.token),
  customerLabel: params.customerLabel ?? inferCustomerLabel(params.snapshot),
  pdfKey: params.pdfKey ?? null,
});
