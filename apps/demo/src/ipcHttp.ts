import { createBillmeApi } from '../../desktop/ipc/api';
import { ipcRoutes, type IpcArgs, type IpcResult, type IpcRouteKey } from '../../desktop/ipc/contract';

const invoke = async <K extends IpcRouteKey>(key: K, args: IpcArgs<K>): Promise<IpcResult<K>> => {
  const route = ipcRoutes[key];
  const parsedArgs = route.args.parse(args) as IpcArgs<K>;

  const response = await fetch(`/api/ipc/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ args: parsedArgs }),
  });

  const payload = (await response.json().catch(() => ({}))) as { data?: unknown; error?: unknown };
  if (!response.ok) {
    const message =
      typeof payload.error === 'string'
        ? payload.error
        : `IPC route failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  return route.result.parse(payload.data) as IpcResult<K>;
};

export const demoHttpApi = createBillmeApi(invoke);
