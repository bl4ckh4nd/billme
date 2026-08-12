import assert from 'node:assert/strict';
import test from 'node:test';
import { mapTransactionBankAccounts } from '../src/accountingSeed.js';

test('canonical Web Pro seed carries server-owned bank GL accounts by transaction', () => {
  assert.deepEqual(
    mapTransactionBankAccounts(
      [
        { id: 'tx-1', accountId: 'bank-1' },
        { id: 'tx-2', accountId: 'bank-2' },
        { id: 'tx-missing', accountId: 'unknown' },
      ],
      [
        { id: 'bank-1', defaultSkrAccountNumber: '1200' },
        { id: 'bank-2', defaultSkrAccountNumber: '1800' },
      ],
    ),
    { 'tx-1': '1200', 'tx-2': '1800' },
  );
});
