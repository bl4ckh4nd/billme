import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const sqlDirUrl = new URL('./sql/', import.meta.url);
const drizzleDirUrl = new URL('../../drizzle/', import.meta.url);
const drizzleJournalUrl = new URL('../../drizzle/meta/_journal.json', import.meta.url);

type DrizzleJournal = {
  entries: Array<{
    idx: number;
    tag: string;
  }>;
};

test('server Drizzle journal mirrors legacy SQL migration names in order', async () => {
  const legacyFiles = (await readdir(sqlDirUrl))
    .filter((entry) => entry.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));
  const journal = JSON.parse(await readFile(drizzleJournalUrl, 'utf8')) as DrizzleJournal;

  assert.deepEqual(
    journal.entries
      .slice()
      .sort((left, right) => left.idx - right.idx)
      .map((entry) => `${entry.tag}.sql`),
    legacyFiles,
  );
});

test('server Drizzle SQL migrations stay byte-identical to the legacy SQL sources', async () => {
  const legacyFiles = (await readdir(sqlDirUrl))
    .filter((entry) => entry.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));

  for (const file of legacyFiles) {
    const legacySql = await readFile(new URL(file, sqlDirUrl), 'utf8');
    const drizzleSql = await readFile(new URL(file, drizzleDirUrl), 'utf8');
    assert.equal(drizzleSql, legacySql, `${file} drifted between legacy SQL and Drizzle migrations`);
  }
});
