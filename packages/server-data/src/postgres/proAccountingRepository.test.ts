import assert from 'node:assert/strict';
import test from 'node:test';
import type { PostgresQueryable } from './connection.js';
import { insertJournalPostingPair } from './proAccountingRepository.js';

test('journal posting-pair insert binds every persisted column', async () => {
  let captured: { text: string; values: unknown[] } | undefined;
  const db = {
    query: async (text: string, values?: unknown[]) => {
      captured = { text, values: values ?? [] };
      return { rows: [] } as never;
    },
  } as unknown as PostgresQueryable;
  await insertJournalPostingPair(db, ['pair', 'tenant', 'entry', 'debit', 'credit', 10, 'DE_STD_19', '19', '2026-08-12']);
  assert.ok(captured);
  assert.match(captured.text, /datev_bu_key/);
  assert.equal((captured.text.match(/\$\d+/g) ?? []).length, 9);
  assert.equal(captured.values.length, 9);
});

test('OPOS migration protects posted incoming invoice lines and persists tenant ownership', async () => {
  const { readFile } = await import('node:fs/promises');
  const migration = await readFile(new URL('../../drizzle/0006_server_data_opos.sql', import.meta.url), 'utf8');
  assert.match(migration, /incoming_invoice_lines_posted_immutable/);
  assert.match(migration, /BEFORE INSERT OR UPDATE OR DELETE ON incoming_invoice_lines/);
  assert.match(migration, /vendor_id TEXT NOT NULL REFERENCES vendors/);
});
