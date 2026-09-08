import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktopApps = ['apps/desktop', 'apps/pro-desktop'] as const;

const read = (relativePath: string): string => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

describe('PGlite desktop packaging', () => {
  it('keeps SQLite out of both production manifests and Electron packaging', () => {
    for (const app of desktopApps) {
      const manifest = JSON.parse(read(`${app}/package.json`)) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const viteConfig = read(`${app}/electron.vite.config.ts`);
      const builderConfig = read(`${app}/electron-builder.yml`);
      const rebuildScript = read(`${app}/scripts/rebuild-electron.mjs`);

      expect(manifest.dependencies?.['better-sqlite3'], `${app} production dependencies`).toBeUndefined();
      expect(manifest.devDependencies?.['better-sqlite3'], `${app} legacy test dependency`).toBeDefined();
      expect(viteConfig, `${app} electron-vite config`).not.toContain('better-sqlite3');
      expect(builderConfig, `${app} electron-builder config`).not.toContain('better-sqlite3');
      expect(rebuildScript, `${app} native rebuild script`).not.toContain('better-sqlite3');

      expect(builderConfig, `${app} PGlite assets`).toContain('node_modules/@electric-sql/pglite/dist/**');
      expect(builderConfig, `${app} server migrations`).toContain('../../packages/server-data/drizzle');
    }
  });
});
