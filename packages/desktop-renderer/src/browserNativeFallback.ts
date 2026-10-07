import { ipcRoutes, type IpcArgs, type IpcResult, type IpcRouteKey } from '@billme/desktop-contracts/contract';

type AnyInvoke = (key: never, args: never) => Promise<unknown>;

const parseResult = <K extends IpcRouteKey>(key: K, value: unknown): IpcResult<K> =>
  ipcRoutes[key].result.parse(value) as IpcResult<K>;

/**
 * Browser answers for the Electron-only routes (window, shell, dialog, secrets,
 * updater). The HTTP adapters hand only those native routes to their fallback.
 */
export const createBrowserNativeFallback = <TInvoke extends AnyInvoke>(
  productName: string,
  onRequestClose?: () => void,
): TInvoke => {
  const unsupported = (message = `Diese Funktion ist in ${productName} im Browser noch nicht verfügbar.`): never => {
    throw new Error(message);
  };
  const fallback = async (key: IpcRouteKey, rawArgs: unknown): Promise<unknown> => {
    switch (key) {
      case 'window:minimize':
      case 'window:setTheme':
      case 'shell:openPath':
      case 'shell:openExportsDir':
      case 'updater:downloadUpdate':
      case 'updater:quitAndInstall':
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
      case 'shell:openExternal': {
        const { url } = ipcRoutes[key].args.parse(rawArgs) as IpcArgs<'shell:openExternal'>;
        window.open(url, '_blank', 'noopener,noreferrer');
        return parseResult(key, { ok: true as const });
      }
      case 'dialog:pickCsv': {
        const file = await new Promise<File | null>((resolve) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.csv,text/csv';
          input.addEventListener('change', () => { resolve(input.files?.[0] ?? null); input.remove(); }, { once: true });
          input.addEventListener('cancel', () => { resolve(null); input.remove(); }, { once: true });
          input.hidden = true;
          document.body.append(input);
          input.click();
        });
        if (!file) return parseResult(key, { path: null });
        if (file.size > 20 * 1024 * 1024) throw new Error('CSV-Dateien dürfen höchstens 20 MB groß sein.');
        const contentBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
          reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden.'));
          reader.readAsDataURL(file);
        });
        return parseResult(key, { path: null, fileName: file.name, contentBase64 });
      }
      case 'secrets:get':
        return parseResult(key, null);
      case 'secrets:has':
        return parseResult(key, false);
      case 'secrets:set':
      case 'secrets:delete':
        return unsupported(`Die sichere Ablage von Zugangsdaten ist in ${productName} im Browser nicht verfügbar.`);
      case 'updater:getStatus':
        return parseResult(key, { status: 'idle' });
      case 'pdf:export':
        return unsupported(`Der PDF-Export ist in ${productName} im Browser noch nicht verfügbar.`);
      default:
        return unsupported();
    }
  };
  return fallback as unknown as TInvoke;
};
