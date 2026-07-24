import { contextBridge, ipcRenderer } from 'electron';

type RouteDefinition = {
  channel: string;
  args: { parse: (value: unknown) => unknown };
  result: { parse: (value: unknown) => unknown };
};

export const installDesktopPreload = <TApi>(options: {
  routes: Record<string, RouteDefinition>;
  createApi: (invoke: (key: string, args: unknown) => Promise<unknown>) => TApi;
}): void => {
  const invoke = async (key: string, args: unknown): Promise<unknown> => {
    if (key === 'secrets:get') {
      throw new Error('secrets:get is not exposed to renderer');
    }
    const route = options.routes[key];
    if (!route) throw new Error(`Unknown IPC route: ${key}`);
    const parsedArgs = route.args.parse(args);
    const result = parsedArgs === undefined
      ? await ipcRenderer.invoke(route.channel)
      : await ipcRenderer.invoke(route.channel, parsedArgs);
    return route.result.parse(result);
  };

  contextBridge.exposeInMainWorld('billmeApi', options.createApi(invoke));

  const exposeListener = <TPayload>(channel: string) => ({
    on: (callback: (payload: TPayload) => void) => {
      ipcRenderer.on(channel, (_event, payload: TPayload) => callback(payload));
    },
    off: () => ipcRenderer.removeAllListeners(channel),
  });

  const maximize = exposeListener<{ isMaximized: boolean }>('window:maximize-changed');
  const updater = exposeListener<{
    status: string;
    version?: string;
    error?: string;
    progress?: number;
  }>('updater:status-changed');
  const notifications = exposeListener<{
    type: string;
    title: string;
    message: string;
  }>('app:notification');

  contextBridge.exposeInMainWorld('billmeWindow', {
    onMaximizeChanged: maximize.on,
    offMaximizeChanged: maximize.off,
    onUpdateStatusChanged: updater.on,
    offUpdateStatusChanged: updater.off,
    onNotification: notifications.on,
    offNotification: notifications.off,
  });
};
