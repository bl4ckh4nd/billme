import { installDesktopPreload } from '@billme/desktop-core/electron/preload';
import { createBillmeApi } from '../ipc/api';
import { ipcRoutes } from '../ipc/contract';

installDesktopPreload({
  routes: ipcRoutes,
  createApi: (invoke) => createBillmeApi(invoke as Parameters<typeof createBillmeApi>[0]),
});
