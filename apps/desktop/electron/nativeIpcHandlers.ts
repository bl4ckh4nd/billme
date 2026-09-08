import {
  registerNativeIpcCommonHandlers,
  type NativeIpcCommonDependencies,
  type NativeIpcMain,
} from '@billme/desktop-core/electron/nativeIpc';
import { ipcRoutes } from '@billme/desktop-contracts/contract';
import { getCurrentUpdateStatus, downloadUpdate, quitAndInstall } from './updater';
import { secrets } from './secrets';
import { exportEurPdf, exportPdf } from './pdfExport';

export type NativeHandlerDependencies = Omit<NativeIpcCommonDependencies, 'secrets' | 'updater'>;

export const registerNativeIpcHandlers = (
  ipcMain: NativeIpcMain,
  deps: NativeHandlerDependencies,
): void => {
  registerNativeIpcCommonHandlers(
    ipcMain,
    ipcRoutes,
    {
      ...deps,
      secrets,
      updater: { getCurrentUpdateStatus, downloadUpdate, quitAndInstall },
    },
    { exportPdf, exportEurPdf },
  );
};
