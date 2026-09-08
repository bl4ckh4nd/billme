#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceRoots = ['apps', 'packages'];

// Native SQL is intentionally limited to lifecycle/migration code and source
// database compatibility bridges. All product persistence must use Drizzle.
const allowlist = new Set([
  'apps/desktop/db/migrate.ts',
  'apps/pro-desktop/db/migrate.ts',
  'apps/pro-desktop/scripts/build-skr-sqlite.mjs',
  'apps/pro-desktop/services/legacySqliteReadBridge.ts',
  'apps/offer-portal/src/storage/legacySqliteBridge.ts',
  'packages/desktop-data/src/connection.ts',
  'packages/server-data/src/postgres/connection.ts',
  'packages/server-data/src/postgres/importDesktop.ts',
  'packages/server-data/src/postgres/migrations.ts',
]);

const nativeSql = /\b(?:db|client|pool|sourceDb)\.(?:prepare|query|exec)\s*\(|\bsql\.raw\s*\(/g;
const ignoredDirs = new Set(['node_modules', 'dist', 'out', 'coverage', '.git']);
const ignoredFile = (name) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name);

async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (ignoredDirs.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collect(path));
    else if (/\.(?:[cm]?[jt]sx?|mjs)$/.test(entry.name) && !ignoredFile(entry.name)) files.push(path);
  }
  return files;
}

const violations = [];
for (const sourceRoot of sourceRoots) {
  for (const file of await collect(join(root, sourceRoot))) {
    const relativePath = relative(root, file).replaceAll('\\', '/');
    const source = await readFile(file, 'utf8');
    const matches = [...source.matchAll(nativeSql)];
    if (!matches.length) continue;
    if (allowlist.has(relativePath)) continue;
    for (const match of matches) {
      const line = source.slice(0, match.index).split('\n').length;
      violations.push(`${relativePath}:${line}`);
    }
  }
}

if (violations.length) {
  console.error('Native SQL persistence calls found outside the explicit lifecycle/source bridge allowlist:');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`Raw SQL guard passed (${allowlist.size} explicit lifecycle/source bridge files allowlisted).`);
}
