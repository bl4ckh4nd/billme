import { rebuild } from '@electron/rebuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const rawElectronVersion = pkg?.devDependencies?.electron;
if (!rawElectronVersion) {
  process.exit(0);
}

const electronVersion = String(rawElectronVersion).replace(/^[^\d]*/, '');

try {
  await rebuild({
    buildPath: root,
    electronVersion,
    force: true,
    onlyModules: ['better-sqlite3', 'keytar'],
  });
} catch (err) {
  // This commonly happens on Windows when Electron/Node is currently running and locking the .node file.
  // Don’t fail installs; a manual rebuild can be run after closing running processes.
  console.warn('[rebuild-electron] Failed to rebuild native modules. Close running Electron/Node processes and rerun:', err);
  process.exit(0);
}
