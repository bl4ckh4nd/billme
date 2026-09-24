import type { EmbeddedConnectionResult } from '@billme/desktop-contracts/embeddedConnection';
import { exportPdf } from './pdfExport';

type SecretKey = 'smtp.password' | 'resend.apiKey' | 'portal.apiKey';

/** Keychain secrets and PDF rendering for the embedded runtime's mail delivery. */
export const createDesktopIntegration = (deps: {
  secrets: { get: (key: string) => Promise<string | null> };
  getUserDataPath: () => string;
}) => ({
  getSecret: (key: SecretKey) => deps.secrets.get(key),
  renderDocumentPdf: (args: { kind: 'invoice' | 'offer'; id: string; suggestedName: string }) =>
    exportPdf({ ...args, userDataPath: deps.getUserDataPath() }),
});

type TickLogger = {
  info?: (scope: string, message: string, meta?: unknown) => void;
  error?: (scope: string, message: string, error?: Error) => void;
};

/**
 * Desktop stand-in for apps/server-worker: asks the embedded runtime once a
 * minute to run whatever recurring, dunning, mail and portal work is due.
 */
export const startEmbeddedAutomationTicker = (options: {
  product: 'lite' | 'pro';
  connection: () => EmbeddedConnectionResult;
  intervalMs?: number;
  logger?: TickLogger;
}): (() => Promise<void>) => {
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  const run = async () => {
    const connection = options.connection();
    if (!connection) return;
    try {
      const response = await fetch(`${connection.baseUrl}/api/v1/${options.product}/automation/tick`, {
        method: 'POST',
        // Same local-token header the renderer's embedded HTTP client sends.
        headers: { 'x-billme-local-token': connection.token },
      });
      const result = (await response.json()) as { errors?: string[] };
      if (!response.ok) throw new Error(`automation/tick HTTP ${response.status}`);
      const errors = (result.errors ?? []).filter((message) => !message.startsWith('E-Mail-Versand: Kein E-Mail-Anbieter'));
      if (errors.length) options.logger?.error?.('Automation', errors.join(' | '));
    } catch (error) {
      options.logger?.error?.('Automation', 'Tick failed', error as Error);
    }
  };
  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = run().finally(() => { inFlight = null; });
    await inFlight;
  };
  const first = setTimeout(() => void tick(), 15_000);
  const timer = setInterval(() => void tick(), options.intervalMs ?? 60_000);
  // Resolves once a running tick finished (bounded), so shutdown never closes the backend under it.
  return async () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
    if (inFlight) await Promise.race([inFlight, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  };
};
