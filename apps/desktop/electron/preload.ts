import { installDesktopPreload } from '@billme/desktop-core/electron/preload';
import { createLiteHttpBillmeApi } from '@billme/desktop-services/liteHttpApi';
import { EMBEDDED_CONNECTION_CHANNEL } from '@billme/desktop-contracts/embeddedConnection';
import type { IpcInvoke } from '@billme/desktop-contracts/api';
import { ipcRoutes } from '../ipc/contract';

installDesktopPreload({
  routes: ipcRoutes,
  embeddedConnectionChannel: EMBEDDED_CONNECTION_CHANNEL,
  createApi: (invoke, context) => createLiteHttpBillmeApi({
    embeddedConnectionResolver: context.embeddedConnectionResolver,
    fallback: invoke as IpcInvoke,
  }),
});
