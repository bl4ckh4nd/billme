import { createProHttpBillmeApi, type ProHttpBillmeApi } from '@billme/desktop-services/proHttpApi';
import type { IpcInvoke } from '@billme/desktop-contracts-pro/api';
import { ipcRoutes, type IpcArgs, type IpcResult, type IpcRouteKey } from '@billme/desktop-contracts-pro/contract';

export type ProWebApiOptions = {
  baseUrl: string;
  token: string;
  onRequestClose?: () => void;
};

const UNSUPPORTED_MESSAGE = 'Diese Funktion ist in Billme Pro im Browser noch nicht verfügbar.';

const parseResult = <K extends IpcRouteKey>(key: K, value: unknown): IpcResult<K> =>
  ipcRoutes[key].result.parse(value) as IpcResult<K>;

// Answers the Electron-only routes (window, shell, dialog, secrets, updater);
// createProHttpBillmeApi only hands those native routes to the fallback.
const createBrowserFallback = (onRequestClose?: () => void): IpcInvoke => async (key, rawArgs) => {
  switch (key) {
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
      const { url } = ipcRoutes[key].args.parse(rawArgs) as IpcArgs<'shell:openExternal'>;
      window.open(url, '_blank', 'noopener,noreferrer');
      return parseResult(key, { ok: true as const });
    }
    case 'dialog:pickCsv':
      return parseResult(key, { path: null });
    case 'secrets:get':
      return parseResult(key, null);
    case 'secrets:has':
      return parseResult(key, false);
    case 'updater:getStatus':
      return parseResult(key, { status: 'idle' });
    case 'updater:downloadUpdate':
    case 'updater:quitAndInstall':
      return parseResult(key, { ok: true as const });
    default:
      throw new Error(UNSUPPORTED_MESSAGE);
  }
};

export const createProWebBillmeApi = ({ baseUrl, token, onRequestClose }: ProWebApiOptions): ProHttpBillmeApi =>
  createProHttpBillmeApi({
    baseUrl,
    getToken: () => token,
    fallback: createBrowserFallback(onRequestClose),
  });
