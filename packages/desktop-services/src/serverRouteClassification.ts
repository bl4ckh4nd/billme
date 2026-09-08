/**
 * Routes which are deliberately allowed to stay on the Electron bridge.
 *
 * Every other route owns either persisted data or a server-side side effect.
 * Keeping that default closed means adding a new route cannot accidentally
 * re-introduce a SQLite fallback while the embedded PGlite server is active.
 */
const NATIVE_ELECTRON_ROUTE_KEYS = new Set<string>([
  'window:minimize',
  'window:toggleMaximize',
  'window:close',
  'window:isMaximized',
  'shell:openPath',
  'shell:openExportsDir',
  'shell:openExternal',
  'dialog:pickCsv',
  'pdf:export',
  'eur:exportPdf',
  'db:backup',
  'db:restore',
  // Server creates the package contents; Electron only persists the validated
  // text artifact under its user-data export directory.
  'tax:saveAuditExportPackage',
  'secrets:get',
  'secrets:set',
  'secrets:delete',
  'secrets:has',
  'updater:getStatus',
  'updater:downloadUpdate',
  'updater:quitAndInstall',
]);

export type ServerRouteOwnership = 'server' | 'native';

export const classifyServerRoute = (key: string): ServerRouteOwnership =>
  NATIVE_ELECTRON_ROUTE_KEYS.has(key) ? 'native' : 'server';

export const isNativeElectronRoute = (key: string): boolean =>
  classifyServerRoute(key) === 'native';

export const isServerOwnedRoute = (key: string): boolean =>
  classifyServerRoute(key) === 'server';

export const nativeElectronRouteKeys = (): readonly string[] =>
  [...NATIVE_ELECTRON_ROUTE_KEYS];
