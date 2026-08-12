import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workflowsDir = path.join(repoRoot, '.github/workflows');
const serverModePath = 'test-results/server-mode';
const requiredPathEntries = [
  serverModePath,
  '!test-results/server-mode/**/compose.env',
  '!test-results/server-mode/**/runtime-state.json',
];
const getUploadSteps = (lines) => {
  const steps = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/actions\/upload-artifact@/u.test(lines[index])) continue;
    const block = [lines[index]];
    let end = index + 1;
    for (; end < lines.length; end += 1) {
      if (/^\s*-\s/u.test(lines[end])) break;
      block.push(lines[end]);
    }
    steps.push({ line: index + 1, lines: block });
    index = end - 1;
  }
  return steps;
};

const isServerModePath = (line) => {
  let value = line.trim();
  if (value.startsWith('!')) return false;
  if (value.startsWith('path:')) value = value.slice('path:'.length).trim();
  if (value === '|' || value === '>') return false;
  value = value.replace(/^(['"])(.*)\1$/u, '$2');
  return value === serverModePath || value.startsWith(`${serverModePath}/`);
};

const inspectUploadStep = (workflowFile, step) => {
  const block = step.lines.map((line) => line.trim());
  if (!block.some((line) => isServerModePath(line))) return [];

  const failures = [];
  if (!block.includes('path: |')) {
    failures.push(`${workflowFile}:${step.line} must use a multiline diagnostics path`);
  }
  for (const pathEntry of requiredPathEntries) {
    if (!block.includes(pathEntry)) {
      failures.push(`${workflowFile}:${step.line} is missing diagnostics path entry "${pathEntry}"`);
    }
  }
  return failures;
};

const inspectWorkflow = (workflowFile, source) => {
  const uploadSteps = getUploadSteps(source.split(/\r?\n/u));
  const diagnosticsSteps = uploadSteps.filter((step) =>
    step.lines.some((line) => isServerModePath(line.trim()))
  );
  return {
    uploadStepCount: uploadSteps.length,
    diagnosticsStepCount: diagnosticsSteps.length,
    failures: diagnosticsSteps.flatMap((step) => inspectUploadStep(workflowFile, step)),
  };
};

const runSelfTest = () => {
  const safeFixture = `
jobs:
  test:
    steps:
      - name: renamed diagnostics upload
        uses: actions/upload-artifact@v4
        with:
          path: |
            test-results/server-mode
            !test-results/server-mode/**/compose.env
            !test-results/server-mode/**/runtime-state.json
`;
  const safeResult = inspectWorkflow('fixture.yml', safeFixture);
  if (safeResult.uploadStepCount !== 1 || safeResult.diagnosticsStepCount !== 1 || safeResult.failures.length) {
    throw new Error('Artifact hygiene self-test failed to recognize a renamed safe upload step.');
  }

  const unsafeResult = inspectWorkflow(
    'fixture.yml',
    safeFixture.replace('!test-results/server-mode/**/runtime-state.json', '')
  );
  if (!unsafeResult.failures.some((failure) => failure.includes('runtime-state.json'))) {
    throw new Error('Artifact hygiene self-test failed to reject an unsafe upload step.');
  }
};

runSelfTest();

const workflowFiles = (await readdir(workflowsDir)).filter((file) => /\.ya?ml$/u.test(file));
const failures = [];
let uploadStepCount = 0;
let diagnosticsStepCount = 0;

for (const workflowFile of workflowFiles) {
  const filePath = path.join(workflowsDir, workflowFile);
  const result = inspectWorkflow(workflowFile, await readFile(filePath, 'utf8'));
  uploadStepCount += result.uploadStepCount;
  diagnosticsStepCount += result.diagnosticsStepCount;
  failures.push(...result.failures);
}

if (diagnosticsStepCount === 0) {
  failures.push('No actions/upload-artifact step uploads test-results/server-mode.');
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `E2E artifact hygiene passed (${diagnosticsStepCount} server-mode upload steps checked across ${uploadStepCount} artifact uploads).`
  );
}
