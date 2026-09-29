import path from 'path';
import { fileURLToPath } from 'url';
import { startDesktopMain } from '@billme/desktop-core/electron/desktopMain';
import { createDocumentExportPreparer } from '@billme/desktop-services/documentExport';
import { registerNativeIpcHandlers } from './nativeIpcHandlers';
import { createProLocalBackend } from './proLocalBackend';
import { PRODUCT_PROFILE } from '../productProfile';

startDesktopMain({
  product: 'pro',
  profile: PRODUCT_PROFILE,
  appDir: path.dirname(fileURLToPath(import.meta.url)),
  registerNativeIpcHandlers,
  createBackend: (options) => createProLocalBackend({ ...options, profile: PRODUCT_PROFILE }),
  createDocumentExportPreparer,
});
