export type PortalDecision = {
  decidedAt: string;
  decision: 'accepted' | 'declined';
  acceptedName: string;
  acceptedEmail: string;
  decisionTextVersion: string;
};

export type PortalOfferStatus = {
  decision: PortalDecision | null;
};

type ErrorCategory = 'network' | 'client' | 'server' | 'timeout';

interface PortalError extends Error {
  category: ErrorCategory;
  statusCode?: number;
  userMessage: string;
}

interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  shouldRetry: (error: PortalError) => boolean;
}

const normalizeBaseUrl = (baseUrl: string): string => {
  const trimmed = baseUrl.trim();
  if (!trimmed) throw new Error('Portal baseUrl is required');
  return trimmed.replace(/\/+$/, '');
};

const createPortalError = (error: unknown, res?: Response): PortalError => {
  // Network failure (no response)
  if (error instanceof TypeError && error.message.includes('fetch')) {
    const err = new Error('Portal nicht erreichbar. Bitte überprüfen Sie Ihre Internetverbindung.') as PortalError;
    err.category = 'network';
    err.userMessage = 'Portal nicht erreichbar. Bitte überprüfen Sie Ihre Internetverbindung.';
    return err;
  }

  // Timeout
  if (error instanceof Error && error.name === 'AbortError') {
    const err = new Error('Portal antwortet nicht (Timeout).') as PortalError;
    err.category = 'timeout';
    err.userMessage = 'Portal antwortet nicht (Timeout).';
    return err;
  }

  // HTTP error with response
  if (res && !res.ok) {
    const statusCode = res.status;
    let userMessage = '';

    if (statusCode === 401) {
      userMessage = 'API-Key ungültig. Bitte überprüfen Sie die Portal-Einstellungen.';
    } else if (statusCode >= 400 && statusCode < 500) {
      userMessage = `Anfrage ungültig (${statusCode}). Bitte kontaktieren Sie den Support.`;
    } else if (statusCode >= 500) {
      userMessage = `Portal hat einen internen Fehler (${statusCode}). Bitte versuchen Sie es später erneut.`;
    } else {
      userMessage = `Portal-Fehler (${statusCode}).`;
    }

    const err = new Error(userMessage) as PortalError;
    err.category = statusCode >= 500 ? 'server' : 'client';
    err.statusCode = statusCode;
    err.userMessage = userMessage;
    return err;
  }

  // Unknown error
  const err = new Error('Unbekannter Fehler beim Portal-Zugriff.') as PortalError;
  err.category = 'network';
  err.userMessage = 'Unbekannter Fehler beim Portal-Zugriff.';
  return err;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchWithRetry = async <T>(
  fn: (signal: AbortSignal) => Promise<T>,
  config: RetryConfig,
): Promise<T> => {
  let lastError: PortalError | null = null;
  let delayMs = config.initialDelayMs;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

      try {
        const result = await fn(controller.signal);
        clearTimeout(timeoutId);
        return result;
      } catch (err) {
        clearTimeout(timeoutId);
        throw err;
      }
    } catch (err) {
      const portalError = createPortalError(err);
      lastError = portalError;

      // Don't retry client errors (4xx)
      if (!config.shouldRetry(portalError)) {
        throw portalError;
      }

      // Last attempt - throw
      if (attempt === config.maxAttempts) {
        throw portalError;
      }

      // Log retry attempt
      console.log(`Portal request failed (attempt ${attempt}/${config.maxAttempts}), retrying in ${delayMs}ms...`, portalError.userMessage);

      // Wait before retry
      await sleep(delayMs);

      // Exponential backoff
      delayMs = Math.min(delayMs * 2, config.maxDelayMs);
    }
  }

  throw lastError || new Error('Retry failed');
};

const requireOk = async (res: Response) => {
  if (res.ok) return;
  let bodyText = '';
  try {
    bodyText = await res.text();
  } catch {
    // ignore
  }
  throw createPortalError(new Error(`Portal request failed (${res.status} ${res.statusText})${bodyText ? `: ${bodyText}` : ''}`), res);
};

export const portalClient = {
  health: async (baseUrl: string) => {
    const url = `${normalizeBaseUrl(baseUrl)}/health`;
    return fetchWithRetry(
      async (signal) => {
        const res = await fetch(url, { method: 'GET', signal });
        await requireOk(res);
        return (await res.json()) as { ok: boolean; ts: string };
      },
      {
        maxAttempts: 2,
        initialDelayMs: 1000,
        maxDelayMs: 10000,
        shouldRetry: (err) => err.category === 'network' || err.category === 'server' || err.category === 'timeout',
      },
    );
  },

  publishOffer: async (params: {
    baseUrl: string;
    apiKey?: string | null;
    token: string;
    snapshot: unknown;
    customerRef: string;
    customerLabel?: string;
    expiresAt?: string;
    pdfBytes?: Uint8Array | null;
  }) => {
    const baseUrl = normalizeBaseUrl(params.baseUrl);
    const url = `${baseUrl}/offers`;
    const headers: Record<string, string> = {};
    if (params.apiKey) headers['x-api-key'] = params.apiKey;

    return fetchWithRetry(
      async (signal) => {
        // JSON-only (default)
        if (!params.pdfBytes) {
          const res = await fetch(url, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({
              token: params.token,
              snapshot: params.snapshot,
              customerRef: params.customerRef,
              customerLabel: params.customerLabel,
              expiresAt: params.expiresAt,
            }),
            signal,
          });
          await requireOk(res);
          return {
            ok: true as const,
            token: params.token,
            publicUrl: `${baseUrl}/offers/${params.token}`,
          };
        }

        // Multipart (snapshot + pdf)
        const form = new FormData();
        form.set('token', params.token);
        form.set('snapshot', JSON.stringify(params.snapshot ?? null));
        if (params.expiresAt) form.set('expiresAt', params.expiresAt);
        form.set('customerRef', params.customerRef);
        if (params.customerLabel) form.set('customerLabel', params.customerLabel);
        const blob = new Blob([params.pdfBytes], { type: 'application/pdf' });
        form.set('pdf', blob, 'offer.pdf');

        const res = await fetch(url, { method: 'POST', headers, body: form, signal });
        await requireOk(res);
        return {
          ok: true as const,
          token: params.token,
          publicUrl: `${baseUrl}/offers/${params.token}`,
        };
      },
      {
        maxAttempts: 2,
        initialDelayMs: 1000,
        maxDelayMs: 10000,
        shouldRetry: (err) => err.category === 'network' || err.category === 'server' || err.category === 'timeout',
      },
    );
  },

  publishInvoice: async (params: {
    baseUrl: string;
    apiKey?: string | null;
    token: string;
    snapshot: unknown;
    customerRef: string;
    customerLabel?: string;
    expiresAt?: string;
    pdfBytes?: Uint8Array | null;
  }) => {
    const baseUrl = normalizeBaseUrl(params.baseUrl);
    const url = `${baseUrl}/invoices`;
    const headers: Record<string, string> = {};
    if (params.apiKey) headers['x-api-key'] = params.apiKey;

    return fetchWithRetry(
      async (signal) => {
        if (!params.pdfBytes) {
          const res = await fetch(url, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({
              token: params.token,
              snapshot: params.snapshot,
              customerRef: params.customerRef,
              customerLabel: params.customerLabel,
              expiresAt: params.expiresAt,
            }),
            signal,
          });
          await requireOk(res);
          return {
            ok: true as const,
            token: params.token,
            publicUrl: `${baseUrl}/invoices/${params.token}`,
          };
        }

        const form = new FormData();
        form.set('token', params.token);
        form.set('snapshot', JSON.stringify(params.snapshot ?? null));
        form.set('customerRef', params.customerRef);
        if (params.customerLabel) form.set('customerLabel', params.customerLabel);
        if (params.expiresAt) form.set('expiresAt', params.expiresAt);
        const blob = new Blob([params.pdfBytes], { type: 'application/pdf' });
        form.set('pdf', blob, 'invoice.pdf');

        const res = await fetch(url, { method: 'POST', headers, body: form, signal });
        await requireOk(res);
        return {
          ok: true as const,
          token: params.token,
          publicUrl: `${baseUrl}/invoices/${params.token}`,
        };
      },
      {
        maxAttempts: 2,
        initialDelayMs: 1000,
        maxDelayMs: 10000,
        shouldRetry: (err) => err.category === 'network' || err.category === 'server' || err.category === 'timeout',
      },
    );
  },

  createCustomerAccessLink: async (params: {
    baseUrl: string;
    apiKey?: string | null;
    customerRef: string;
    customerLabel?: string;
    expiresInDays?: number;
  }) => {
    const url = `${normalizeBaseUrl(params.baseUrl)}/customers/access-links`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (params.apiKey) headers['x-api-key'] = params.apiKey;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        customerRef: params.customerRef,
        customerLabel: params.customerLabel,
        expiresInDays: params.expiresInDays,
      }),
    });
    await requireOk(res);
    return (await res.json()) as { ok: true; token: string; publicUrl: string; expiresAt: string };
  },

  rotateCustomerAccessLink: async (params: {
    baseUrl: string;
    apiKey?: string | null;
    customerRef: string;
    customerLabel?: string;
    expiresInDays?: number;
  }) => {
    const url = `${normalizeBaseUrl(params.baseUrl)}/customers/access-links/rotate`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (params.apiKey) headers['x-api-key'] = params.apiKey;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        customerRef: params.customerRef,
        customerLabel: params.customerLabel,
        expiresInDays: params.expiresInDays,
      }),
    });
    await requireOk(res);
    return (await res.json()) as { ok: true; token: string; publicUrl: string; expiresAt: string };
  },

  getOfferStatus: async (baseUrl: string, token: string): Promise<PortalOfferStatus> => {
    const url = `${normalizeBaseUrl(baseUrl)}/offers/${encodeURIComponent(token)}/status`;
    return fetchWithRetry(
      async (signal) => {
        const res = await fetch(url, { method: 'GET', signal });
        await requireOk(res);
        return (await res.json()) as PortalOfferStatus;
      },
      {
        maxAttempts: 3,
        initialDelayMs: 1000,
        maxDelayMs: 10000,
        shouldRetry: (err) => err.category === 'network' || err.category === 'server' || err.category === 'timeout',
      },
    );
  },
};
