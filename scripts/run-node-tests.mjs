#!/usr/bin/env node
import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';

const ignoredDirectories = new Set(['node_modules', 'dist', 'out', 'coverage', '.git']);
const roots = process.argv.slice(2);

const collectTests = (path) => {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return [];
  }
  if (stat.isFile()) return path.endsWith('.test.ts') ? [path] : [];
  if (!stat.isDirectory()) return [];

  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    files.push(...collectTests(resolve(path, entry.name)));
  }
  return files;
};

const testFiles = roots
  .flatMap((root) => collectTests(resolve(process.cwd(), root)))
  .sort()
  .map((file) => relative(process.cwd(), file).replaceAll('\\', '/'));

if (!testFiles.length) {
  console.error(`No test files found under ${roots.join(', ') || 'the current directory'}`);
  process.exitCode = 1;
} else {
  console.log(`Running ${testFiles.length} test files`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...testFiles], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
