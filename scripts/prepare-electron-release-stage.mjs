import fs from 'node:fs/promises';
import path from 'node:path';

const [sourceArgument, stageArgument] = process.argv.slice(2);

if (!sourceArgument || !stageArgument) {
  console.error('Usage: prepare-electron-release-stage.mjs <source-app> <stage-app>');
  process.exit(1);
}

const workspaceRoot = process.cwd();
const sourceRoot = path.resolve(workspaceRoot, sourceArgument);
const stageRoot = path.resolve(workspaceRoot, stageArgument);

if (!stageRoot.startsWith(`${workspaceRoot}${path.sep}.release-stage${path.sep}`)) {
  throw new Error(`Release stage must be inside .release-stage: ${stageRoot}`);
}

await fs.copyFile(path.join(sourceRoot, 'package.json'), path.join(stageRoot, 'package.json'));
await fs.cp(path.join(sourceRoot, 'dist'), path.join(stageRoot, 'dist'), {
  recursive: true,
  force: true,
});
await fs.rm(path.join(stageRoot, 'pnpm-lock.yaml'), { force: true });

if (sourceArgument === 'apps/pro-desktop') {
  await fs.cp(
    path.join(workspaceRoot, 'doppelteBuchhaltung'),
    path.join(workspaceRoot, '.release-stage', 'doppelteBuchhaltung'),
    { recursive: true, force: true },
  );
}

console.log(`[release-stage] Prepared ${stageRoot}`);
