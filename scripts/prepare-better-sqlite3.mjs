#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const packageDir = dirname(require.resolve('better-sqlite3/package.json'));
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const install = spawnSync(npmCommand, ['run', 'install'], {
  cwd: packageDir,
  env: process.env,
  stdio: 'inherit',
});

if (install.error) throw install.error;
if (install.status !== 0) process.exit(install.status ?? 1);

const Database = require('better-sqlite3');
const database = new Database(':memory:');
database.prepare('select 1').get();
database.close();

console.log(`[prepare-better-sqlite3] Native binding ready in ${packageDir}`);
