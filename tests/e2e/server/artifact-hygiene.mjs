import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workflowsDir = path.join(repoRoot, '.github/workflows');
const requiredPathEntries = [
  'test-results/server-mode',
  '!test-results/server-mode/**/compose.env',
  '!test-results/server-mode/**/runtime-state.json',
];

const workflowFiles = (await readdir(workflowsDir)).filter((file) => /\.ya?ml$/u.test(file));
const failures = [];
let uploadStepCount = 0;

for (const workflowFile of workflowFiles) {
  const filePath = path.join(workflowsDir, workflowFile);
  const lines = (await readFile(filePath, 'utf8')).split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes('name: Upload server-mode diagnostics')) continue;

    uploadStepCount += 1;
    const block = [];
    for (let lineIndex = index; lineIndex < lines.length; lineIndex += 1) {
      if (lineIndex > index && /^\s*-\s+name:/u.test(lines[lineIndex])) break;
      block.push(lines[lineIndex].trim());
    }

    if (!block.includes('path: |')) {
      failures.push(`${workflowFile}:${index + 1} must use a multiline diagnostics path`);
      continue;
    }

    for (const pathEntry of requiredPathEntries) {
      if (!block.includes(pathEntry)) {
        failures.push(`${workflowFile}:${index + 1} is missing diagnostics path entry "${pathEntry}"`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`E2E artifact hygiene passed (${uploadStepCount} server-mode upload steps checked).`);
}
