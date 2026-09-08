import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveCanonicalMigrationDirectory } from './migrations.js';

test('resolves canonical migrations when the working directory is outside the repository root', () => {
  const originalWorkingDirectory = process.cwd();
  const expectedDirectory = fileURLToPath(new URL('../../drizzle', import.meta.url));
  try {
    process.chdir('/tmp');
    assert.notEqual(process.cwd(), originalWorkingDirectory);
    assert.equal(resolveCanonicalMigrationDirectory(), expectedDirectory);
  } finally {
    process.chdir(originalWorkingDirectory);
  }
});
