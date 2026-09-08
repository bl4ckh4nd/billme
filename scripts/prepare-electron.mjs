#!/usr/bin/env node
import { access, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const packageDir = dirname(require.resolve('electron/package.json'));
const install = spawnSync(process.execPath, ['install.js'], {
  cwd: packageDir,
  env: process.env,
  stdio: 'inherit',
});

if (install.error) throw install.error;
if (install.status !== 0) process.exit(install.status ?? 1);

const executable = process.platform === 'darwin'
  ? 'Electron.app/Contents/MacOS/Electron'
  : process.platform === 'win32' ? 'electron.exe' : 'electron';
await access(join(packageDir, 'dist', executable));
await writeFile(join(packageDir, 'path.txt'), executable);
await access(require('electron'));
console.log(`[prepare-electron] Binary ready in ${packageDir}`);
