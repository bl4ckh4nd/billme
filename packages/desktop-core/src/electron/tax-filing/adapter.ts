import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deleteCertificate, listCertificates, loadCertificate, saveCertificate } from './certificateStore';
import { discoverEricProvider, runEricProvider, type EricProvider } from './provider';
import type { TaxCertificateMetadata, TaxFilingApprovalGrant, TaxFilingProviderStatus, TaxFilingRecordMetadata, TaxFilingResult, TaxFilingSnapshot } from './types';

export type TaxFilingAdapterOptions = {
  userDataPath: string;
  resourcesPath?: string;
  binaryPath?: string;
  /** Must resolve a server-issued/local immutable record; renderer payloads are never trusted. */
  loadFrozenSnapshot?: (record: TaxFilingRecordMetadata) => Promise<TaxFilingSnapshot | null>;
  listFrozenRecords?: () => Promise<TaxFilingRecordMetadata[]>;
  /** Server-only grant broker. It must be bound to tenant, filing, source hash and two actors. */
  requestApproval?: (input: { snapshot: TaxFilingSnapshot; operation: 'submit' }) => Promise<TaxFilingApprovalGrant | null>;
};

const canonicalSnapshot = (snapshot: TaxFilingSnapshot): Record<string, unknown> => {
  // Report snapshots use the same source form as server-mode reporting:
  // `{reportType,args,payload}`.  Keep this branch in the shared adapter so
  // desktop records and server records have one immutable identity.  The
  // fallback remains for provider-only snapshots that are not report-backed.
  if (
    snapshot.payload.reportType !== undefined
    && snapshot.payload.args !== undefined
    && snapshot.payload.payload !== undefined
  ) {
    return {
      reportType: snapshot.payload.reportType,
      args: snapshot.payload.args,
      payload: snapshot.payload.payload,
    };
  }
  return {
    kind: snapshot.kind,
    periodStart: snapshot.periodStart,
    periodEnd: snapshot.periodEnd,
    payload: snapshot.payload,
  };
};

/** The server's immutable source identity uses deterministic JSON; mirror it without trusting caller hash. */
export const sourceHash = (snapshot: TaxFilingSnapshot): string => createHash('sha256').update(stableStringify(canonicalSnapshot(snapshot))).digest('hex');
const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
};

const reportPayload = (snapshot: TaxFilingSnapshot): Record<string, unknown> => {
  const nested = snapshot.payload.payload;
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : snapshot.payload;
};

const validateSnapshot = (snapshot: TaxFilingSnapshot): TaxFilingResult['issues'] => {
  const issues: TaxFilingResult['issues'] = [];
  if (snapshot.kind === 'euer' && !snapshot.periodStart.startsWith('2025-')) {
    issues.push({ code: 'EÜR_2025_REQUIRED', message: 'EÜR filing is limited to the approved 2025 report snapshot.' });
  }
  if (snapshot.kind === 'euer') {
    const filing = reportPayload(snapshot).filing;
    if (!filing || typeof filing !== 'object') {
      issues.push({ code: 'EÜR_CATALOG_PROVENANCE_REQUIRED', message: 'EÜR requires catalog, Kennziffer and provider-path provenance.' });
    } else {
      const catalog = (filing as { catalog?: unknown }).catalog;
      const elsterReady = catalog && typeof catalog === 'object'
        && (catalog as { delivery?: unknown }).delivery === 'elster-ready'
        && (catalog as { elsterReady?: unknown }).elsterReady === true;
      if (!elsterReady) {
        issues.push({ code: 'EUR_ELSTER_CATALOG_UNAVAILABLE', message: 'EÜR can only be sent with the verified ELSTER catalog; the available catalog is print-form-only.' });
      }
    }
  }
  if (snapshot.kind === 'e_bilanz') {
    const taxonomy = snapshot.payload.taxonomyVersion ?? snapshot.payload.taxonomy;
    if (taxonomy !== '6.9') issues.push({ code: 'TAXONOMY_6_9_REQUIRED', message: 'E-Bilanz requires taxonomy 6.9.' });
    issues.push({ code: 'E_BILANZ_TAXONOMY_CATALOG_UNAVAILABLE', message: 'E-Bilanz submission is unavailable until a verified taxonomy 6.9 provider catalog is bundled.' });
  }
  if (snapshot.kind === 'unternehmensregister') {
    issues.push({ code: 'UNTERNEHMENSREGISTER_PROVIDER_CONTRACT_UNAVAILABLE', message: 'Unternehmensregister submission is unavailable until a verified provider contract is bundled.' });
  }
  return issues;
};

export class TaxFilingAdapter {
  private readonly options: TaxFilingAdapterOptions;
  constructor(options: TaxFilingAdapterOptions) { this.options = options; }

  providerStatus(): Promise<TaxFilingProviderStatus> { return discoverEricProvider({ resourcesPath: this.options.resourcesPath, binaryPath: this.options.binaryPath }); }
  certificates(): Promise<TaxCertificateMetadata[]> { return listCertificates(this.options.userDataPath); }
  records(): Promise<TaxFilingRecordMetadata[]> { return this.options.listFrozenRecords?.() ?? Promise.resolve([]); }
  installCertificate(payload: { id: string; pem: string; password?: string; expiresAt: string; subject?: string }): Promise<TaxCertificateMetadata> { return saveCertificate(this.options.userDataPath, payload); }
  removeCertificate(id: string): Promise<boolean> { return deleteCertificate(this.options.userDataPath, id); }

  private async provider(): Promise<EricProvider> {
    const status = await this.providerStatus();
    if (!status.available || status.provider !== 'eric' || !status.binaryPath) throw new Error('PROVIDER_UNAVAILABLE');
    return status as EricProvider;
  }

  private async snapshot(record: TaxFilingRecordMetadata): Promise<TaxFilingSnapshot> {
    if (!this.options.loadFrozenSnapshot) throw new Error('SERVER_SNAPSHOT_REQUIRED');
    const snapshot = await this.options.loadFrozenSnapshot(record);
    if (!snapshot || snapshot.id !== record.id || snapshot.sourceHash !== record.sourceHash || sourceHash(snapshot) !== record.sourceHash) throw new Error('FROZEN_SNAPSHOT_HASH_MISMATCH');
    return snapshot;
  }

  private async run(operation: 'validate' | 'export' | 'submit', record: TaxFilingRecordMetadata): Promise<TaxFilingResult> {
    const snapshot = await this.snapshot(record);
    const validationIssues = validateSnapshot(snapshot);
    if (validationIssues.length) return { operation, status: 'failed', sourceHash: snapshot.sourceHash, issues: validationIssues };
    let approval: TaxFilingApprovalGrant | null = null;
    if (operation === 'submit') {
      if (!this.options.requestApproval) throw new Error('SERVER_APPROVAL_REQUIRED');
      approval = await this.options.requestApproval({ snapshot, operation });
      if (!approval || approval.sourceHash !== snapshot.sourceHash || !approval.token || !approval.singleUse || Date.parse(approval.expiresAt) <= Date.now()) throw new Error('SERVER_APPROVAL_REQUIRED');
    }
    const provider = await this.provider();
    const certificate = undefined;
    const response = await runEricProvider(provider, { operation, snapshot, certificate, ...(approval ? { approvalToken: approval.token } : {}) }, 60_000);
    const issues = Array.isArray(response.issues) ? response.issues as TaxFilingResult['issues'] : [];
    const accepted = response.ok === true || response.status === 'accepted';
    if (!accepted) return { operation, status: 'failed', sourceHash: snapshot.sourceHash, issues: issues.length ? issues : [{ code: 'PROVIDER_REJECTED', message: 'The official provider did not accept the filing.' }] };
    const output = typeof response.outputBase64 === 'string' ? Buffer.from(response.outputBase64, 'base64') : undefined;
    let outputPath: string | undefined;
    if (output) {
      const directory = path.join(this.options.userDataPath, 'tax-filing', 'exports');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      outputPath = path.join(directory, `${snapshot.id}-${snapshot.sourceHash}.xml`);
      await writeFile(outputPath, output, { mode: 0o600 });
    }
    return { operation, status: operation === 'validate' ? 'validated' : operation === 'export' ? 'exported' : 'submitted', sourceHash: snapshot.sourceHash, outputPath, issues };
  }
  validate(record: TaxFilingRecordMetadata): Promise<TaxFilingResult> { return this.run('validate', record); }
  export(record: TaxFilingRecordMetadata): Promise<TaxFilingResult> { return this.run('export', record); }
  submit(record: TaxFilingRecordMetadata): Promise<TaxFilingResult> { return this.run('submit', record); }
}
