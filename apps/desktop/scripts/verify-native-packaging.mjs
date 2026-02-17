import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, '..');
const releaseDir = path.join(appRoot, 'release');

const platform = process.platform;
function findMacResourceDirs() {
  const staticCandidates = [
    path.join(releaseDir, 'mac', 'Billme.app', 'Contents', 'Resources'),
    path.join(releaseDir, 'mac-arm64', 'Billme.app', 'Contents', 'Resources'),
    path.join(releaseDir, 'mac-x64', 'Billme.app', 'Contents', 'Resources'),
  ];

  if (!fs.existsSync(releaseDir)) {
    return staticCandidates;
  }

  const dynamicCandidates = [];
  for (const entry of fs.readdirSync(releaseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!entry.name.startsWith('mac')) {
      continue;
    }

    const candidate = path.join(
      releaseDir,
      entry.name,
      'Billme.app',
      'Contents',
      'Resources',
    );
    dynamicCandidates.push(candidate);
  }

  return [...new Set([...staticCandidates, ...dynamicCandidates])];
}

const resourceDirsByPlatform = {
  linux: [path.join(releaseDir, 'linux-unpacked', 'resources')],
  darwin: findMacResourceDirs(),
  win32: [path.join(releaseDir, 'win-unpacked', 'resources')],
};

const candidates = resourceDirsByPlatform[platform] ?? [];

if (candidates.length === 0) {
  console.error(`[verify-native-packaging] Unsupported platform: ${platform}`);
  process.exit(1);
}

const resourceDir = candidates.find((candidate) => fs.existsSync(candidate));
if (!resourceDir) {
  console.error('[verify-native-packaging] Could not find resources directory. Checked:');
  for (const candidate of candidates) {
    console.error(`  - ${candidate}`);
  }
  process.exit(1);
}

const unpackedDir = path.join(resourceDir, 'app.asar.unpacked');
const betterSqlite3Dir = path.join(unpackedDir, 'node_modules', 'better-sqlite3');

if (!fs.existsSync(unpackedDir)) {
  console.error(`[verify-native-packaging] Missing app.asar.unpacked at ${unpackedDir}`);
  process.exit(1);
}

if (!fs.existsSync(betterSqlite3Dir)) {
  console.error(
    `[verify-native-packaging] Missing better-sqlite3 in packaged app at ${betterSqlite3Dir}`,
  );
  process.exit(1);
}

function findNativeBinaries(dir) {
  const binaries = [];
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.node')) {
        binaries.push(fullPath);
      }
    }
  }

  return binaries;
}

const nativeBinaries = findNativeBinaries(betterSqlite3Dir);
if (nativeBinaries.length === 0) {
  console.error(
    `[verify-native-packaging] No .node binary found under ${betterSqlite3Dir}`,
  );
  process.exit(1);
}

console.log(`[verify-native-packaging] OK for ${platform}`);
console.log(`[verify-native-packaging] resources: ${resourceDir}`);
console.log(`[verify-native-packaging] native binaries found:`);
for (const binary of nativeBinaries) {
  console.log(`  - ${binary}`);
}
