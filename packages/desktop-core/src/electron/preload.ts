import { contextBridge, ipcRenderer } from 'electron';
import { createEmbeddedConnectionResolver, type EmbeddedConnectionResolver } from './embeddedConnection';

type RouteDefinition = {
  channel: string;
  args: { safeParse: (value: unknown) => { success: true; data: unknown } | { success: false; error: { issues: Array<{ message: string }> } } };
  result: { parse: (value: unknown) => unknown };
};

export type DesktopPreloadContext = {
  embeddedConnectionResolver?: EmbeddedConnectionResolver;
};

export const installDesktopPreload = <TApi>(options: {
  routes: Record<string, RouteDefinition>;
  embeddedConnectionChannel?: string;
  createApi: (
    invoke: (key: string, args: unknown) => Promise<unknown>,
    context: DesktopPreloadContext,
  ) => TApi;
}): void => {
  const invoke = async (key: string, args: unknown): Promise<unknown> => {
    if (key === 'secrets:get') {
      throw new Error('secrets:get is not exposed to renderer');
    }
    const route = options.routes[key];
    if (!route) throw new Error(`Unknown IPC route: ${key}`);
    const checked = route.args.safeParse(args);
    // The schema messages are the German field sentences ("Ungültige IBAN."); the raw ZodError is JSON.
    if (!checked.success) throw new Error([...new Set(checked.error.issues.map((issue) => issue.message))].join(' '));
    const parsedArgs = checked.data;
    let result: unknown;
    try {
      result = parsedArgs === undefined
        ? await ipcRenderer.invoke(route.channel)
        : await ipcRenderer.invoke(route.channel, parsedArgs);
    } catch (error) {
      // Electron wraps main-process errors as "Error invoking remote method 'x': Error: …";
      // the user only needs the message the backend wrote.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:Error:\s*)+/, ''));
    }
    return route.result.parse(result);
  };

  const context: DesktopPreloadContext = options.embeddedConnectionChannel
    ? {
        embeddedConnectionResolver: createEmbeddedConnectionResolver(
          () => ipcRenderer.invoke(options.embeddedConnectionChannel!),
        ),
      }
    : {};

  contextBridge.exposeInMainWorld('billmeApi', options.createApi(invoke, context));

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
