import { describe, expect, it } from 'vitest';
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaxFilingAdapter, sourceHash } from './adapter';
import { discoverEricProvider } from './provider';
import type { TaxFilingSnapshot } from './types';

describe('desktop tax filing adapter', () => {
  it('fails closed when no official ERiC binary is installed', async () => {
    const resourcesPath = await mkdtemp(path.join(os.tmpdir(), 'billme-eric-'));
    const status = await discoverEricProvider({ resourcesPath });
    expect(status).toMatchObject({ available: false, provider: null, errorCode: 'PROVIDER_UNAVAILABLE' });
    await rm(resourcesPath, { recursive: true, force: true });
  });

  it('loads only an immutable record and blocks unavailable provider', async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'billme-tax-'));
    const base = {
      id: 'filing-1', kind: 'euer' as const, periodStart: '2025-01-01', periodEnd: '2025-12-31',
      payload: {
        amount: 12.34,
        filing: {
          kind: 'euer', taxYear: 2025,
          catalog: { id: 'anlage-euer-2025', version: 'BMF-2025-2025-08-29', sourceHash: 'b'.repeat(64), delivery: 'print-form-only', elsterReady: false },
          lineProvenance: [{ lineId: 'line-1', kennziffer: '111', providerPath: 'income', exportable: true }],
        },
      },
      status: 'frozen' as const, sourceHash: '',
    };
    const hash = sourceHash(base);
    const snapshot: TaxFilingSnapshot = { ...base, sourceHash: hash };
    const adapter = new TaxFilingAdapter({ userDataPath, loadFrozenSnapshot: async () => snapshot });
    await expect(adapter.validate({ id: snapshot.id, kind: snapshot.kind, periodStart: snapshot.periodStart, periodEnd: snapshot.periodEnd, sourceHash: hash, status: snapshot.status })).resolves.toMatchObject({
      status: 'failed',
      issues: [{ code: 'EUR_ELSTER_CATALOG_UNAVAILABLE' }],
    });
    await rm(userDataPath, { recursive: true, force: true });
  });

  it('does not expose a local submit path without a server grant broker', async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'billme-tax-'));
    const base = { id: 'filing-2', kind: 'e_bilanz' as const, periodStart: '2025-01-01', periodEnd: '2025-12-31', payload: { taxonomy: '6.9' }, status: 'approved' as const, sourceHash: '' };
    const snapshot: TaxFilingSnapshot = { ...base, sourceHash: sourceHash(base) };
    const adapter = new TaxFilingAdapter({ userDataPath, loadFrozenSnapshot: async () => snapshot });
    await expect(adapter.submit({ id: snapshot.id, kind: snapshot.kind, periodStart: snapshot.periodStart, periodEnd: snapshot.periodEnd, sourceHash: snapshot.sourceHash, status: snapshot.status })).resolves.toMatchObject({
      status: 'failed',
      issues: [{ code: 'E_BILANZ_TAXONOMY_CATALOG_UNAVAILABLE' }],
    });
    await rm(userDataPath, { recursive: true, force: true });
  });

  it('fails closed for filings outside the approved report taxonomy', async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'billme-tax-'));
    const base = { id: 'filing-3', kind: 'e_bilanz' as const, periodStart: '2025-01-01', periodEnd: '2025-12-31', payload: { taxonomyVersion: '6.8' }, status: 'frozen' as const, sourceHash: '' };
    const snapshot: TaxFilingSnapshot = { ...base, sourceHash: sourceHash(base) };
    const adapter = new TaxFilingAdapter({ userDataPath, loadFrozenSnapshot: async () => snapshot });
    const result = await adapter.validate({ id: snapshot.id, kind: snapshot.kind, periodStart: snapshot.periodStart, periodEnd: snapshot.periodEnd, sourceHash: snapshot.sourceHash, status: snapshot.status });
    expect(result.status).toBe('failed');
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'TAXONOMY_6_9_REQUIRED' })]));
    await rm(userDataPath, { recursive: true, force: true });
  });

  it('never invokes the native provider for a print-form-only EÜR catalog', async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'billme-tax-'));
    const providerPath = path.join(userDataPath, 'eric');
    const markerPath = path.join(userDataPath, 'provider-invoked');
    await writeFile(providerPath, `#!/bin/sh\ntouch ${JSON.stringify(markerPath)}\nprintf '%s' '{"ok":true}'\n`);
    await chmod(providerPath, 0o755);
    const base = {
      id: 'filing-provider-blocked', kind: 'euer' as const, periodStart: '2025-01-01', periodEnd: '2025-12-31',
      payload: {
        filing: {
          kind: 'euer', taxYear: 2025,
          catalog: { id: 'anlage-euer-2025', version: 'BMF-2025-2025-08-29', sourceHash: 'b'.repeat(64), delivery: 'print-form-only', elsterReady: false },
          lineProvenance: [{ lineId: 'line-1', kennziffer: '111', providerPath: 'income', exportable: true }],
        },
      },
      status: 'frozen' as const, sourceHash: '',
    };
    const snapshot: TaxFilingSnapshot = { ...base, sourceHash: sourceHash(base) };
    const adapter = new TaxFilingAdapter({ binaryPath: providerPath, userDataPath, loadFrozenSnapshot: async () => snapshot });
    const result = await adapter.export({ id: snapshot.id, kind: snapshot.kind, periodStart: snapshot.periodStart, periodEnd: snapshot.periodEnd, sourceHash: snapshot.sourceHash, status: snapshot.status });
    expect(result).toMatchObject({ status: 'failed', issues: [{ code: 'EUR_ELSTER_CATALOG_UNAVAILABLE' }] });
    await expect(access(markerPath)).rejects.toThrow();
    await rm(userDataPath, { recursive: true, force: true });
  });
});
