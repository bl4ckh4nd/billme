import {
  registerNativeIpcCommonHandlers,
  type NativeIpcCommonDependencies,
  type NativeIpcMain,
} from '@billme/desktop-core/electron/nativeIpc';
import { ipcRoutes } from '@billme/desktop-contracts/contract';
import { getCurrentUpdateStatus, downloadUpdate, quitAndInstall } from '@billme/desktop-core/electron/updater';
import { secrets } from '@billme/desktop-core/electron/secrets';
import { exportEurPdf, exportPdf } from '@billme/desktop-core/electron/pdfExport';
import { createDocumentExportPreparer } from '@billme/desktop-services/documentExport';
import type { EmbeddedConnectionResult } from '@billme/desktop-contracts/embeddedConnection';

export type NativeHandlerDependencies = Omit<NativeIpcCommonDependencies, 'secrets' | 'updater'> & {
  readonly resolveEmbeddedConnection: () => EmbeddedConnectionResult;
};

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
    {
      exportPdf,
      exportEurPdf,
      prepareDocumentExport: createDocumentExportPreparer({ product: 'lite', resolveConnection: deps.resolveEmbeddedConnection }),
    },
  );
};
