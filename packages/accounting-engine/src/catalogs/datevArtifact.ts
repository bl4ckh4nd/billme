import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export type DatevArtifactFormat = 'sqlite' | 'csv' | 'json';

export type DatevLicensedArtifactManifest = {
  id: string;
  title: string;
  vendor: 'DATEV';
  format: DatevArtifactFormat;
  version: string;
  validFrom: string;
  validTo: string;
  sha256: string;
  licenseNotice: string;
  privateArtifact: true;
};

export type DatevLicensedArtifact = {
  manifest: DatevLicensedArtifactManifest;
  bytes: Uint8Array;
  contentSha256: string;
  artifactPath: string;
};

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export const validateDatevLicensedManifest = (manifest: DatevLicensedArtifactManifest): void => {
  const date = /^\d{4}-\d{2}-\d{2}$/;
  if (!manifest.id.trim() || !manifest.title.trim() || manifest.vendor !== 'DATEV') throw new Error('DATEV_ARTIFACT_MANIFEST_INVALID');
  if (!['sqlite', 'csv', 'json'].includes(manifest.format) || !manifest.version.trim()) throw new Error('DATEV_ARTIFACT_MANIFEST_INVALID');
  if (!date.test(manifest.validFrom) || !date.test(manifest.validTo) || manifest.validFrom > manifest.validTo) throw new Error('DATEV_ARTIFACT_VALIDITY_INVALID');
  if (!/^[a-f0-9]{64}$/i.test(manifest.sha256) || manifest.privateArtifact !== true) throw new Error('DATEV_ARTIFACT_MANIFEST_INVALID');
  if (!manifest.licenseNotice.trim()) throw new Error('DATEV_ARTIFACT_LICENSE_NOTICE_REQUIRED');
};

export const loadPrivateDatevArtifact = async (input: {
  manifestPath?: string;
  artifactPath?: string;
}): Promise<DatevLicensedArtifact> => {
  if (!input.manifestPath || !input.artifactPath) throw new Error('DATEV_PRIVATE_ARTIFACT_UNAVAILABLE');

  let manifest: DatevLicensedArtifactManifest;
  let bytes: Uint8Array;
  try {
    manifest = JSON.parse(await readFile(input.manifestPath, 'utf8')) as DatevLicensedArtifactManifest;
    bytes = await readFile(input.artifactPath);
  } catch {
    throw new Error('DATEV_PRIVATE_ARTIFACT_UNAVAILABLE');
  }

  validateDatevLicensedManifest(manifest);
  const contentSha256 = sha256(bytes);
  if (contentSha256 !== manifest.sha256.toLowerCase()) throw new Error('DATEV_PRIVATE_ARTIFACT_HASH_MISMATCH');
  return { manifest, bytes, contentSha256, artifactPath: input.artifactPath };
};

export const importDatevArtifact = async <T>(input: {
  manifestPath?: string;
  artifactPath?: string;
  parse: (artifact: DatevLicensedArtifact) => T;
}): Promise<T> => input.parse(await loadPrivateDatevArtifact(input));

export const loadDatevLicensedArtifact = loadPrivateDatevArtifact;

