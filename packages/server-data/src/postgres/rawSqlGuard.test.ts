import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));

test('server accounting and import destinations use the Drizzle query seam', async () => {
  const files = ['proAccounting.ts', 'importDesktop.ts'];
  for (const file of files) {
    const source = await readFile(join(here, file), 'utf8');
    assert.doesNotMatch(source, /\b(?:db|client|pool)\.query\s*\(/, `${file} must not issue native Postgres queries`);
  }

  // Migrations are the explicit lifecycle seam allowed to use the native
  // client for the advisory lock around Drizzle's migrator.
  const migrationSource = await readFile(join(here, 'migrations.ts'), 'utf8');
  assert.match(migrationSource, /pg_advisory_lock/);
  assert.match(migrationSource, /pg_advisory_unlock/);
});
