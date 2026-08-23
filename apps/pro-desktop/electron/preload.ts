import { installDesktopPreload } from '@billme/desktop-core/electron/preload';
import { createProHttpBillmeApi } from '@billme/desktop-services/proHttpApi';
import { EMBEDDED_CONNECTION_CHANNEL } from '@billme/desktop-contracts/embeddedConnection';
import type { IpcInvoke } from '@billme/desktop-contracts-pro/api';
import { ipcRoutes } from '../ipc/contract';

installDesktopPreload({
  routes: ipcRoutes,
  embeddedConnectionChannel: EMBEDDED_CONNECTION_CHANNEL,
  createApi: (invoke, context) => createProHttpBillmeApi({
    baseUrl: 'http://127.0.0.1:0',
    embeddedConnectionResolver: context.embeddedConnectionResolver,
    fallback: invoke as IpcInvoke,
  }),
});
