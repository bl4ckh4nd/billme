import { describe, expect, it } from 'vitest';
import { baseIpcRoutes } from '@billme/desktop-contracts/contract';
import { ipcRoutes, proOnlyIpcRoutes, proRouteOverrides } from './contract';

describe('pro IPC contract composition', () => {
  it('keeps every lite route available in the pro contract', () => {
    for (const key of Object.keys(baseIpcRoutes)) {
      expect(ipcRoutes).toHaveProperty(key);
    }
  });

  it('reuses lite route definitions except explicit pro payload overrides', () => {
    const overrideKeys = new Set(Object.keys(proRouteOverrides));

    for (const [key, route] of Object.entries(baseIpcRoutes)) {
      if (overrideKeys.has(key)) continue;
      expect(ipcRoutes[key as keyof typeof ipcRoutes]).toBe(route);
    }
  });

  it('keeps pro-only routes additive', () => {
    for (const key of Object.keys(proOnlyIpcRoutes)) {
      expect(baseIpcRoutes).not.toHaveProperty(key);
      expect(ipcRoutes).toHaveProperty(key);
    }
  });
});
