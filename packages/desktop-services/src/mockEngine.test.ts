import assert from 'node:assert/strict';
import test from 'node:test';
import type { IpcArgs } from '@billme/desktop-contracts/contract';
import { createLiteMockInvoke } from './mockEngine.js';

const correctionPayload = {
  operation: 'correction',
  id: 'credit-1',
  invoiceId: '1',
  kind: 'credit_note',
  amount: 50,
  date: '2026-09-22',
  reason: 'Gutschrift erstellt',
} as const satisfies IpcArgs<'documents:chainIssue'>;

test('mock issuance is idempotent per operation id and rejects a changed intent', async () => {
  const invoke = createLiteMockInvoke();

  const issued = await invoke('documents:chainIssue', correctionPayload);
  assert.equal(issued.status, 'open');
  assert.equal(issued.id, 'credit-1');
  assert.ok(issued.number);
  assert.ok(issued.numberReservationId);

  const before = await invoke('invoices:list', undefined);
  const replay = await invoke('documents:chainIssue', correctionPayload);
  assert.deepEqual(replay, issued);
  const after = await invoke('invoices:list', undefined);
  assert.deepEqual(after, before);

  await assert.rejects(
    invoke('documents:chainIssue', { ...correctionPayload, amount: 60 }),
    /Issuance intent differs from the recorded operation/,
  );
});

test('a failing mock issuance rolls back every effect and a corrected retry reuses the id', async () => {
  const invoke = createLiteMockInvoke();
  const oversized = { ...correctionPayload, id: 'credit-retry', amount: 5000 } as IpcArgs<'documents:chainIssue'>;
  const before = await invoke('invoices:list', undefined);

  await assert.rejects(
    invoke('documents:chainIssue', oversized),
    /Correction amount exceeds original invoice amount/,
  );
  assert.deepEqual(await invoke('invoices:list', undefined), before);

  const issued = await invoke('documents:chainIssue', { ...oversized, amount: 50 } as IpcArgs<'documents:chainIssue'>);
  assert.equal(issued.status, 'open');
  assert.equal(issued.id, 'credit-retry');
  assert.equal((await invoke('invoices:list', undefined)).length, before.length + 1);
});
