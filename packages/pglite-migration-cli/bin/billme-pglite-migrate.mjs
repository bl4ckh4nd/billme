#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entrypoint = resolve(here, '../src/cli.ts');
const result = spawnSync(process.execPath, ['--import', 'tsx', entrypoint, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
