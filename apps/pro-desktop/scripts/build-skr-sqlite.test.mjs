#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build-skr-sqlite.mjs');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-skr-sqlite-'));
const sourceDir = path.join(tempDir, 'source');
const outputPath = path.join(tempDir, 'output.sqlite');
fs.mkdirSync(sourceDir);

try {
  fs.writeFileSync(path.join(sourceDir, 'skr03_konten_strikt.csv'), 'konto,bezeichnung,marker\n1000,Kasse,\n1000,Kasse erweitert,SB\n');
  fs.writeFileSync(outputPath, 'must survive validation failure');
  assert.throws(() => execFileSync(process.execPath, [scriptPath, sourceDir, outputPath], { stdio: 'pipe' }), /Missing CSV source/);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'must survive validation failure');

  fs.writeFileSync(path.join(sourceDir, 'skr04_konten_strikt.csv'), 'konto,bezeichnung,marker\n2000,Bank,\n');
  execFileSync(process.execPath, [scriptPath, sourceDir, outputPath], { stdio: 'pipe' });
  const firstOutput = fs.readFileSync(outputPath);
  execFileSync(process.execPath, [scriptPath, sourceDir, outputPath], { stdio: 'pipe' });
  assert.deepEqual(fs.readFileSync(outputPath), firstOutput);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('build-skr-sqlite regression passed');
