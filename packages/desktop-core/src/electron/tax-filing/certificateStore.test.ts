import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const values = new Map<string, string>();
vi.mock('../secrets', () => ({
  secrets: {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => { values.set(key, value); },
    delete: async (key: string) => values.delete(key),
  },
}));

import { loadCertificate, saveCertificate } from './certificateStore';

describe('encrypted local tax certificates', () => {
  it('keeps the PEM encrypted on disk and the password in keytar-backed secrets', async () => {
    values.clear();
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'billme-cert-'));
    const pem = '-----BEGIN CERTIFICATE-----\nprivate-test-material\n-----END CERTIFICATE-----';
    await saveCertificate(userDataPath, { id: 'cert-1', pem, password: 'secret-password', expiresAt: '2030-01-01T00:00:00.000Z' });
    const raw = await readFile(path.join(userDataPath, 'tax-filing', 'certificates', 'cert-1.json.enc'), 'utf8');
    expect(raw).not.toContain(pem);
    expect(raw).not.toContain('secret-password');
    await expect(loadCertificate(userDataPath, 'cert-1')).resolves.toMatchObject({ pem, password: 'secret-password' });
    expect(values.get('taxFiling.certPassword.cert-1')).toBe('secret-password');
    await rm(userDataPath, { recursive: true, force: true });
  });
});
