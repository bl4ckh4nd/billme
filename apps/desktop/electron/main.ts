import path from 'path';
import { fileURLToPath } from 'url';
import { startDesktopMain } from '@billme/desktop-core/electron/desktopMain';
import { createDocumentExportPreparer } from '@billme/desktop-services/documentExport';
import { registerNativeIpcHandlers } from './nativeIpcHandlers';
import { createLocalBackend } from './localBackend';
import { PRODUCT_PROFILE } from '../productProfile';

startDesktopMain({
  product: 'lite',
  profile: PRODUCT_PROFILE,
  appDir: path.dirname(fileURLToPath(import.meta.url)),
  minWindowSize: { width: 1024, height: 640 },
  registerNativeIpcHandlers,
  createBackend: (options) => createLocalBackend({ ...options, profile: PRODUCT_PROFILE }),
  createDocumentExportPreparer,
});
