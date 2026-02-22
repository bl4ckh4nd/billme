import { contextBridge, ipcRenderer } from 'electron';
import { createBillmeApi } from '../ipc/api';
import { ipcRoutes, type IpcArgs, type IpcResult, type IpcRouteKey } from '../ipc/contract';

const invoke = async <K extends IpcRouteKey>(key: K, args: IpcArgs<K>): Promise<IpcResult<K>> => {
  if (key === 'secrets:get') {
    throw new Error('secrets:get is not exposed to renderer');
  }
  const route = ipcRoutes[key];
  const parsedArgs = route.args.parse(args) as IpcArgs<K>;

  const rawResult =
    parsedArgs === undefined
      ? await ipcRenderer.invoke(route.channel)
      : await ipcRenderer.invoke(route.channel, parsedArgs);

  return route.result.parse(rawResult) as IpcResult<K>;
};

contextBridge.exposeInMainWorld('billmeApi', createBillmeApi(invoke));

const WINDOW_MAXIMIZE_CHANGED_CHANNEL = 'window:maximize-changed';

const UPDATE_STATUS_CHANGED_CHANNEL = 'updater:status-changed';

contextBridge.exposeInMainWorld('billmeWindow', {
  onMaximizeChanged: (callback: (state: { isMaximized: boolean }) => void) => {
    const listener = (_event: unknown, payload: { isMaximized: boolean }) => {
      callback(payload);
    };
    ipcRenderer.on(WINDOW_MAXIMIZE_CHANGED_CHANNEL, listener);
  },
  offMaximizeChanged: () => {
    ipcRenderer.removeAllListeners(WINDOW_MAXIMIZE_CHANGED_CHANNEL);
  },
  onUpdateStatusChanged: (
    callback: (payload: {
      status: string;
      version?: string;
      error?: string;
      progress?: number;
    }) => void,
  ) => {
    const listener = (
      _event: unknown,
      payload: { status: string; version?: string; error?: string; progress?: number },
    ) => {
      callback(payload);
    };
    ipcRenderer.on(UPDATE_STATUS_CHANGED_CHANNEL, listener);
  },
  offUpdateStatusChanged: () => {
    ipcRenderer.removeAllListeners(UPDATE_STATUS_CHANGED_CHANNEL);
  },
});
