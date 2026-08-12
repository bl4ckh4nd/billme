import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decryptTaxFilingCredential,
  encryptTaxFilingCredential,
  redactTaxFilingCredential,
  rotateTaxFilingCredential,
} from './taxFilingCredentials.js';

const keyA = new Uint8Array(32).fill(7);
const keyB = new Uint8Array(32).fill(8);

test('tax filing credentials use authenticated AES-GCM envelopes and redacted metadata', () => {
  const envelope = encryptTaxFilingCredential({ plaintext: 'official-secret', keyId: 'k1', key: keyA, createdAt: '2026-01-01' });
  assert.equal(decryptTaxFilingCredential(envelope, (keyId) => keyId === 'k1' ? keyA : undefined), 'official-secret');
  const metadata = redactTaxFilingCredential(envelope);
  assert.deepEqual(metadata, { version: 1, algorithm: 'aes-256-gcm', keyId: 'k1', createdAt: '2026-01-01' });
  assert.equal('ciphertext' in metadata, false);
});

test('credential rotation decrypts with the old key and encrypts with the new key', () => {
  const envelope = encryptTaxFilingCredential({ plaintext: 'official-secret', keyId: 'k1', key: keyA });
  const rotated = rotateTaxFilingCredential({
    envelope,
    resolveKey: (keyId) => keyId === 'k1' ? keyA : undefined,
    nextKeyId: 'k2',
    nextKey: keyB,
  });
  assert.equal(rotated.keyId, 'k2');
  assert.equal(decryptTaxFilingCredential(rotated, (keyId) => keyId === 'k2' ? keyB : undefined), 'official-secret');
  assert.throws(() => decryptTaxFilingCredential(rotated, () => keyA));
});
