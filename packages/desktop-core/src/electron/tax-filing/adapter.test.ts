import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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
    const base = { id: 'filing-1', kind: 'euer' as const, periodStart: '2025-01-01', periodEnd: '2025-12-31', payload: { amount: 12.34 }, status: 'frozen' as const, sourceHash: '' };
    const hash = sourceHash(base);
    const snapshot: TaxFilingSnapshot = { ...base, sourceHash: hash };
    const adapter = new TaxFilingAdapter({ userDataPath, loadFrozenSnapshot: async () => snapshot });
    await expect(adapter.validate({ id: snapshot.id, kind: snapshot.kind, periodStart: snapshot.periodStart, periodEnd: snapshot.periodEnd, sourceHash: hash, status: snapshot.status })).rejects.toThrow('PROVIDER_UNAVAILABLE');
    await rm(userDataPath, { recursive: true, force: true });
  });

  it('does not expose a local submit path without a server grant broker', async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'billme-tax-'));
    const base = { id: 'filing-2', kind: 'e_bilanz' as const, periodStart: '2025-01-01', periodEnd: '2025-12-31', payload: { taxonomy: '6.9' }, status: 'approved' as const, sourceHash: '' };
    const snapshot: TaxFilingSnapshot = { ...base, sourceHash: sourceHash(base) };
    const adapter = new TaxFilingAdapter({ userDataPath, loadFrozenSnapshot: async () => snapshot });
    await expect(adapter.submit({ id: snapshot.id, kind: snapshot.kind, periodStart: snapshot.periodStart, periodEnd: snapshot.periodEnd, sourceHash: snapshot.sourceHash, status: snapshot.status })).rejects.toThrow('SERVER_APPROVAL_REQUIRED');
    await rm(userDataPath, { recursive: true, force: true });
  });

  it('fails closed for filings outside the approved report taxonomy', async () => {
    const userDataPath = await mkdtemp(path.join(os.tmpdir(), 'billme-tax-'));
    const base = { id: 'filing-3', kind: 'e_bilanz' as const, periodStart: '2025-01-01', periodEnd: '2025-12-31', payload: { taxonomyVersion: '6.8' }, status: 'frozen' as const, sourceHash: '' };
    const snapshot: TaxFilingSnapshot = { ...base, sourceHash: sourceHash(base) };
    const adapter = new TaxFilingAdapter({ userDataPath, loadFrozenSnapshot: async () => snapshot });
    await expect(adapter.validate({ id: snapshot.id, kind: snapshot.kind, periodStart: snapshot.periodStart, periodEnd: snapshot.periodEnd, sourceHash: snapshot.sourceHash, status: snapshot.status })).resolves.toMatchObject({ status: 'failed', issues: [{ code: 'TAXONOMY_6_9_REQUIRED' }] });
    await rm(userDataPath, { recursive: true, force: true });
  });
});
