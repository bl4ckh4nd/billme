import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface TaxFilingCredentialEnvelope {
  version: 1;
  algorithm: 'aes-256-gcm';
  keyId: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  createdAt: string;
}

export interface TaxFilingCredentialMetadata {
  version: 1;
  algorithm: 'aes-256-gcm';
  keyId: string;
  createdAt: string;
}

export class TaxFilingCredentialError extends Error {
  readonly code: 'PROVIDER_UNAVAILABLE' | 'CREDENTIAL_KEY_UNAVAILABLE' | 'INVALID_CREDENTIAL';

  constructor(code: TaxFilingCredentialError['code'], message: string) {
    super(message);
    this.name = 'TaxFilingCredentialError';
    this.code = code;
  }
}

const assertKey = (key: Uint8Array | undefined, keyId: string): Uint8Array => {
  if (!key || key.byteLength !== 32) {
    throw new TaxFilingCredentialError('CREDENTIAL_KEY_UNAVAILABLE', `Credential key ${keyId} is unavailable`);
  }
  return key;
};

/** Accepts a 64-character hex key or a base64-encoded 32-byte key. */
export const parseTaxFilingCredentialKey = (value: string | undefined, keyId: string): Uint8Array => {
  if (!value?.trim()) {
    throw new TaxFilingCredentialError('CREDENTIAL_KEY_UNAVAILABLE', `Credential key ${keyId} is unavailable`);
  }
  const normalized = value.trim();
  const key = /^[a-f0-9]{64}$/i.test(normalized)
    ? Buffer.from(normalized, 'hex')
    : Buffer.from(normalized, 'base64');
  return assertKey(key, keyId);
};

export const readTaxFilingCredentialKey = (
  env: NodeJS.ProcessEnv = process.env,
): { keyId: string; key: Uint8Array } => {
  const keyId = env.TAX_FILING_CREDENTIAL_KEY_ID?.trim();
  if (!keyId) {
    throw new TaxFilingCredentialError('CREDENTIAL_KEY_UNAVAILABLE', 'TAX_FILING_CREDENTIAL_KEY_ID is not configured');
  }
  return {
    keyId,
    key: parseTaxFilingCredentialKey(env.TAX_FILING_CREDENTIAL_KEY, keyId),
  };
};

export const encryptTaxFilingCredential = (input: {
  plaintext: string;
  keyId: string;
  key: Uint8Array;
  createdAt?: string;
}): TaxFilingCredentialEnvelope => {
  if (!input.plaintext) {
    throw new TaxFilingCredentialError('INVALID_CREDENTIAL', 'Credential cannot be empty');
  }
  const key = assertKey(input.key, input.keyId);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(input.plaintext, 'utf8'), cipher.final()]);
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    keyId: input.keyId,
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
};

export const decryptTaxFilingCredential = (
  envelope: TaxFilingCredentialEnvelope,
  resolveKey: (keyId: string) => Uint8Array | undefined,
): string => {
  if (envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') {
    throw new TaxFilingCredentialError('INVALID_CREDENTIAL', 'Unsupported credential envelope');
  }
  const key = assertKey(resolveKey(envelope.keyId), envelope.keyId);
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(envelope.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new TaxFilingCredentialError('INVALID_CREDENTIAL', 'Credential envelope authentication failed');
  }
};

export const rotateTaxFilingCredential = (input: {
  envelope: TaxFilingCredentialEnvelope;
  resolveKey: (keyId: string) => Uint8Array | undefined;
  nextKeyId: string;
  nextKey: Uint8Array;
  now?: string;
}): TaxFilingCredentialEnvelope => encryptTaxFilingCredential({
  plaintext: decryptTaxFilingCredential(input.envelope, input.resolveKey),
  keyId: input.nextKeyId,
  key: input.nextKey,
  createdAt: input.now,
});

/** Safe to return in API responses and logs; never include ciphertext. */
export const redactTaxFilingCredential = (envelope: TaxFilingCredentialEnvelope): TaxFilingCredentialMetadata => ({
  version: envelope.version,
  algorithm: envelope.algorithm,
  keyId: envelope.keyId,
  createdAt: envelope.createdAt,
});
