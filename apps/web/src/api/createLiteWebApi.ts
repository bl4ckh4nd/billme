import { createLiteHttpBillmeApi, type LiteHttpBillmeApi } from '@billme/desktop-services/liteHttpApi';
import type { IpcInvoke } from '@billme/desktop-contracts/api';
import { ipcRoutes, type IpcArgs, type IpcResult, type IpcRouteKey } from '@billme/desktop-contracts/contract';

export type LiteWebApiOptions = {
  baseUrl: string;
  token: string;
  onAuthFailure?: () => void;
  onRequestClose?: () => void;
};

export type LiteWebBillmeApi = LiteHttpBillmeApi;

const UNSUPPORTED_MESSAGE = 'Diese Funktion ist in Billme Lite im Browser noch nicht verfügbar.';
const PDF_UNSUPPORTED_MESSAGE = 'Der PDF-Export ist in Billme Lite im Browser noch nicht verfügbar.';
const SECRET_UNSUPPORTED_MESSAGE = 'Die sichere Ablage von Zugangsdaten ist in Billme Lite im Browser nicht verfügbar.';

const parseResult = <K extends IpcRouteKey>(key: K, value: unknown): IpcResult<K> => {
  return ipcRoutes[key].result.parse(value) as IpcResult<K>;
};

const unsupported = (detail?: string): never => {
  throw new Error(detail ?? UNSUPPORTED_MESSAGE);
};

const createBrowserFallback = (onRequestClose?: () => void): IpcInvoke => async (key, rawArgs) => {
  const args = ipcRoutes[key].args.parse(rawArgs) as IpcArgs<typeof key>;

  switch (key) {
    case 'projects:list':
      return parseResult(key, []);
    case 'projects:get':
      return parseResult(key, null);
    case 'articles:list':
      return parseResult(key, []);
    case 'accounts:list':
      return parseResult(key, []);
    case 'templates:list':
      return parseResult(key, []);
    case 'templates:active':
      return parseResult(key, null);
    case 'audit:verify':
    case 'audit:exportCsv':
    case 'finance:importPreview':
    case 'finance:importCommit':
    case 'finance:getImportBatchDetails':
    case 'finance:rollbackImportBatch':
    case 'eur:upsertRule':
    case 'eur:deleteRule':
    case 'eur:exportPdf':
    case 'portal:publishOffer':
    case 'portal:publishInvoice':
    case 'portal:syncOfferStatus':
    case 'portal:createCustomerAccessLink':
    case 'portal:rotateCustomerAccessLink':
    case 'db:backup':
    case 'db:restore':
    case 'transactions:findMatches':
    case 'transactions:link':
    case 'transactions:unlink':
    case 'projects:upsert':
    case 'projects:archive':
    case 'articles:upsert':
    case 'articles:delete':
    case 'accounts:upsert':
    case 'accounts:delete':
    case 'templates:upsert':
    case 'templates:delete':
    case 'templates:setActive':
      return unsupported();
    case 'pdf:export':
      return unsupported(PDF_UNSUPPORTED_MESSAGE);
    case 'window:minimize':
      return parseResult(key, { ok: true as const });
    case 'window:toggleMaximize':
      if (document.fullscreenElement) {
        await document.exitFullscreen().catch(() => undefined);
      } else if (typeof document.documentElement.requestFullscreen === 'function') {
        await document.documentElement.requestFullscreen().catch(() => undefined);
      }
      return parseResult(key, { ok: true as const });
    case 'window:close':
      onRequestClose?.();
      return parseResult(key, { ok: true as const });
    case 'window:isMaximized':
      return parseResult(key, { isMaximized: Boolean(document.fullscreenElement) });
    case 'shell:openPath':
    case 'shell:openExportsDir':
      return parseResult(key, { ok: true as const });
    case 'shell:openExternal': {
      const parsed = args as IpcArgs<'shell:openExternal'>;
      window.open(parsed.url, '_blank', 'noopener,noreferrer');
      return parseResult(key, { ok: true as const });
    }
    case 'dialog:pickCsv':
      return parseResult(key, { path: null });
    case 'finance:listImportBatches':
      return parseResult(key, []);
    case 'secrets:get':
      return parseResult(key, null);
    case 'secrets:set':
    case 'secrets:delete':
      return unsupported(SECRET_UNSUPPORTED_MESSAGE);
    case 'secrets:has':
      return parseResult(key, false);
    case 'email:send':
    case 'email:testConfig':
      return parseResult(key, { success: false, error: 'Der E-Mail-Versand ist in Billme Lite im Browser noch nicht verfügbar.' });
    case 'transactions:list':
      return parseResult(key, []);
    case 'dunning:manualRun':
      return parseResult(key, { success: false, error: 'Mahnläufe können in Billme Lite im Browser noch nicht manuell gestartet werden.' });
    case 'dunning:getInvoiceStatus':
      return parseResult(key, { currentLevel: 0, daysOverdue: 0, totalFeesApplied: 0, history: [] });
    case 'recurring:manualRun':
      return parseResult(key, { success: false, error: 'Wiederkehrende Rechnungen können in Billme Lite im Browser noch nicht manuell gestartet werden.' });
    case 'updater:getStatus':
      return parseResult(key, { status: 'idle' });
    case 'updater:downloadUpdate':
    case 'updater:quitAndInstall':
      return parseResult(key, { ok: true as const });
    default:
      return unsupported();
  }
};

export const createLiteWebBillmeApi = ({ baseUrl, token, onAuthFailure, onRequestClose }: LiteWebApiOptions): LiteWebBillmeApi => {
  return createLiteHttpBillmeApi({
    baseUrl,
    auth: { mode: 'bearer', token },
    onAuthFailure,
    fallback: createBrowserFallback(onRequestClose),
  });
};
