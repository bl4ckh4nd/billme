import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { secrets } from '../secrets';
import type { TaxCertificateMetadata } from './types';

type CertificatePayload = { id: string; pem: string; password?: string; expiresAt: string; subject?: string };
type StoredCertificate = Omit<CertificatePayload, 'password'>;
type EncryptedCertificate = { version: 1; iv: string; tag: string; ciphertext: string };

const key = async (): Promise<Buffer> => {
  const current = await secrets.get('taxFiling.dataKey');
  if (current) return Buffer.from(current, 'base64');
  const created = randomBytes(32);
  await secrets.set('taxFiling.dataKey', created.toString('base64'));
  return created;
};
const passwordKey = (id: string): `taxFiling.certPassword.${string}` => `taxFiling.certPassword.${id}`;

const root = (userDataPath: string): string => path.join(userDataPath, 'tax-filing', 'certificates');
const file = (userDataPath: string, id: string): string => path.join(root(userDataPath), `${id}.json.enc`);

export const certificateFingerprint = (pem: string): string => createHash('sha256').update(pem).digest('hex');

export const saveCertificate = async (userDataPath: string, payload: CertificatePayload): Promise<TaxCertificateMetadata> => {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(payload.id)) throw new Error('INVALID_CERTIFICATE_ID');
  if (!payload.pem.trim() || !payload.expiresAt || Number.isNaN(Date.parse(payload.expiresAt))) throw new Error('INVALID_CERTIFICATE');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', await key(), iv);
  const { password, ...storedPayload } = payload;
  if (password) await secrets.set(passwordKey(payload.id), password);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(storedPayload), 'utf8'), cipher.final()]);
  const encrypted: EncryptedCertificate = { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  await mkdir(root(userDataPath), { recursive: true, mode: 0o700 });
  const target = file(userDataPath, payload.id);
  await writeFile(target, JSON.stringify(encrypted), { mode: 0o600 });
  await chmod(target, 0o600);
  return { id: payload.id, fingerprint: certificateFingerprint(payload.pem), expiresAt: payload.expiresAt, subject: payload.subject };
};

export const loadCertificate = async (userDataPath: string, id: string): Promise<CertificatePayload> => {
  const encrypted = JSON.parse(await readFile(file(userDataPath, id), 'utf8')) as EncryptedCertificate;
  const decipher = createDecipheriv('aes-256-gcm', await key(), Buffer.from(encrypted.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  const stored = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, 'base64')), decipher.final()]).toString('utf8')) as StoredCertificate;
  const password = await secrets.get(passwordKey(stored.id));
  return { ...stored, ...(password ? { password } : {}) };
};

export const listCertificates = async (userDataPath: string): Promise<TaxCertificateMetadata[]> => {
  let names: string[];
  try { names = (await readdir(root(userDataPath))).filter((name) => name.endsWith('.json.enc')); } catch { return []; }
  const result: TaxCertificateMetadata[] = [];
  for (const name of names) {
    try { const cert = await loadCertificate(userDataPath, name.slice(0, -9)); result.push({ id: cert.id, fingerprint: certificateFingerprint(cert.pem), expiresAt: cert.expiresAt, subject: cert.subject }); } catch { /* corrupted entries stay invisible */ }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
};

export const deleteCertificate = async (userDataPath: string, id: string): Promise<boolean> => {
  try { await rm(file(userDataPath, id)); await secrets.delete(passwordKey(id)); return true; } catch { return false; }
};
