import type { IpcInvoke } from '@billme/desktop-contracts-pro/api';
import {
  ipcRoutes,
  type IpcArgs,
  type IpcResult,
  type IpcRouteKey,
} from '@billme/desktop-contracts-pro/contract';

const UNSUPPORTED_MESSAGE = 'Diese Desktop-Funktion ist in Billme Pro im Browser nicht verfügbar.';
const SECRET_UNSUPPORTED_MESSAGE = 'Die sichere Ablage von Zugangsdaten ist im Browser nicht verfügbar.';

const parseResult = <K extends IpcRouteKey>(key: K, value: unknown): IpcResult<K> =>
  ipcRoutes[key].result.parse(value) as IpcResult<K>;

const unsupported = (detail = UNSUPPORTED_MESSAGE): never => {
  throw new Error(detail);
};

const printUrl = (params: Record<string, string | number | undefined>): string => {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('__print', '1');
  url.searchParams.set('__autoprint', '1');
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
};

const openBrowserUrl = (value: string): void => {
  const url = new URL(value, window.location.href);
  if (!['http:', 'https:', 'blob:'].includes(url.protocol)) {
    unsupported('Dieser Pfad kann im Browser nicht sicher geöffnet werden.');
  }
  window.open(url.toString(), '_blank', 'noopener,noreferrer');
};

export const createBrowserNativeFallback = (onRequestClose?: () => void): IpcInvoke => async (key, rawArgs) => {
  const args = ipcRoutes[key].args.parse(rawArgs) as IpcArgs<typeof key>;

  switch (key) {
    case 'pdf:export': {
      const { kind, id } = args as IpcArgs<'pdf:export'>;
      return parseResult(key, { path: printUrl({ kind, id }) });
    }
    case 'eur:exportPdf': {
      const { taxYear, from, to } = args as IpcArgs<'eur:exportPdf'>;
      return parseResult(key, { path: printUrl({ kind: 'eur', taxYear, from, to }) });
    }
    case 'window:toggleMaximize':
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
      return parseResult(key, { ok: true });
    case 'window:close':
      onRequestClose?.();
      return parseResult(key, { ok: true });
    case 'window:isMaximized':
      return parseResult(key, { isMaximized: Boolean(document.fullscreenElement) });
    case 'shell:openExternal':
      openBrowserUrl((args as IpcArgs<'shell:openExternal'>).url);
      return parseResult(key, { ok: true });
    case 'shell:openPath':
      openBrowserUrl((args as IpcArgs<'shell:openPath'>).path);
      return parseResult(key, { ok: true });
    case 'secrets:has':
      return parseResult(key, false);
    case 'updater:getStatus':
      return parseResult(key, { status: 'idle' });
    case 'secrets:get':
    case 'secrets:set':
    case 'secrets:delete':
      return unsupported(SECRET_UNSUPPORTED_MESSAGE);
    case 'window:minimize':
    case 'shell:openExportsDir':
    case 'dialog:pickCsv':
    case 'db:backup':
    case 'db:restore':
    case 'tax:saveAuditExportPackage':
    case 'updater:downloadUpdate':
    case 'updater:quitAndInstall':
      return unsupported();
    default:
      return unsupported('Für diese Route existiert kein Browser-Fallback.');
  }
};
